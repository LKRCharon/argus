import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boundDifferences,
  buildFunctionalManifest,
  buildGitFunctionalManifest,
  inspectGitArtifact,
  parseFunctionalManifest,
  preflightFunctionalReleases,
  verifyFunctionalManifest,
  writeFunctionalManifest,
} from "./release-manifest";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function write(root: string, path: string, content: string): void {
  const file = join(root, ...path.split("/"));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

function minimalRelease(root: string, source: string): void {
  write(root, "package.json", "{\"name\":\"fixture\"}\n");
  write(root, "packages/daemon/src/feature.ts", source);
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
}

function committedGitArtifact(source = "export const feature = 1;\n"): string {
  const root = tempRoot("argus-manifest-git-");
  minimalRelease(root, source);
  git(root, "init");
  git(root, "add", "package.json", "packages/daemon/src/feature.ts");
  git(root, "-c", "user.name=manifest-test", "-c", "user.email=manifest@example.invalid", "commit", "-m", "fixture");
  return root;
}

describe("functional release manifest", () => {
  test("hashes only the explicit functional allowlist and never reports source contents", () => {
    const root = tempRoot("argus-manifest-tree-");
    minimalRelease(root, "export const feature = 1;\n");
    write(root, "state/mesh.json", "{\"token\":\"PRIVATE_CONFIG_SENTINEL\"}\n");
    write(root, "node_modules/private/index.js", "PRIVATE_DEPENDENCY_SENTINEL\n");
    write(root, "packages/app/dist/index.js", "PRIVATE_BUILD_SENTINEL\n");
    write(root, "scripts/.env.local", "PRIVATE_ENV_SENTINEL\n");
    write(root, "deploy/private.pem", "PRIVATE_KEY_SENTINEL\n");
    write(root, "deploy/worker.log", "PRIVATE_LOG_SENTINEL\n");
    write(root, "packages/daemon/src/node_modules/private.js", "PRIVATE_NESTED_DEPENDENCY\n");
    const manifest = buildFunctionalManifest(root, "a".repeat(40));
    writeFunctionalManifest(root, manifest);

    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      "package.json",
      "packages/daemon/src/feature.ts",
    ]);
    expect(verifyFunctionalManifest(root, manifest)).toEqual([]);

    if (process.platform !== "win32") {
      chmodSync(join(root, "packages/daemon/src/feature.ts"), 0o755);
      expect(verifyFunctionalManifest(root, manifest)).toEqual([
        expect.objectContaining({
          path: "packages/daemon/src/feature.ts",
          status: "modified",
          expected: expect.objectContaining({ executable: false }),
          actual: expect.objectContaining({ executable: true }),
        }),
      ]);
      chmodSync(join(root, "packages/daemon/src/feature.ts"), 0o644);
    }

    write(root, "packages/daemon/src/feature.ts", "export const secret = 'SOURCE_CONTENT_SENTINEL';\n");
    write(root, "packages/daemon/src/untracked-feature.ts", "export const extra = true;\n");
    const differences = verifyFunctionalManifest(root, manifest);
    expect(differences.map((difference) => [difference.path, difference.status])).toEqual([
      ["packages/daemon/src/feature.ts", "modified"],
      ["packages/daemon/src/untracked-feature.ts", "added"],
    ]);
    const report = JSON.stringify(differences);
    expect(report).not.toContain("SOURCE_CONTENT_SENTINEL");
    expect(report).not.toContain("PRIVATE_CONFIG_SENTINEL");
  });

  test("rejects unknown manifest fields, unsorted paths, and out-of-scope paths", () => {
    const entry = { path: "package.json", size: 2, sha256: "a".repeat(64), executable: false };
    const base = {
      version: 1,
      scope: "agentlink-functional-runtime",
      algorithm: "sha256",
      gitCommit: "a".repeat(40),
      entries: [entry],
    };
    expect(parseFunctionalManifest(base).entries).toEqual([entry]);
    expect(() => parseFunctionalManifest({ ...base, privateConfig: true })).toThrow("invalid");
    expect(() => parseFunctionalManifest({
      ...base,
      entries: [{ ...entry, path: "state/mesh.json" }],
    })).toThrow("paths are invalid");
    expect(() => parseFunctionalManifest({
      ...base,
      entries: [entry, { ...entry, path: "bun.lock" }],
    })).toThrow("paths are invalid");
  });

  test("detects modified and untracked functional files against Git, including ignored files", () => {
    const root = committedGitArtifact();
    expect(inspectGitArtifact(root).differences).toEqual([]);
    write(root, ".gitignore", "packages/daemon/src/ignored.ts\n");
    write(root, "packages/daemon/src/feature.ts", "export const feature = 2;\n");
    write(root, "packages/daemon/src/ignored.ts", "export const ignoredButFunctional = true;\n");
    expect(inspectGitArtifact(root).differences).toEqual([
      { path: "packages/daemon/src/feature.ts", status: "modified" },
      { path: "packages/daemon/src/ignored.ts", status: "added" },
    ]);
    expect(() => buildGitFunctionalManifest(root)).toThrow("do not match the Git artifact");
  });

  test("detects tracked drift when the functional root is below the Git top level", () => {
    const repository = tempRoot("argus-manifest-nested-git-");
    const root = join(repository, "agentlink");
    minimalRelease(root, "export const feature = 1;\n");
    git(repository, "init");
    git(repository, "add", "agentlink/package.json", "agentlink/packages/daemon/src/feature.ts");
    git(repository, "-c", "user.name=manifest-test", "-c", "user.email=manifest@example.invalid", "commit", "-m", "fixture");
    expect(inspectGitArtifact(root).differences).toEqual([]);

    write(root, "packages/daemon/src/feature.ts", "export const feature = 2;\n");
    expect(inspectGitArtifact(root).differences).toEqual([
      { path: "packages/daemon/src/feature.ts", status: "modified" },
    ]);
  });

  test("accepts planned release changes but fails closed on active or candidate tree drift", () => {
    const gitRoot = committedGitArtifact("export const feature = 2;\n");
    const candidate = tempRoot("argus-manifest-candidate-");
    minimalRelease(candidate, "export const feature = 2;\n");
    const candidateManifest = buildGitFunctionalManifest(gitRoot);
    writeFunctionalManifest(candidate, candidateManifest);

    const active = tempRoot("argus-manifest-active-");
    minimalRelease(active, "export const feature = 1;\n");
    writeFunctionalManifest(active, buildFunctionalManifest(active, "b".repeat(40)));

    const clean = preflightFunctionalReleases({ gitRoot, candidateRoot: candidate, activeRoot: active });
    expect(clean).toMatchObject({
      ok: true,
      gitArtifact: { clean: true },
      candidate: { treeMatchesManifest: true, matchesGitArtifact: true },
      active: { treeMatchesManifest: true },
      plannedChanges: { total: 1, items: [{ path: "packages/daemon/src/feature.ts", status: "modified" }] },
    });

    write(active, "packages/daemon/src/live-only.ts", "export const value = 'LIVE_PATCH_SENTINEL';\n");
    const activeDrift = preflightFunctionalReleases({ gitRoot, candidateRoot: candidate, activeRoot: active });
    expect(activeDrift).toMatchObject({
      ok: false,
      active: {
        treeMatchesManifest: false,
        differences: { items: [{ path: "packages/daemon/src/live-only.ts", status: "added" }] },
      },
    });
    expect(JSON.stringify(activeDrift)).not.toContain("LIVE_PATCH_SENTINEL");

    write(candidate, "packages/daemon/src/candidate-only.ts", "export const candidateOnly = true;\n");
    const candidateDrift = preflightFunctionalReleases({ gitRoot, candidateRoot: candidate, activeRoot: active });
    expect(candidateDrift).toMatchObject({
      ok: false,
      candidate: {
        treeMatchesManifest: false,
        differences: { items: [{ path: "packages/daemon/src/candidate-only.ts", status: "added" }] },
      },
    });
  });

  test("treats a missing active manifest as a blocker and bounds every diff list", () => {
    const gitRoot = committedGitArtifact();
    const candidate = tempRoot("argus-manifest-candidate-missing-");
    minimalRelease(candidate, "export const feature = 1;\n");
    writeFunctionalManifest(candidate, buildGitFunctionalManifest(gitRoot));
    const active = tempRoot("argus-manifest-active-missing-");
    minimalRelease(active, "export const feature = 1;\n");

    const report = preflightFunctionalReleases({ gitRoot, candidateRoot: candidate, activeRoot: active });
    expect(report).toMatchObject({
      ok: false,
      active: { manifestValid: false, error: "manifest-missing" },
    });
    expect(boundDifferences(Array.from({ length: 80 }, (_, index) => index))).toMatchObject({
      total: 80,
      truncated: true,
      items: Array.from({ length: 64 }, (_, index) => index),
    });
  });
});
