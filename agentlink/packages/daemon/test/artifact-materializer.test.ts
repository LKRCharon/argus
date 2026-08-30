import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  fstatSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  meshArtifactSha256,
  type MeshArtifactFile,
  type MeshBaseArtifactManifest,
  type MeshResultArtifactManifest,
} from "@agentlink/wire";
import { materializeMeshResultArtifact } from "../src/mesh/artifact-materializer";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "argus-result-materializer-")));
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

function resultArtifact(
  base: MeshBaseArtifactManifest,
  taskId: string,
  changed: MeshArtifactFile[] = [],
  deleted: string[] = [],
): MeshResultArtifactManifest {
  const identity = {
    version: 1 as const,
    kind: "result" as const,
    baseArtifactId: base.artifactId,
    taskId,
    changed,
    deleted,
  };
  const sha256 = meshArtifactSha256(identity);
  return { ...identity, artifactId: `sha256:${sha256}`, sha256 };
}

function materialize(
  root: string,
  base: MeshBaseArtifactManifest,
  result: MeshResultArtifactManifest,
  destination = "delivery",
  expectedTaskId?: string,
) {
  return materializeMeshResultArtifact({
    materializationRoot: root,
    destination,
    baseArtifact: base,
    resultArtifact: result,
    expectedTaskId,
  });
}

