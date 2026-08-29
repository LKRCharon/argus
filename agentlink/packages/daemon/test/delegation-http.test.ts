import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DelegationConfigStore,
  DelegationJobJournal,
  DelegationRunner,
  DelegationService,
  createDelegationRequestHandler,
  generatePrincipalToken,
  type DelegationConfig,
  type DelegationRunCallbacks,
  type DelegationRunnerProject,
  type DelegationRunnerRequest,
  type DelegationRunResult,
} from "../src/delegation";

const roots: string[] = [];
const publicPath = `/d/${"a".repeat(64)}`;

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("MarkSec delegation HTTP gateway", () => {
  test("keeps the secret route and bearer scope fail-closed", async () => {
    const fixture = createFixture();
    const handler = createDelegationRequestHandler({ service: fixture.service });
    const body = validRequest();

    expect((await handler(publicRequest(`${publicPath}/jobs`, "wrong-token", "request-1", body))).status).toBe(404);
    expect((await handler(publicRequest(`/d/${"b".repeat(64)}/jobs`, fixture.token, "request-1", body))).status).toBe(404);

    const commandInjection = await handler(publicRequest(`${publicPath}/jobs`, fixture.token, "request-command", {
      ...body,
      command: "rm -rf /home/ubuntu/proj/another-repo",
    }));
    expect(commandInjection.status).toBe(400);
    expect(fixture.runner.requests).toHaveLength(0);

    const domainEscape = await handler(publicRequest(`${publicPath}/jobs`, fixture.token, "request-domain", {
      ...body,
      domain: "other.example",
    }));
    expect(domainEscape.status).toBe(403);
    expect(fixture.runner.requests).toHaveLength(0);
    fixture.service.stop();
  });

  test("runs one idempotent snapshot job and returns a hash-checked patch", async () => {
    const fixture = createFixture();
    const handler = createDelegationRequestHandler({ service: fixture.service });
    const request = validRequest();
    const submitted = await handler(publicRequest(`${publicPath}/jobs`, fixture.token, "request-2", request));
    expect(submitted.status).toBe(202);
    const first = await submitted.json() as { job: { id: string }; replayed: boolean };
    expect(first.replayed).toBe(false);

    await waitFor(() => fixture.service.journal.get(first.job.id)?.status === "completed");
    expect(fixture.runner.requests).toHaveLength(1);

    const replay = await handler(publicRequest(`${publicPath}/jobs`, fixture.token, "request-2", request));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, job: { id: first.job.id } });
    expect(fixture.runner.requests).toHaveLength(1);

    const conflict = await handler(publicRequest(`${publicPath}/jobs`, fixture.token, "request-2", {
      ...request,
      goal: "different request",
    }));
    expect(conflict.status).toBe(409);

    const detail = await handler(new Request(`http://localhost${publicPath}/jobs/${first.job.id}`, {
      headers: { authorization: `Bearer ${fixture.token}` },
    }));
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      job: {
        id: first.job.id,
        status: "completed",
        report: {
          outcome: "success",
          changedFileCount: 1,
          acceptance: [{ status: "passed" }],
        },
      },
    });

    const patch = await handler(new Request(`http://localhost${publicPath}/jobs/${first.job.id}/patch`, {
      headers: { authorization: `Bearer ${fixture.token}` },
    }));
    expect(patch.status).toBe(200);
    expect(await patch.text()).toBe(fixture.runner.patch);
    expect(patch.headers.get("etag")).toBe(`"${fixture.runner.patchSha256}"`);
    fixture.service.stop();
  });

  test("persists a cancellation tombstone before aborting the worker", async () => {
    const fixture = createFixture({ blockUntilAbort: true });
    const handler = createDelegationRequestHandler({ service: fixture.service });
    const submitted = await handler(publicRequest(`${publicPath}/jobs`, fixture.token, "request-cancel", validRequest()));
    const payload = await submitted.json() as { job: { id: string } };
    await waitFor(() => fixture.service.journal.get(payload.job.id)?.status === "running");

    const cancelled = await handler(new Request(`http://localhost${publicPath}/jobs/${payload.job.id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${fixture.token}` },
    }));
    expect(cancelled.status).toBe(202);
    expect(await cancelled.json()).toMatchObject({ job: { status: "cancelled" } });
    await waitFor(() => fixture.runner.aborted);
    expect(fixture.service.journal.get(payload.job.id)?.status).toBe("cancelled");
    fixture.service.stop();
  });

  test("requires a same-origin owner marker and reveals a new token only once", async () => {
    const fixture = createFixture();
    const handler = createDelegationRequestHandler({ service: fixture.service });
    const tokenRequest = {
      label: "review-agent",
      projectIds: ["marksec"],
      modes: ["inspect"],
      expiresInDays: 30,
    };
    const csrf = await handler(new Request("http://localhost/api/delegation/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tokenRequest),
    }));
    expect(csrf.status).toBe(403);

    const crossOrigin = await handler(new Request("http://localhost/api/delegation/tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-argus-owner": "1",
        origin: "https://evil.example",
      },
      body: JSON.stringify(tokenRequest),
    }));
    expect(crossOrigin.status).toBe(403);

    const created = await handler(new Request("http://localhost/api/delegation/tokens", {
      method: "POST",
      headers: { "content-type": "application/json", "x-argus-owner": "1" },
      body: JSON.stringify(tokenRequest),
    }));
    expect(created.status).toBe(201);
    const payload = await created.json() as { token: string; principal: { id: string } };
    expect(Buffer.from(payload.token, "base64url")).toHaveLength(32);
    expect(readFileSync(fixture.configFile, "utf8")).not.toContain(payload.token);

    const revoked = await handler(new Request(
      `http://localhost/api/delegation/tokens/${payload.principal.id}/revoke`,
      { method: "POST", headers: { "x-argus-owner": "1" } },
    ));
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ principal: { revokedAt: expect.any(String) } });
    fixture.service.stop();
  });
});

