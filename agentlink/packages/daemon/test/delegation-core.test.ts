import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DelegationAuthorizationError,
  DelegationConfigSchema,
  DelegationConfigStore,
  DelegationIdempotencyConflictError,
  DelegationJobJournal,
  DelegationJobRequestSchema,
  DelegationRequestLimiter,
  authenticateBearer,
  authorizeDelegationRequest,
  generatePrincipalToken,
  type DelegationConfig,
  type DelegationJobRequest,
} from "../src/delegation";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const validRequest: DelegationJobRequest = {
  projectId: "marksec",
  mode: "change",
  goal: "Fix the bounded result renderer",
  acceptance: ["Focused checks pass", "No public API changes"],
  baseRevision: "main@abc123",
  domain: "marksec.limen.codes",
};

describe("delegation request schema", () => {
  test("accepts the bounded shape and rejects commands, unsafe ids, and malformed fields", () => {
    expect(DelegationJobRequestSchema.parse(validRequest)).toEqual(validRequest);
    expect(DelegationJobRequestSchema.safeParse({ ...validRequest, command: "rm -rf ." }).success).toBe(false);
    expect(DelegationJobRequestSchema.safeParse({ ...validRequest, projectId: "../marksec" }).success).toBe(false);
    expect(DelegationJobRequestSchema.safeParse({ ...validRequest, goal: " \n " }).success).toBe(false);
    expect(DelegationJobRequestSchema.safeParse({ ...validRequest, goal: "x".repeat(12_001) }).success).toBe(false);
    expect(DelegationJobRequestSchema.safeParse({
      ...validRequest,
      acceptance: Array.from({ length: 13 }, (_, index) => `criterion-${index}`),
    }).success).toBe(false);
    expect(DelegationJobRequestSchema.safeParse({
      ...validRequest,
      acceptance: ["x".repeat(513)],
    }).success).toBe(false);
    expect(DelegationJobRequestSchema.safeParse({ ...validRequest, baseRevision: "../main" }).success).toBe(false);
    expect(DelegationJobRequestSchema.safeParse({
      ...validRequest,
      domain: "https://marksec.limen.codes/path",
    }).success).toBe(false);
  });
});

describe("delegation token authentication", () => {
  test("issues one 32-byte token, stores only its digest, and fails closed for revoked or expired principals", () => {
    const issued = generatePrincipalToken();
    const token = issued.takePlaintext();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(issued.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(issued)).not.toContain(token);
    expect(() => issued.takePlaintext()).toThrow("no longer available");

    const principal = DelegationConfigSchema.parse(configFixture("/srv/argus-test", issued.tokenHash)).principals[0]!;
    expect(authenticateBearer(`Bearer ${token}`, [principal], Date.parse("2030-01-01T00:00:00Z"))?.id)
      .toBe("agent-alice");
    expect(authenticateBearer("Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", [principal]))
      .toBeUndefined();
    expect(authenticateBearer(`Bearer ${token}`, [{
      ...principal,
      revokedAt: "2029-01-01T00:00:00.000Z",
    }], Date.parse("2030-01-01T00:00:00Z"))).toBeUndefined();
    expect(authenticateBearer(`Bearer ${token}`, [{
      ...principal,
      expiresAt: "2030-01-01T00:00:00.000Z",
    }], Date.parse("2030-01-01T00:00:00Z"))).toBeUndefined();
  });

  test("binds project, mode, and domain authorization to fixed policy", () => {
    const issued = generatePrincipalToken();
    const config = DelegationConfigSchema.parse(configFixture("/srv/argus-policy", issued.tokenHash));
    const principal = config.principals[0]!;
    expect(authorizeDelegationRequest(config, principal, validRequest).id).toBe("marksec");
    expect(() => authorizeDelegationRequest(config, principal, {
      ...validRequest,
      domain: "other.example",
    })).toThrow(DelegationAuthorizationError);
    expect(() => authorizeDelegationRequest(config, principal, {
      ...validRequest,
      mode: "publish",
    })).toThrow(DelegationAuthorizationError);
  });
});

describe("delegation config storage", () => {
  test("writes 0600 atomically, recovers the committed file, and rejects config inside a project root", () => {
    const root = temporaryRoot("argus-delegation-config-");
    const issued = generatePrincipalToken();
    const config = DelegationConfigSchema.parse(configFixture(root, issued.tokenHash));
    const file = join(root, "private-state", "config.json");
    const store = new DelegationConfigStore(file);
    expect(store.save(config)).toEqual(config);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

    const orphan = `${file}.interrupted.tmp`;
    writeFileSync(orphan, "{broken", { mode: 0o600 });
    expect(new DelegationConfigStore(file).load()).toEqual(config);
    expect(JSON.stringify(new DelegationConfigStore(file).load())).not.toContain(issued.takePlaintext());

    if (process.platform !== "win32") {
      chmodSync(file, 0o644);
      expect(() => new DelegationConfigStore(file).load()).toThrow("expected 0600");
      chmodSync(file, 0o600);
    }

    const projectConfigPath = join(config.projects[0]!.sourceRoot, "delegation.json");
    expect(() => new DelegationConfigStore(projectConfigPath).save(config)).toThrow("outside project roots");
  });
});

