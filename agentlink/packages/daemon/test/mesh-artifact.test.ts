import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  meshArtifactSha256,
  type MeshArtifactFile,
  type MeshBaseArtifactManifest,
} from "@agentlink/wire";
import {
  MeshArtifactStore,
  validateBaseArtifactManifest,
  validateResultArtifactManifest,
} from "../src/mesh/artifact-store";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "argus-artifact-"));
  roots.push(root);
  return root;
}

function artifactFile(path: string, content: Buffer | string, mode = 0o644): MeshArtifactFile {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  return {
    type: "file",
    path,
    mode,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentBase64: bytes.toString("base64"),
  };
}

function baseArtifact(files: MeshArtifactFile[]): MeshBaseArtifactManifest {
  const identity = { version: 1 as const, kind: "base" as const, files };
  const sha256 = meshArtifactSha256(identity);
  return { ...identity, artifactId: `sha256:${sha256}`, sha256 };
}

describe("Mesh structured artifacts", () => {
  test("materializes only relative canonical POSIX file paths", () => {
    for (const path of ["../escape.txt", "/absolute.txt", "C:/drive.txt", "dir\\windows.txt", "a/./b"]) {
      const manifest = baseArtifact([artifactFile("safe.txt", "ok")]);
      const forged = { ...manifest, files: [{ ...manifest.files[0], path }] };
      expect(() => validateBaseArtifactManifest(forged)).toThrow();
    }
    const symlinkEntry = {
      ...baseArtifact([]),
      files: [{ type: "symlink", path: "link", mode: 0o777, size: 0, sha256: "0".repeat(64), contentBase64: "" }],
    };
    expect(() => validateBaseArtifactManifest(symlinkEntry)).toThrow();
  });

  test("rejects duplicate paths and every hash mismatch", () => {
    const file = artifactFile("src/main.ts", "export {};\n");
    expect(() => validateBaseArtifactManifest(baseArtifact([file, file]))).toThrow("duplicate path");

    const wrongFileHash = baseArtifact([{ ...file, sha256: "0".repeat(64) }]);
    expect(() => validateBaseArtifactManifest(wrongFileHash)).toThrow("file hash mismatch");

    const wrongOverallHash = { ...baseArtifact([file]), sha256: "0".repeat(64) };
    expect(() => validateBaseArtifactManifest(wrongOverallHash)).toThrow("manifest hash mismatch");
  });

  test("enforces file count, single-file, and total-size limits", () => {
    const tooMany = baseArtifact(Array.from({ length: 257 }, (_, index) => artifactFile(`f-${index}`, "")));
    expect(() => validateBaseArtifactManifest(tooMany)).toThrow();

    const oversized = Buffer.alloc(1 * 1024 * 1024 + 1, 1);
    expect(() => validateBaseArtifactManifest(baseArtifact([artifactFile("large.bin", oversized)]))).toThrow();

    const oneMiB = Buffer.alloc(1 * 1024 * 1024, 2);
    const tooLarge = baseArtifact(Array.from({ length: 9 }, (_, index) => artifactFile(`chunk-${index}`, oneMiB)));
    expect(() => validateBaseArtifactManifest(tooLarge)).toThrow("total size limit");

    const tooManyResultItems = {
      version: 1,
      kind: "result",
      artifactId: `sha256:${"0".repeat(64)}`,
      sha256: "0".repeat(64),
      baseArtifactId: `sha256:${"1".repeat(64)}`,
      taskId: "task-too-many-result-items",
      changed: Array.from({ length: 128 }, (_, index) => artifactFile(`changed-${index}`, "")),
      deleted: Array.from({ length: 129 }, (_, index) => `deleted-${index}`),
    };
    expect(() => validateResultArtifactManifest(tooManyResultItems)).toThrow("file count limit");
  });

  test("uses a task-scoped replay tombstone and binds result reads to that task", () => {
    const root = tempRoot();
    const store = new MeshArtifactStore(root);
    const base = baseArtifact([artifactFile("README.md", "before\n")]);
    const workspace = store.materialize("task-artifact-a", base);
    expect(() => store.materialize("task-artifact-a", base)).toThrow("already exists");

    writeFileSync(join(workspace.workspace, "README.md"), "after\n");
    writeFileSync(join(workspace.workspace, "new.txt"), "new\n");
    const result = store.captureResult("task-artifact-a", base, workspace.workspace);
    expect(result.changed.map((file) => file.path)).toEqual(["new.txt", "README.md"].sort());
    expect(store.readResult("task-artifact-a", result.artifactId)).toEqual(result);
    expect(() => store.readResult("task-artifact-b", result.artifactId)).toThrow("not found");
    expect(() => store.readResult("task-artifact-a", `sha256:${"0".repeat(64)}`)).toThrow("does not match task");
  });

  test("rejects a symbolic link created inside the isolated workspace", () => {
    const store = new MeshArtifactStore(tempRoot());
    const base = baseArtifact([artifactFile("safe.txt", "safe")]);
    const workspace = store.materialize("task-artifact-link", base);
    symlinkSync("safe.txt", join(workspace.workspace, "link.txt"));
    expect(() => store.captureResult("task-artifact-link", base, workspace.workspace)).toThrow("symbolic link");
  });
});
