import { afterEach, expect, test } from "bun:test";
import { CodexAppServer } from "../src/codex-appserver";

const originalCodexBin = process.env.CODEX_BIN;

afterEach(() => {
  if (originalCodexBin === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = originalCodexBin;
});

test("CodexAppServer prefers an explicit native binary", () => {
  process.env.CODEX_BIN = process.execPath;
  expect(CodexAppServer.binaryPath()).toBe(process.execPath);
});