class FakeRunner {
  readonly requests: DelegationRunnerRequest[] = [];
  readonly patch = "diff --git a/README.md b/README.md\n+bounded change\n";
  readonly patchSha256 = createHash("sha256").update(this.patch).digest("hex");
  aborted = false;

  constructor(private readonly blockUntilAbort: boolean) {}

  readiness(): { ready: true } {
    return { ready: true };
  }

  async run(
    project: DelegationRunnerProject,
    request: DelegationRunnerRequest,
    callbacks: DelegationRunCallbacks = {},
  ): Promise<DelegationRunResult> {
    this.requests.push(request);
    callbacks.onProgress?.("running", 50, "fake runner");
    if (this.blockUntilAbort) {
      await new Promise<void>((_resolve, reject) => {
        const abort = () => {
          this.aborted = true;
          reject(new Error("aborted"));
        };
        callbacks.signal?.addEventListener("abort", abort, { once: true });
        if (callbacks.signal?.aborted) abort();
      });
    }
    const artifact = join(project.workRoot, ".artifacts", request.jobId);
    mkdirSync(artifact, { recursive: true });
    writeFileSync(join(artifact, "changes.patch"), this.patch);
    return {
      outcome: "completed",
      summary: "bounded change complete",
      baseRevision: "a".repeat(40),
      finalRevision: "b".repeat(40),
      changedFiles: ["README.md"],
      acceptance: request.acceptance.map((criterion) => ({
        criterion,
        status: "passed" as const,
        evidence: "focused check passed",
      })),
      checks: [{ name: "focused", status: "passed", summary: "ok", exitCode: 0, durationMs: 1 }],
      risks: [],
      nextSteps: [],
      patchSha256: this.patchSha256,
      patchBytes: Buffer.byteLength(this.patch),
      reportSha256: "c".repeat(64),
      sourceSnapshotSha256: "d".repeat(64),
      commandCount: 1,
      publishApprovalRequired: false,
    };
  }
}

function createFixture(options: { blockUntilAbort?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "argus-delegation-http-"));
  roots.push(root);
  const issued = generatePrincipalToken();
  const token = issued.takePlaintext();
  const config: DelegationConfig = {
    version: 1,
    projects: [{
      id: "marksec",
      displayName: "MarkSec",
      sourceRoot: join(root, "source", "marksec"),
      workRoot: join(root, "work", "marksec"),
      defaultRef: "current",
      allowedDomains: ["marksec.limen.codes"],
      allowedModes: ["inspect", "change"],
      codexExecutable: "/opt/argus/bin/codex",
      maxRuntimeMs: 30 * 60_000,
      maxChangedFiles: 100,
      maxDiffBytes: 8 * 1024 * 1024,
      copyExcludes: ["node_modules"],
      verificationCommands: [],
    }],
    principals: [{
      id: "agent-alice",
      label: "Alice",
      tokenHash: issued.tokenHash,
      projectIds: ["marksec"],
      modes: ["inspect", "change"],
      expiresAt: "2040-01-01T00:00:00.000Z",
    }],
  };
  const configFile = join(root, "state", "config.json");
  const configStore = new DelegationConfigStore(configFile);
  configStore.save(config);
  const runner = new FakeRunner(options.blockUntilAbort ?? false);
  const service = new DelegationService({
    configStore,
    journal: new DelegationJobJournal(join(root, "state", "jobs.json")),
    runner: runner as unknown as DelegationRunner,
    publicPath,
  });
  service.start();
  return { root, token, configFile, runner, service };
}

function validRequest() {
  return {
    projectId: "marksec",
    mode: "change",
    goal: "Apply one bounded change",
    acceptance: ["Focused check passes"],
    baseRevision: "current",
    domain: "marksec.limen.codes",
  };
}

function publicRequest(path: string, token: string, idempotencyKey: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