describe("Mesh result artifact materializer", () => {
  test("reconstructs modify/add/delete content and preserves modes", () => {
    const root = tempRoot();
    const base = baseArtifact([
      artifactFile("src/main.txt", "before\n", 0o600),
      artifactFile("remove.txt", "remove\n", 0o644),
      artifactFile("keep.txt", "keep\n", 0o644),
    ]);
    const result = resultArtifact(
      base,
      "task-materialize-success",
      [
        artifactFile("src/main.txt", "after\n", 0o755),
        artifactFile("new.txt", "new\n", 0o640),
      ],
      ["remove.txt"],
    );

    const summary = materialize(root, base, result);
    const destination = join(realpathSync(root), "delivery");
    expect(summary).toEqual({
      taskId: result.taskId,
      baseArtifactId: base.artifactId,
      resultArtifactId: result.artifactId,
      destination,
      fileCount: 3,
      totalBytes: Buffer.byteLength("after\n") + Buffer.byteLength("new\n")
        + Buffer.byteLength("keep\n"),
      changedCount: 2,
      deletedCount: 1,
    });
    expect(readdirSync(root)).toEqual(["delivery"]);
    expect(readFileSync(join(destination, "src/main.txt"), "utf8")).toBe("after\n");
    expect(readFileSync(join(destination, "new.txt"), "utf8")).toBe("new\n");
    expect(existsSync(join(destination, "remove.txt"))).toBe(false);
    expect(statSync(join(destination, "src/main.txt")).mode & 0o777).toBe(0o755);
    expect(statSync(join(destination, "new.txt")).mode & 0o777).toBe(0o640);
  });

  test("rejects wrong hashes, base relations, and expected tasks", () => {
    const root = tempRoot();
    const base = baseArtifact([artifactFile("file.txt", "base")]);
    const result = resultArtifact(base, "task-materialize-integrity", [artifactFile("file.txt", "result")]);

    expect(() => materialize(root, base, { ...result, sha256: "0".repeat(64) })).toThrow("manifest hash mismatch");
    const otherBase = baseArtifact([artifactFile("other.txt", "other")]);
    expect(() => materialize(root, base, resultArtifact(otherBase, result.taskId))).toThrow("baseArtifactId");
    expect(() => materialize(root, base, result, "delivery", "different-task")).toThrow("taskId");
    expect(() => materialize(root, { ...base, sha256: "0".repeat(64) }, result)).toThrow("manifest hash mismatch");
    expect(readdirSync(root)).toEqual([]);
  });

  test("rejects absent-base deletions, duplicate paths, and changed/deleted overlap", () => {
    const root = tempRoot();
    const base = baseArtifact([artifactFile("base.txt", "base")]);
    const changed = artifactFile("changed.txt", "changed");

    expect(() => materialize(root, base, resultArtifact(base, "task-absent", [], ["missing.txt"])))
      .toThrow("absent from base");
    expect(() => materialize(root, base, resultArtifact(base, "task-duplicate-changed", [changed, changed])))
      .toThrow("duplicate");
    expect(() => materialize(root, base, resultArtifact(base, "task-duplicate-deleted", [], ["base.txt", "base.txt"])))
      .toThrow("duplicate");
    expect(() => materialize(root, base, resultArtifact(base, "task-overlap", [artifactFile("base.txt", "new")], ["base.txt"])))
      .toThrow("duplicate");
    expect(readdirSync(root)).toEqual([]);
  });

  test("rejects an existing destination without modifying it", () => {
    const root = tempRoot();
    const destination = join(root, "delivery");
    mkdirSync(destination);
    writeFileSync(join(destination, "keep.txt"), "keep");
    const base = baseArtifact([artifactFile("file.txt", "base")]);

    expect(() => materialize(root, base, resultArtifact(base, "task-existing"))).toThrow("already exists");
    expect(readFileSync(join(destination, "keep.txt"), "utf8")).toBe("keep");
    expect(readdirSync(root)).toEqual(["delivery"]);
  });

  test("rejects traversal, absolute, and platform-ambiguous destinations", () => {
    const root = tempRoot();
    const base = baseArtifact([artifactFile("file.txt", "base")]);
    const result = resultArtifact(base, "task-unsafe-destination");
    for (const destination of [
      "../escape",
      "/absolute",
      "C:\\absolute",
      "nested/../out",
      "./out",
      "nested//out",
      "CON.txt",
      "nested/CON.txt",
      "nested/has:colon",
      "nested/has\u0001control",
      "nested/trailing.",
      "nested/trailing ",
    ]) {
      expect(() => materialize(root, base, result, destination)).toThrow();
    }
    expect(readdirSync(root)).toEqual([]);
  });

  test("rejects ambiguous components in base, changed, deleted, and observed paths", () => {
    const unsafePaths = [
      "CON",
      "CON.txt",
      "CON .txt",
      "CON..txt",
      "prn.log",
      "AUX.data",
      "NUL.json",
      "COM1.txt",
      "LPT9.txt",
      "nested/CON.txt",
      "nested/has:colon",
      "nested/has<angle",
      "nested/has\u0001control",
      "nested/trailing.",
      "nested/trailing ",
    ];
    const root = tempRoot();
    const base = baseArtifact([artifactFile("base.txt", "base")]);

    for (const [index, path] of unsafePaths.entries()) {
      expect(() => materialize(
        root,
        baseArtifact([artifactFile(path, "base")]),
        resultArtifact(baseArtifact([artifactFile(path, "base")]), `task-unsafe-base-${index}`),
      )).toThrow("unsafe path component");
      expect(() => materialize(
        root,
        base,
        resultArtifact(base, `task-unsafe-changed-${index}`, [artifactFile(path, "changed")]),
      )).toThrow("unsafe path component");
      expect(() => materialize(
        root,
        base,
        resultArtifact(base, `task-unsafe-deleted-${index}`, [], [path]),
      )).toThrow("unsafe path component");
    }
    expect(readdirSync(root)).toEqual([]);

    expect(() => materializeMeshResultArtifact(
      {
        materializationRoot: root,
        destination: "delivery",
        baseArtifact: base,
        resultArtifact: resultArtifact(base, "task-unsafe-observed"),
      },
      {
        afterFileWrite: (_path, _index, stagingPath) => {
          writeFileSync(join(stagingPath, "CON.txt"), "unexpected");
        },
      },
    )).toThrow("unsafe path component");
    expect(readdirSync(root)).toEqual([]);
  });

  test("rejects symlink roots and destination path components", () => {
    const target = tempRoot();
    const linkParent = tempRoot();
    const rootLink = join(linkParent, "root-link");
    symlinkSync(target, rootLink, "dir");
    const base = baseArtifact([artifactFile("file.txt", "base")]);
    const result = resultArtifact(base, "task-root-link");
    expect(() => materialize(rootLink, base, result)).toThrow("symbolic link");

    const root = tempRoot();
    const outside = tempRoot();
    symlinkSync(outside, join(root, "linked"), "dir");
    expect(() => materialize(root, base, resultArtifact(base, "task-component-link"), "linked/delivery"))
      .toThrow("symbolic link");
    expect(readdirSync(outside)).toEqual([]);
  });

  test("cleans partial staging and never publishes a partial destination", () => {
    const root = tempRoot();
    const base = baseArtifact([
      artifactFile("a.txt", "a"),
      artifactFile("b.txt", "b"),
    ]);
    const result = resultArtifact(base, "task-cleanup");

    expect(() => materializeMeshResultArtifact(
      {
        materializationRoot: root,
        destination: "delivery",
        baseArtifact: base,
        resultArtifact: result,
      },
      {
        afterFileWrite: (path) => {
          if (path === "a.txt") throw new Error("forced write failure");
        },
      },
    )).toThrow("forced write failure");
    expect(readdirSync(root)).toEqual([]);
  });

  test("closes output descriptors before the publication primitive", () => {
    const root = tempRoot();
    const base = baseArtifact([artifactFile("file.txt", "content")]);
    let closedDescriptors: readonly number[] = [];
    materializeMeshResultArtifact(
      {
        materializationRoot: root,
        destination: "delivery",
        baseArtifact: base,
        resultArtifact: resultArtifact(base, "task-fd-close"),
      },
      {
        beforePublish: (context) => {
          closedDescriptors = context.closedOutputDescriptors;
          for (const descriptor of context.closedOutputDescriptors) {
            expect(() => fstatSync(descriptor)).toThrow();
          }
        },
      },
    );
    expect(closedDescriptors.length).toBe(1);
  });

  test("rejects an in-place same-length rewrite after output descriptors close", () => {
    const root = tempRoot();
    const base = baseArtifact([artifactFile("file.txt", "content")]);
    const destination = join(root, "delivery");

    expect(() => materializeMeshResultArtifact(
      {
        materializationRoot: root,
        destination: "delivery",
        baseArtifact: base,
        resultArtifact: resultArtifact(base, "task-content-race"),
      },
      {
        afterOutputDescriptorsClosed: ({ stagingPath }) => {
          writeFileSync(join(stagingPath, "file.txt"), "tamper!");
        },
      },
    )).toThrow("content changed");
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  test("does not replace a destination created immediately before publication", () => {
    const root = tempRoot();
    const base = baseArtifact([artifactFile("file.txt", "content")]);
    let destination = "";
    expect(() => materializeMeshResultArtifact(
      {
        materializationRoot: root,
        destination: "delivery",
        baseArtifact: base,
        resultArtifact: resultArtifact(base, "task-publication-race"),
      },
      {
        beforePublish: (context) => {
          destination = context.destination;
          mkdirSync(destination);
        },
      },
    )).toThrow("already exists");
    expect(statSync(destination).isDirectory()).toBe(true);
    expect(readdirSync(destination)).toEqual([]);
    expect(readdirSync(root)).toEqual(["delivery"]);
  });

  test("returns a deterministic bounded summary", () => {
    const root = tempRoot();
    const base = baseArtifact([artifactFile("file.txt", "content")]);
    const result = resultArtifact(base, "task-deterministic");
    const first = materialize(root, base, result, "first");
    const second = materialize(root, base, result, "second");
    const withoutDestination = (summary: typeof first) => ({
      taskId: summary.taskId,
      baseArtifactId: summary.baseArtifactId,
      resultArtifactId: summary.resultArtifactId,
      fileCount: summary.fileCount,
      totalBytes: summary.totalBytes,
      changedCount: summary.changedCount,
      deletedCount: summary.deletedCount,
    });
    expect(withoutDestination(first)).toEqual(withoutDestination(second));
    expect(Object.keys(first)).toEqual([
      "taskId",
      "baseArtifactId",
      "resultArtifactId",
      "destination",
      "fileCount",
      "totalBytes",
      "changedCount",
      "deletedCount",
    ]);
  });

  test("rejects a file path that would collide with an implicit directory", () => {
    const root = tempRoot();
    const base = baseArtifact([
      artifactFile("tree", "file"),
      artifactFile("tree/child", "child"),
    ]);
    const result = resultArtifact(base, "task-tree-conflict");
    expect(() => materialize(root, base, result)).toThrow("conflicts with a directory");
    expect(readdirSync(root)).toEqual([]);
  });

  test("does not accept a non-directory materialization root", () => {
    const parent = tempRoot();
    const rootFile = join(parent, "root-file");
    writeFileSync(rootFile, "not a directory");
    const base = baseArtifact([artifactFile("file.txt", "base")]);
    expect(() => materialize(rootFile, base, resultArtifact(base, "task-file-root"))).toThrow();
  });

  test("keeps nested destination publication in the existing parent", () => {
    const root = tempRoot();
    mkdirSync(join(root, "deliveries"));
    const base = baseArtifact([artifactFile("file.txt", "base")]);
    const summary = materialize(root, base, resultArtifact(base, "task-nested"), "deliveries/output");
    expect(summary.destination).toBe(join(realpathSync(root), "deliveries", "output"));
    expect(readFileSync(join(root, "deliveries", "output", "file.txt"), "utf8")).toBe("base");
  });
});