describe("delegation job journal", () => {
  test("recovers bounded records and rejects an idempotency key reused with a different digest", () => {
    const root = temporaryRoot("argus-delegation-journal-");
    const file = join(root, "private-state", "jobs.json");
    let now = Date.parse("2030-01-01T00:00:00.000Z");
    const journal = new DelegationJobJournal(file, () => now);
    const first = journal.begin({
      principalId: "agent-alice",
      idempotencyKey: "request-1",
      request: validRequest,
      jobId: "job-1",
    });
    expect(first.created).toBe(true);
    expect(first.record).toMatchObject({
      principalId: "agent-alice",
      projectId: "marksec",
      phase: "accepted",
      status: "queued",
      progress: { percent: 0 },
      report: null,
    });

    const replay = journal.begin({
      principalId: "agent-alice",
      idempotencyKey: "request-1",
      request: validRequest,
    });
    expect(replay.created).toBe(false);
    expect(replay.record.jobId).toBe("job-1");
    expect(() => journal.begin({
      principalId: "agent-alice",
      idempotencyKey: "request-1",
      request: { ...validRequest, goal: "A different request" },
    })).toThrow(DelegationIdempotencyConflictError);

    now += 1_000;
    journal.update("job-1", {
      status: "completed",
      progress: { percent: 100, step: "complete" },
      report: { outcome: "success", summary: "Focused verification passed" },
    });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

    const recovered = new DelegationJobJournal(file, () => now);
    expect(recovered.get("job-1")).toMatchObject({
      phase: "finished",
      status: "completed",
      finishedAt: new Date(now).toISOString(),
      report: { outcome: "success" },
    });
    expect(() => recovered.begin({
      principalId: "agent-alice",
      idempotencyKey: "request-1",
      request: { ...validRequest, acceptance: ["Different"] },
    })).toThrow(DelegationIdempotencyConflictError);
  });
});

describe("delegation admission limits", () => {
  test("enforces per-principal sliding-window and active limits with an injected clock", () => {
    let now = 100;
    const limiter = new DelegationRequestLimiter({
      windowMs: 1_000,
      maxRequests: 2,
      maxActive: 1,
      now: () => now,
    });

    const first = limiter.tryStart("agent-alice");
    expect(first.allowed).toBe(true);
    expect(limiter.tryStart("agent-alice")).toMatchObject({
      allowed: false,
      reason: "max-active",
      active: 1,
    });
    if (!first.allowed) throw new Error("expected first request to be admitted");
    first.permit.release();
    first.permit.release();

    const second = limiter.tryStart("agent-alice");
    expect(second.allowed).toBe(true);
    if (!second.allowed) throw new Error("expected second request to be admitted");
    second.permit.release();
    expect(limiter.tryStart("agent-alice")).toMatchObject({
      allowed: false,
      reason: "rate-limit",
      retryAfterMs: 1_000,
    });
    expect(limiter.tryStart("agent-bob").allowed).toBe(true);

    now = 1_100;
    expect(limiter.tryStart("agent-alice").allowed).toBe(true);
    expect(limiter.snapshot("agent-alice")).toEqual({ active: 1, requestsInWindow: 1 });
  });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function configFixture(root: string, tokenHash: string): DelegationConfig {
  return {
    version: 1,
    projects: [{
      id: "marksec",
      displayName: "MarkSec",
      sourceRoot: join(root, "source", "marksec"),
      workRoot: join(root, "work", "marksec"),
      defaultRef: "main",
      allowedDomains: ["marksec.limen.codes"],
      allowedModes: ["inspect", "change"],
      codexExecutable: "/usr/bin/codex",
      maxRuntimeMs: 30 * 60_000,
      maxChangedFiles: 200,
      maxDiffBytes: 8 * 1024 * 1024,
      copyExcludes: [".git", "node_modules", "dist"],
      verificationCommands: [{
        id: "focused-test",
        label: "Focused test",
        argv: ["/usr/bin/bun", "test", "test/marksec.test.ts"],
        timeoutMs: 5 * 60_000,
      }],
    }],
    principals: [{
      id: "agent-alice",
      label: "Alice's Codex",
      tokenHash,
      projectIds: ["marksec"],
      modes: ["inspect", "change"],
      expiresAt: "2040-01-01T00:00:00.000Z",
    }],
  };
}
