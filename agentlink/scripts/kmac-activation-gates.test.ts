import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MANUAL_RESTORE_ARGS,
  canonicalPathWithin,
  candidateMeshHashMatches,
  fixedFileIsReady,
  handoffResultPathWithin,
  manifestMatchesReviewedCommit,
  normalizedPath,
  reversePlistHashMatches,
} from "../deploy/kmac-activation-gates";

const reviewed = "c".repeat(40);

const SHELL_PATH_PREDICATE_SCRIPTS = [
  "../deploy/activate-kmac-watcher.sh",
  "../deploy/install-kmac-reverse-tunnel.sh",
  "../deploy/dispatch-kmac-reverse-tunnel.sh",
  "../deploy/handoff-kmac-reverse-tunnel.sh",
  "../deploy/run-kmac-reverse-tunnel-handoff.sh",
] as const;

function extractPersistentPathPredicate(source: string): string {
  const start = source.indexOf("path_argument_is_persistent() {");
  const end = source.indexOf("\n}", start);
  if (start < 0 || end < 0) throw new Error("path predicate not found");
  return source.slice(start, end + 2);
}

function runBashPathPredicate(predicate: string, value: string): boolean {
  const result = spawnSync("/bin/bash", [
    "-c",
    `set -u\n${predicate}\npath_argument_is_persistent "$1"\n`,
    "path-predicate-regression",
    value,
  ], { encoding: "utf8" });
  return result.status === 0;
}

