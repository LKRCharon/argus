import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
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
import {
  MAX_MANIFEST_JSON_BYTES,
  runArtifactMaterializerCli,
} from "../src/mesh/artifact-materializer-cli";

const roots: string[] = [];
const cliPath = join(import.meta.dir, "../src/mesh/artifact-materializer-cli.ts");
const agentlinkRoot = join(import.meta.dir, "../../..");

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function artifactFile(path: string, content: string, mode = 0o644): MeshArtifactFile {
  const bytes = Buffer.from(content, "utf8");
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

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

function inputPair(taskId: string): {
  root: string;
  inputRoot: string;
  basePath: string;
  resultPath: string;
  base: MeshBaseArtifactManifest;
  result: MeshResultArtifactManifest;
} {
  const root = tempRoot("argus-cli-materializer-root-");
  const inputRoot = tempRoot("argus-cli-materializer-input-");
  const base = baseArtifact([artifactFile("file.txt", "base\n")]);
  const result = resultArtifact(base, taskId, [artifactFile("file.txt", "result\n")]);
  const basePath = join(inputRoot, "base.json");
  const resultPath = join(inputRoot, "result.json");
  writeJson(basePath, base);
  writeJson(resultPath, result);
  return { root, inputRoot, basePath, resultPath, base, result };
}

function argsFor(pair: { root: string; basePath: string; resultPath: string }, destination = "delivery") {
  return [
    "--base", pair.basePath,
    "--result", pair.resultPath,
    "--root", pair.root,
    "--destination", destination,
  ];
}

function invokeCli(argv: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["run", cliPath, ...argv], {
    cwd: agentlinkRoot,
    encoding: "utf8",
  });
  return {
    status: result.status ?? -1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

describe("artifact materializer CLI", () => {
  test("materializes successfully with exactly one bounded JSON summary line", () => {
    const pair = inputPair("task-cli-success");
    const result = invokeCli([...argsFor(pair), "--task-id", pair.result.taskId]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.parse(lines[0])).toMatchObject({
      taskId: pair.result.taskId,
      baseArtifactId: pair.base.artifactId,
      resultArtifactId: pair.result.artifactId,
      fileCount: 1,
      changedCount: 1,
      deletedCount: 0,
    });
    expect(readFileSync(join(pair.root, "delivery", "file.txt"), "utf8")).toBe("result\n");
  });

  test("rejects unknown, missing, and duplicate flags without stdout", () => {
    const cases = [
      ["--unknown", "value"],
      ["--base", "base.json"],
      ["--base", "one", "--base", "two", "--result", "result.json", "--root", "/tmp/root", "--destination", "delivery"],
    ];
    for (const argv of cases) {
      const result = invokeCli(argv);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.endsWith("\n")).toBe(true);
      expect(result.stderr.split("\n")).toHaveLength(2);
      expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(513);
    }
  });

  test("rejects invalid JSON and oversized manifest files", () => {
    const pair = inputPair("task-cli-invalid-input");
    writeFileSync(pair.basePath, "{");
    const invalid = invokeCli(argsFor(pair));
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toBe("base manifest is invalid JSON\n");

    const oversized = inputPair("task-cli-oversized-input");
    writeFileSync(oversized.basePath, Buffer.alloc(MAX_MANIFEST_JSON_BYTES + 1, 0x20));
    const tooLarge = invokeCli(argsFor(oversized));
    expect(tooLarge.status).toBe(1);
    expect(tooLarge.stdout).toBe("");
    expect(tooLarge.stderr).toBe("base manifest exceeds its size limit\n");
  });

  test("rejects symlink and non-regular manifest inputs", () => {
    const pair = inputPair("task-cli-file-types");
    const baseLink = join(pair.inputRoot, "base-link.json");
    symlinkSync(pair.basePath, baseLink);
    const symlinkInput = invokeCli([
      "--base", baseLink,
      "--result", pair.resultPath,
      "--root", pair.root,
      "--destination", "delivery",
    ]);
    expect(symlinkInput.status).toBe(1);
    expect(symlinkInput.stderr).toBe("base manifest must be a regular file\n");

    const resultDirectory = join(pair.inputRoot, "result-directory");
    mkdirSync(resultDirectory);
    const nonregularInput = invokeCli([
      "--base", pair.basePath,
      "--result", resultDirectory,
      "--root", pair.root,
      "--destination", "delivery",
    ]);
    expect(nonregularInput.status).toBe(1);
    expect(nonregularInput.stderr).toBe("result manifest must be a regular file\n");
  });

  test("reports deterministic input identity and content races separately from JSON errors", () => {
    const identityPair = inputPair("task-cli-identity-race");
    const original = readFileSync(identityPair.basePath);
    const moved = join(identityPair.inputRoot, "base-original.json");
    expect(() => runArtifactMaterializerCli(argsFor(identityPair), {
      afterManifestRead: (path, label) => {
        if (label !== "base manifest") return;
        renameSync(path, moved);
        writeFileSync(path, original);
      },
    })).toThrow("base manifest changed while it was being read");

    const contentPair = inputPair("task-cli-content-race");
    const replacement = Buffer.alloc(original.byteLength, 0x20);
    expect(() => runArtifactMaterializerCli(argsFor(contentPair), {
      afterManifestRead: (path, label) => {
        if (label === "base manifest") writeFileSync(path, replacement);
      },
    })).toThrow("base manifest changed while it was being read");
  });
});