describe("KMac activation gates", () => {
  test("executes every shell path predicate without the impossible NUL check", () => {
    const normalPath = "/Users/kairong/Library/Application Support/AgentLink/releases/candidate";
    const invalidTemporaryPath = "/tmp/argus-path-regression";
    const invalidNewlinePath = `${normalPath}\nwith-newline`;

    for (const relativePath of SHELL_PATH_PREDICATE_SCRIPTS) {
      const source = readFileSync(join(import.meta.dir, relativePath), "utf8");
      expect(source).not.toContain("$'\\0'");
      const predicate = extractPersistentPathPredicate(source);
      expect(runBashPathPredicate(predicate, normalPath)).toBe(true);
      expect(runBashPathPredicate(predicate, invalidTemporaryPath)).toBe(false);
      expect(runBashPathPredicate(predicate, invalidNewlinePath)).toBe(false);
    }
  });

  test("requires an exact lowercase candidate config hash", () => {
    const expected = "a".repeat(64);
    expect(candidateMeshHashMatches(expected, expected)).toBe(true);
    expect(candidateMeshHashMatches("b".repeat(64), expected)).toBe(false);
    expect(candidateMeshHashMatches("A".repeat(64), expected)).toBe(false);
    expect(candidateMeshHashMatches("short", expected)).toBe(false);
    expect(reversePlistHashMatches(expected, expected)).toBe(true);
    expect(reversePlistHashMatches("A".repeat(64), expected)).toBe(false);
  });

  test("requires a valid tree and the reviewed manifest commit", () => {
    expect(manifestMatchesReviewedCommit({
      ok: true,
      manifestValid: true,
      treeMatchesManifest: true,
      gitCommit: reviewed,
    }, reviewed)).toBe(true);
    expect(manifestMatchesReviewedCommit({
      ok: true,
      manifestValid: true,
      treeMatchesManifest: true,
      gitCommit: "d".repeat(40),
    }, reviewed)).toBe(false);
    expect(manifestMatchesReviewedCommit({
      ok: true,
      manifestValid: true,
      treeMatchesManifest: false,
      gitCommit: reviewed,
    }, reviewed)).toBe(false);
    expect(manifestMatchesReviewedCommit({
      ok: true,
      manifestValid: true,
      treeMatchesManifest: true,
      gitCommit: "not-a-commit",
    }, reviewed)).toBe(false);
  });

  test("rejects temporary and outside-release candidate paths", () => {
    const base = "/Users/kairong/Library/Application Support/AgentLink";
    expect(canonicalPathWithin(base, `${base}/releases/candidate`, "releases")).toBe(true);
    expect(canonicalPathWithin(base, `${base}/prepared/mesh.json`, "releases")).toBe(false);
    expect(canonicalPathWithin(base, "/private/tmp/candidate", "releases")).toBe(false);
    expect(canonicalPathWithin(base, `${base}/releases/../prepared/mesh.json`, "releases")).toBe(false);
    expect(normalizedPath(`${base}/releases/../prepared/mesh.json`)).toBe(`${base}/prepared/mesh.json`);
    expect(canonicalPathWithin(base, `${base}/releases/${"x".repeat(4090)}`, "releases")).toBe(false);
  });

  test("keeps handoff results persistent and inside AgentLink", () => {
    const base = "/Users/kairong/Library/Application Support/AgentLink";
    expect(handoffResultPathWithin(base,
      `${base}/activation/handoff/results/handoff-20260830T010203Z-123.result`)).toBe(true);
    expect(handoffResultPathWithin(base, "/private/tmp/handoff.result")).toBe(false);
    expect(handoffResultPathWithin(base,
      `${base}/activation/handoff/results/../../../../tmp/handoff-x.result`)).toBe(false);
    expect(handoffResultPathWithin(base,
      `${base}/activation/handoff/escaped/handoff-x.result`)).toBe(false);
  });

  test("requires fixed dispatcher files to be regular, executable, and in-script", () => {
    const directory = "/Users/kairong/checkout/agentlink/deploy";
    const ready = { regular: true, symlink: false, executable: true };
    for (const name of [
      "run-kmac-reverse-tunnel-handoff.sh",
      "handoff-kmac-reverse-tunnel.sh",
    ]) {
      const file = `${directory}/${name}`;
      expect(fixedFileIsReady(directory, file, ready)).toBe(true);
      expect(fixedFileIsReady(directory, file,
        { regular: false, symlink: false, executable: true })).toBe(false);
      expect(fixedFileIsReady(directory, file,
        { regular: true, symlink: false, executable: false })).toBe(false);
      expect(fixedFileIsReady(directory, file,
        { regular: true, symlink: true, executable: true })).toBe(false);
    }
    expect(fixedFileIsReady(directory, "/private/tmp/handoff-kmac-reverse-tunnel.sh", ready)).toBe(false);
  });

  test("restores through fixed argv and cannot evaluate injected command text", () => {
    expect(MANUAL_RESTORE_ARGS).toEqual([
      "/usr/bin/ssh", "-fNT", "-o", "BatchMode=yes", "-o", "ClearAllForwardings=no",
      "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=10",
      "-R", "127.0.0.1:22022:127.0.0.1:22", "seoul",
    ]);
    const handoff = readFileSync(join(import.meta.dir, "../deploy/handoff-kmac-reverse-tunnel.sh"), "utf8");
    expect(handoff).not.toMatch(/\beval\s/);
    expect(handoff).toContain("/usr/bin/ssh -fNT");
    expect(handoff).toContain("127.0.0.1:22022:127.0.0.1:22");
    expect(handoff).toContain("seoul");
    expect(handoff).toContain("ARGUS_EXPECTED_REVERSE_PLIST_SHA256");
    expect(handoff).toContain("launchctl bootout");
    expect(handoff).toContain("reverse-tunnel-plist.absent");
    expect(handoff).toContain("unloaded_not_proven");
    expect(handoff).toContain("TCP[[:space:]]+127\\.0\\.0\\.1:[0-9]+->127\\.0\\.0\\.1:22");
    expect(handoff.indexOf("reverse_plist_sha256_mismatch")).toBeLessThan(
      handoff.indexOf("handoff_attempted=1\nstop_manual"),
    );
    expect(handoff.indexOf("launchctl bootout")).toBeLessThan(handoff.indexOf("rollback_plist_state=\"$(restore_previous_plist"));
    for (const state of ["STARTED", "REVERSE_TUNNEL_HANDOFF_OK", "ROLLED_BACK", "BLOCKED"]) {
      expect(handoff).toContain(`write_result ${state}`);
    }
    const successWrite = handoff.indexOf("write_result REVERSE_TUNNEL_HANDOFF_OK");
    const successTrapClear = handoff.indexOf("trap - ERR INT TERM", successWrite);
    expect(successWrite).toBeGreaterThan(-1);
    expect(successTrapClear).toBeGreaterThan(successWrite);
    expect(handoff).toContain('current_status" == status=STARTED');
  });

  test("dispatches only the fixed detached handoff worker", () => {
    const dispatcher = readFileSync(join(import.meta.dir,
      "../deploy/dispatch-kmac-reverse-tunnel.sh"), "utf8");
    const worker = readFileSync(join(import.meta.dir,
      "../deploy/run-kmac-reverse-tunnel-handoff.sh"), "utf8");
    const handoff = readFileSync(join(import.meta.dir,
      "../deploy/handoff-kmac-reverse-tunnel.sh"), "utf8");
    expect(dispatcher).not.toMatch(/\beval\s/);
    expect(dispatcher).not.toContain("$@");
    expect(dispatcher).not.toMatch(/\bsh\s+-c\b/);
    expect(dispatcher).toContain("/usr/bin/nohup /usr/bin/env -i");
    expect(dispatcher).toContain("ARGUS_REVERSE_BACKUP_ROOT");
    expect(dispatcher).toContain("ARGUS_HANDOFF_RESULT_PATH");
    expect(dispatcher).toContain("write_result STARTED dispatched");
    expect(dispatcher).not.toContain("write_result STARTED worker_verified");
    expect(dispatcher).toContain('fixed_file_is_ready "$WORKER"');
    expect(dispatcher).toContain('fixed_file_is_ready "$HANDOFF"');
    expect(dispatcher).toContain("trap dispatcher_failure ERR");
    expect(dispatcher).toContain("trap 'dispatcher_failure 130' INT");
    expect(dispatcher).toContain("trap 'dispatcher_failure 143' TERM");
    expect(dispatcher).toContain("write_result BLOCKED");
    expect(dispatcher).toContain("reason=\"${failure_reason:-early_start_failure}\"");
    expect(dispatcher).toContain("terminate_verified_child");
    expect(dispatcher).toContain("wait_for_worker_start");
    expect(dispatcher).toContain("child_is_expected");
    expect(dispatcher).toContain('[[ "$child_pid" != "$EXPECTED_PID" ]] || return 1');
    expect(dispatcher).toContain('readonly NEVER_TERMINATE_PID="97171"');
    expect(dispatcher).toContain('[[ "$child_pid" != "$NEVER_TERMINATE_PID" ]] || return 1');
    const activation = readFileSync(join(import.meta.dir,
      "../deploy/activate-kmac-watcher.sh"), "utf8");
    expect(activation).toContain("runner?.fixedArgs?.length !== 1");
    expect(activation).toContain("runner?.executable !== process.env.EXPECTED_RUNTIME_BUN");
    expect(activation).toContain("Object.keys(env).length === Object.keys(expectedEnv).length");
    expect(dispatcher.indexOf("\nresult_ready=1\n")).toBeLessThan(
      dispatcher.indexOf("trap dispatcher_failure ERR"),
    );
    expect(dispatcher).toContain("/bin/mv -f");
    expect(dispatcher.lastIndexOf("write_result STARTED")).toBe(
      dispatcher.indexOf("write_result STARTED dispatched"),
    );
    expect(dispatcher.indexOf("write_result STARTED dispatched")).toBeLessThan(
      dispatcher.indexOf("/usr/bin/nohup /usr/bin/env -i"),
    );
    expect(dispatcher.indexOf("trap - ERR INT TERM", dispatcher.indexOf("wait_for_worker_start"))).toBeGreaterThan(
      dispatcher.indexOf("child_is_expected || dispatcher_failure 70"),
    );
    expect(dispatcher.lastIndexOf("trap - ERR INT TERM")).toBeLessThan(
      dispatcher.indexOf("/usr/bin/printf 'DISPATCHED"),
    );
    const terminateStart = dispatcher.indexOf("terminate_verified_child()");
    const failureStart = dispatcher.indexOf("dispatcher_failure()");
    expect(terminateStart).toBeGreaterThan(-1);
    expect(failureStart).toBeGreaterThan(terminateStart);
    expect(dispatcher.slice(terminateStart, failureStart)).toContain("if child_is_expected");
    expect(dispatcher.slice(terminateStart, failureStart)).not.toContain("child_verified");
    expect(dispatcher).toContain('current_status" == status=STARTED');
    expect(dispatcher.indexOf("/usr/bin/printf 'DISPATCHED")).toBeGreaterThan(
      dispatcher.indexOf("wait_for_worker_start || dispatcher_failure"),
    );
    expect(worker.indexOf("fixed_file_is_ready \"$HANDOFF\"")).toBeLessThan(
      worker.indexOf("/bin/sleep 3"),
    );
    expect(worker.lastIndexOf("fixed_file_is_ready \"$HANDOFF\"")).toBeGreaterThan(
      worker.indexOf("/bin/sleep 3"),
    );
    expect(worker).toContain("readonly WORKER_BLOCK_REASON=\"worker_handoff_preflight\"");
    expect(worker).toContain("result_path_is_safe");
    expect(worker).toContain("write_blocked_result");
    expect(worker).toContain("status=BLOCKED");
    expect(worker).toContain("status=REVERSE_TUNNEL_HANDOFF_OK|status=ROLLED_BACK");
    expect(worker).toContain('fixed_file_is_ready "$HANDOFF" || block_worker');
    expect(worker).toContain('exec /bin/bash "$HANDOFF" || block_worker');
    expect(worker).toContain("/bin/sleep 3");
    expect(worker).toContain("exec /bin/bash");
    expect(worker).not.toContain("$@");

    const stopStart = handoff.indexOf("stop_manual()");
    const restoreStart = handoff.indexOf("restore_manual()", stopStart);
    const stopBody = handoff.slice(stopStart, restoreStart);
    expect(stopBody).toContain(
      'manual_identity_for_pid "$EXPECTED_MANUAL_PID" || return 1\n  /bin/kill -TERM "$EXPECTED_MANUAL_PID"',
    );
  });

  test("records absent-marker rollback state instead of leaving a self-starting plist", () => {
    const installer = readFileSync(join(import.meta.dir,
      "../deploy/install-kmac-reverse-tunnel.sh"), "utf8");
    const handoff = readFileSync(join(import.meta.dir,
      "../deploy/handoff-kmac-reverse-tunnel.sh"), "utf8");
    expect(installer).toContain("reverse-tunnel-plist.absent");
    expect(installer).toContain("state=target_absent");
    expect(handoff).toContain("restore_previous_plist");
    expect(handoff).toContain("/bin/rm -f \"$TARGET\"");
  });

  test("keeps the stable Codex path after login-shell path_helper", () => {
    const bootstrap = readFileSync(join(import.meta.dir, "../deploy/kmac-bootstrap.sh"), "utf8");
    const readiness = readFileSync(join(import.meta.dir, "../deploy/kmac-readiness.sh"), "utf8");
    expect(bootstrap).toContain('ZPROFILE="$HOME/.zprofile"');
    expect(bootstrap).toContain('append_zsh_path_block "$ZPROFILE"');
    expect(bootstrap).toContain('/bin/mv -f "$temporary" "$target"');
    expect(readiness).toContain("/bin/zsh -lc");
    expect(readiness).toContain("NONINTERACTIVE_BUN");
  });
});
