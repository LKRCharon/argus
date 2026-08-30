import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MANUAL_RESTORE_ARGS,
  canonicalPathWithin,
  candidateMeshHashMatches,
  fixedFileIsReady,
  handoffResultPathWithin,
  manifestMatchesReviewedCommit,
  normalizedPath,
  remoteCodexControlIsEnabled,
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

function extractAtomicLinkSwitch(source: string): string {
  const start = source.indexOf("atomic_link_switch() {");
  const end = source.indexOf("\n}\n\nrollback() {", start);
  if (start < 0 || end < 0) throw new Error("atomic link switch not found");
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

function extractCandidateConfigGate(source: string): string {
  const start = source.indexOf("verify_candidate_config() {");
  const end = source.indexOf("\n}\n\ncontroller_snapshot() {", start);
  if (start < 0 || end < 0) throw new Error("candidate config gate not found");
  return source.slice(start, end + 2);
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

  test("executes the candidate config gate with a readonly module binding", () => {
    const activation = readFileSync(join(import.meta.dir,
      "../deploy/activate-kmac-watcher.sh"), "utf8");
    const gate = extractCandidateConfigGate(activation);
    const testRoot = mkdtempSync(join(tmpdir(), "argus-kmac-config-gate-"));
    const baseRoot = join(testRoot, "agentlink");
    const homeRoot = join(testRoot, "home");
    const candidateConfig = join(baseRoot, "prepared", "mesh.json");
    const sourceRelease = join(import.meta.dir, "..");
    const release = join(testRoot, "release");
    const bun = process.execPath;
    const stateDir = join(baseRoot, "state");
    const workspaceRoot = join(baseRoot, "workspace");
    const codexBin = join(homeRoot, ".local", "bin", "codex");
    const statusPath = `${homeRoot}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
    const config = {
      version: 1,
      groups: [{ id: "group-alpha", members: ["node-a", "node-b"] }],
      requesters: ["node-a"],
      legacyControl: false,
      remoteCodexControl: true,
      allowedRoots: [workspaceRoot],
      resources: [{
        id: "workspace:kmac-m4",
        ownerNodeId: "node-b",
        kind: "directory",
        displayName: "KMac",
        root: workspaceRoot,
        statusRunnerId: "kmac-status-v1",
      }],
      runners: [{
        id: "kmac-status-v1",
        resourceId: "workspace:kmac-m4",
        purpose: "status",
        executable: bun,
        fixedArgs: [`${release}/deploy/kmac-workspace-status.ts`],
        workdir: ".",
        env: {
          PATH: statusPath,
          ARGUS_STATUS_STATE_DIR: stateDir,
          ARGUS_STATUS_WATCH_LABEL: "com.kairong.agentlink-watch",
          ARGUS_STATUS_CODEX_BIN: codexBin,
          ARGUS_STATUS_RELAY_PORT: "28787",
        },
        maxRuntimeMs: 5000,
        maxOutputBytes: 4096,
        allowDynamicArgs: false,
        allowInput: false,
        approvalRequired: false,
        workspaceCapabilities: ["read-only-status"],
        exposeDebugOutput: false,
      }],
    };
    const configText = `${JSON.stringify(config)}\n`;
    mkdirSync(join(baseRoot, "prepared"), { recursive: true, mode: 0o700 });
    mkdirSync(join(release, "packages", "daemon", "src", "mesh"), { recursive: true, mode: 0o700 });
    mkdirSync(join(release, "deploy"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(release, "packages", "daemon", "src", "mesh", "config.ts"),
      `export { parseMeshConfig } from ${JSON.stringify(
        join(sourceRelease, "packages", "daemon", "src", "mesh", "config.ts"),
      )};\n`,
      { mode: 0o600 },
    );
    writeFileSync(join(release, "deploy", "kmac-workspace-status.ts"), "", { mode: 0o600 });
    writeFileSync(candidateConfig, configText, { mode: 0o600 });
    const expectedHash = createHash("sha256").update(configText).digest("hex");

    try {
      const result = spawnSync("/bin/bash", [
        "-c",
        [
          "set -Eeuo pipefail",
          'CANDIDATE_CONFIG="$1"',
          'CANDIDATE_RELEASE="$2"',
          'readonly GATES_MODULE="$3"',
          'BUN="$4"',
          'base_canonical="$5"',
          'export HOME="$6"',
          'export AGENTLINK_HOME="$5/agentlink-home"',
          'EXPECTED_CANDIDATE_MESH_SHA256="$7"',
          "sha256_file() {",
          "  local output",
          '  output="$(/usr/bin/shasum -a 256 "$1" 2>/dev/null || true)"',
          '  printf \'%s\\n\' "${output%% *}"',
          "}",
          gate,
          "verify_candidate_config",
          "printf 'candidate_config_gate=passed\\n'",
        ].join("\n"),
        "candidate-config-gate-regression",
        candidateConfig,
        release,
        join(sourceRelease, "deploy", "kmac-activation-gates.ts"),
        bun,
        baseRoot,
        homeRoot,
        expectedHash,
      ], { encoding: "utf8" });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("candidate_config_gate=passed\n");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
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

  test("requires explicit remote Codex opt-in in the candidate and activation", () => {
    expect(remoteCodexControlIsEnabled({ remoteCodexControl: true })).toBe(true);
    expect(remoteCodexControlIsEnabled({ remoteCodexControl: false })).toBe(false);
    expect(remoteCodexControlIsEnabled({})).toBe(false);
    expect(remoteCodexControlIsEnabled(null)).toBe(false);

    const activation = readFileSync(join(import.meta.dir,
      "../deploy/activate-kmac-watcher.sh"), "utf8");
    expect(activation).toContain(
      'readonly REQUIRE_REMOTE_CODEX_CONTROL="${ARGUS_REQUIRE_REMOTE_CODEX_CONTROL:?ARGUS_REQUIRE_REMOTE_CODEX_CONTROL is required}"',
    );
    expect(activation).toContain(
      '[[ "$REQUIRE_REMOTE_CODEX_CONTROL" == true ]] || fail_precondition remote_codex_control_opt_in',
    );
    expect(activation).toContain("!remoteCodexControlIsEnabled(parsed)");
    expect(activation).toContain("status?.workspace?.remoteCodexControl!==true");
    expect(activation).toContain("READY_FOR_COMMANDER_CANARY remoteCodexControl=true");
  });

  test("atomically replaces current without following its destination symlink", () => {
    const activation = readFileSync(join(import.meta.dir,
      "../deploy/activate-kmac-watcher.sh"), "utf8");
    const switchFunction = extractAtomicLinkSwitch(activation);
    expect(activation).toContain('/bin/mv -f -h "$temporary" "$CURRENT"');
    expect(activation).not.toContain('/bin/mv -f "$temporary" "$CURRENT"');
    expect(switchFunction).toContain(
      '/bin/rm -f "$temporary" || true; return 1',
    );

    const testRoot = mkdtempSync(join(tmpdir(), "argus-kmac-link-"));
    try {
      const result = spawnSync("/bin/bash", [
        "-c",
        [
          "set -Eeuo pipefail",
          'root="$1"',
          'old="$root/old"',
          'candidate="$root/candidate"',
          'CURRENT="$root/current"',
          '/bin/mkdir -p "$old" "$candidate"',
          '/bin/ln -s "$old" "$CURRENT"',
          `assert_no_stage2() { [[ -z "$(/usr/bin/find "$1" -name 'current.stage2.*' -print)" ]]; }`,
          switchFunction,
          'atomic_link_switch "$candidate"',
          '[[ "$(/usr/bin/readlink "$CURRENT")" == "$candidate" ]]',
          'assert_no_stage2 "$old"',
          'assert_no_stage2 "$candidate"',
          'atomic_link_switch "$old"',
          '[[ "$(/usr/bin/readlink "$CURRENT")" == "$old" ]]',
          'assert_no_stage2 "$old"',
          'assert_no_stage2 "$candidate"',
        ].join("\n"),
        "atomic-link-switch-regression",
        testRoot,
      ], { encoding: "utf8" });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
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

  test("matches macOS lsof ESTABLISHED sockets with portable literal parentheses", () => {
    const handoff = readFileSync(join(import.meta.dir,
      "../deploy/handoff-kmac-reverse-tunnel.sh"), "utf8");
    const identityStart = handoff.indexOf("manual_identity_for_pid() {");
    const identityEnd = handoff.indexOf("\n}\n\nlaunchd_running_pid()", identityStart);
    expect(identityStart).toBeGreaterThan(-1);
    expect(identityEnd).toBeGreaterThan(identityStart);
    const identity = handoff.slice(identityStart, identityEnd + 2);
    const socketPattern = identity.match(/\/usr\/bin\/grep -Eq '([^']+)'/)?.[1] ?? "";

    expect(socketPattern).toBe(
      "TCP[[:space:]]+127\\.0\\.0\\.1:[0-9]+->127\\.0\\.0\\.1:22[[:space:]]+[(]ESTABLISHED[)]$",
    );
    expect(socketPattern).not.toContain("\\(ESTABLISHED\\)$");

    const result = spawnSync("/usr/bin/grep", ["-Eq", socketPattern], {
      input: "  TCP 127.0.0.1:54321->127.0.0.1:22 (ESTABLISHED)\n",
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
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

  test("routes every post-switch failure through the top-level rollback", () => {
    const activation = readFileSync(join(import.meta.dir,
      "../deploy/activate-kmac-watcher.sh"), "utf8");
    const attemptStart = activation.indexOf("\nactivation_attempted=1\n");
    const successTrap = activation.indexOf("\ntrap - ERR INT TERM\n", attemptStart);
    expect(attemptStart).toBeGreaterThan(-1);
    expect(successTrap).toBeGreaterThan(attemptStart);
    const postAttempt = activation.slice(attemptStart, successTrap);

    expect(postAttempt).not.toMatch(/\bexit\b/);
    expect(postAttempt).toContain('if atomic_link_switch "$CANDIDATE_RELEASE"; then :; else rollback 1; fi');
    expect(postAttempt).toContain("if atomic_mesh_replace; then :; else rollback 1; fi");
    expect(postAttempt).toContain('if /bin/launchctl kickstart -k "$DOMAIN/$LABEL"; then :; else rollback 1; fi');
    expect(postAttempt).toContain("if wait_for_watcher_process; then :; else rollback 1; fi");
    expect(postAttempt).toContain("else\n  rollback 1\nfi");
  });

  test("keeps command substitutions free of trap changes", () => {
    const activation = readFileSync(join(import.meta.dir,
      "../deploy/activate-kmac-watcher.sh"), "utf8");
    const attemptStart = activation.indexOf("\nactivation_attempted=1\n");
    const successTrap = activation.indexOf("\ntrap - ERR INT TERM\n", attemptStart);
    const postAttempt = activation.slice(attemptStart, successTrap);

    expect(postAttempt).toContain('if controller_verify "$baseline_last_seen"; then');
    expect(postAttempt).toContain('reconnected_at="$controller_verify_seen"');
    expect(postAttempt).not.toContain("$(controller_verify");
    expect(activation).toContain('snapshot="$(controller_snapshot 2>/dev/null || exit 1)"');
    expect(activation).not.toContain("$(trap");
    expect(activation).toContain(
      "trap rollback ERR\ntrap 'rollback 130' INT\ntrap 'rollback 143' TERM",
    );
    expect(activation).toContain('if /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=8');
    expect(activation).toContain('controller_verify_seen="$seen"');
  });

  test("uses deterministic rollback handlers and disables them on exit", () => {
    const activation = readFileSync(join(import.meta.dir,
      "../deploy/activate-kmac-watcher.sh"), "utf8");
    const rollbackStart = activation.indexOf("rollback() {");
    const rollbackEnd = activation.indexOf("\n}\ntrap rollback ERR\n", rollbackStart);
    const trapBlock = [
      "trap rollback ERR",
      "trap 'rollback 130' INT",
      "trap 'rollback 143' TERM",
    ].join("\n");
    const successCleanup = activation.lastIndexOf("\ntrap - ERR INT TERM\n");

    expect(rollbackStart).toBeGreaterThan(-1);
    expect(rollbackEnd).toBeGreaterThan(rollbackStart);
    expect(activation).toContain(`${trapBlock}\n`);
    expect(activation).not.toContain("trap rollback ERR INT TERM");
    expect(activation.slice(rollbackStart, rollbackEnd)).toContain(
      "trap - ERR INT TERM",
    );
    expect(successCleanup).toBeGreaterThan(rollbackEnd);
    expect(successCleanup).toBeLessThan(activation.indexOf("\nprintf ", successCleanup));
  });

  test("preserves ERR and signal exit statuses through real Bash traps", () => {
    const activation = readFileSync(join(import.meta.dir,
      "../deploy/activate-kmac-watcher.sh"), "utf8");
    const rollbackStart = activation.indexOf("rollback() {");
    const rollbackEnd = activation.indexOf("\n}\ntrap rollback ERR\n", rollbackStart);
    const rollback = activation.slice(rollbackStart, rollbackEnd + 2);

    const run = (trigger: string) => spawnSync("/bin/bash", [
      "-c",
      [
        "set -Ee",
        "activation_attempted=0",
        rollback,
        "trap rollback ERR",
        "trap 'rollback 130' INT",
        "trap 'rollback 143' TERM",
        trigger,
      ].join("\n"),
      "rollback-trap-regression",
    ], { encoding: "utf8" });

    expect(run("false").status).toBe(1);
    expect(run("( /bin/sleep 0.01; /bin/kill -INT \"$$\" ) & wait \"$!\"").status).toBe(130);
    expect(run("( /bin/sleep 0.01; /bin/kill -TERM \"$$\" ) & wait \"$!\"").status).toBe(143);
  });

  test("suppresses inherited ERR in the production sha256 helper and fails closed", () => {
    const activation = readFileSync(join(import.meta.dir,
      "../deploy/activate-kmac-watcher.sh"), "utf8");
    const helperStart = activation.indexOf("sha256_file() {");
    const helperEnd = activation.indexOf("\n}\nfail_precondition", helperStart);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helper = activation.slice(helperStart, helperEnd + 2);

    const testRoot = mkdtempSync(join(tmpdir(), "argus-kmac-sha256-"));
    const missingPath = join(testRoot, "missing", "mesh.json");
    const trapLog = join(testRoot, "err-trap.log");
    try {
      expect(existsSync(missingPath)).toBe(false);
      const result = spawnSync("/bin/bash", [
        "-c",
        [
          "set -Ee",
          "trap_log=\"$1\"",
          "trap 'printf ERR >> \"$trap_log\"' ERR",
          helper,
          "hash=\"$(sha256_file \"$2\")\"",
          "hash_status=$?",
          "printf 'hash=%s\\n' \"$hash\"",
          "printf 'hash_status=%s\\n' \"$hash_status\"",
          "require_hash() { [[ -n \"$1\" ]]; }",
          "if require_hash \"$hash\"; then",
          "  printf 'caller_rejected_empty=0\\n'",
          "  exit 1",
          "fi",
          "printf 'caller_rejected_empty=1\\n'",
        ].join("\n"),
        "sha256-helper-regression",
        trapLog,
        missingPath,
      ], { encoding: "utf8" });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(
        "hash=\nhash_status=0\ncaller_rejected_empty=1\n",
      );
      expect(result.stderr).toBe("");
      expect(existsSync(trapLog)).toBe(false);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("waits for launchd readiness with a bounded poll and one kickstart per phase", () => {
    const activation = readFileSync(join(import.meta.dir,
      "../deploy/activate-kmac-watcher.sh"), "utf8");
    const waitStart = activation.indexOf("wait_for_watcher_process() {");
    const waitEnd = activation.indexOf("\n}", waitStart);
    expect(waitStart).toBeGreaterThan(-1);
    expect(waitEnd).toBeGreaterThan(waitStart);
    const wait = activation.slice(waitStart, waitEnd + 2);

    expect(activation).toContain("readonly WATCHER_READINESS_ATTEMPTS=10");
    expect(activation).toContain("readonly WATCHER_READINESS_INTERVAL_SECONDS=1");
    expect(wait).toContain(
      "for ((attempt = 1; attempt <= WATCHER_READINESS_ATTEMPTS; attempt += 1)); do",
    );
    expect(wait).toContain("if verify_process; then");
    expect(wait).toContain(
      '/bin/sleep "$WATCHER_READINESS_INTERVAL_SECONDS" || return 1',
    );
    expect(wait).not.toContain("kickstart");

    const kickstarts = activation.match(/\/bin\/launchctl kickstart -k "\$DOMAIN\/\$LABEL"/g) ?? [];
    expect(kickstarts).toHaveLength(2);

    const attemptStart = activation.indexOf("\nactivation_attempted=1\n");
    const candidateKickstart = activation.indexOf(
      'if /bin/launchctl kickstart -k "$DOMAIN/$LABEL"; then :; else rollback 1; fi',
      attemptStart,
    );
    const candidateReadiness = activation.indexOf(
      "if wait_for_watcher_process; then :; else rollback 1; fi",
      candidateKickstart,
    );
    expect(candidateKickstart).toBeGreaterThan(attemptStart);
    expect(candidateReadiness).toBeGreaterThan(candidateKickstart);
    expect(activation).toContain("if wait_for_watcher_process; then");
  });

  test("exercises readiness retry and timeout bounds without touching launchd", () => {
    const activation = readFileSync(join(import.meta.dir,
      "../deploy/activate-kmac-watcher.sh"), "utf8");
    const waitStart = activation.indexOf("wait_for_watcher_process() {");
    const waitEnd = activation.indexOf("\n}", waitStart);
    const wait = activation.slice(waitStart, waitEnd + 2);
    const result = spawnSync("/bin/bash", [
      "-c",
      [
        "set -u",
        "WATCHER_READINESS_ATTEMPTS=3",
        "WATCHER_READINESS_INTERVAL_SECONDS=0",
        "verify_calls=0",
        "verify_process() { verify_calls=$((verify_calls + 1)); (( verify_calls == 3 )); }",
        wait,
        "if wait_for_watcher_process; then printf 'ready=%s\\n' \"$verify_calls\"; else exit 1; fi",
        "verify_calls=0",
        "verify_process() { verify_calls=$((verify_calls + 1)); return 1; }",
        "if wait_for_watcher_process; then exit 1; else printf 'timeout=%s\\n' \"$verify_calls\"; fi",
      ].join("\n"),
    ], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ready=3\ntimeout=3\n");
  });

  test("reports only fixed activation and rollback failure stages", () => {
    const activation = readFileSync(join(import.meta.dir,
      "../deploy/activate-kmac-watcher.sh"), "utf8");
    for (const stage of [
      "preflight",
      "unknown",
      "candidate_link_switch",
      "candidate_mesh_replace",
      "candidate_kickstart",
      "candidate_link_verify",
      "candidate_process_ready",
      "candidate_controller_verify",
    ]) {
      expect(activation).toContain(`failure_stage="${stage}"`);
    }
    for (const stage of [
      "none",
      "rollback_mesh_restore",
      "rollback_link_restore",
      "rollback_kickstart",
      "rollback_process_ready",
      "rollback_link_verify",
      "rollback_mesh_verify",
      "rollback_process_verify",
      "rollback_controller_reconnect",
      "rollback_verification",
      "rollback_unknown",
    ]) {
      expect(activation).toContain(`rollback_failure_stage="${stage}"`);
    }
    expect(activation).toContain(
      "failure_stage=%s rollback_failure_stage=%s",
    );
    expect(activation).toContain(
      "BLOCKED rollback_verification_failed old_release=%s pid=%s lastSeen=%s failure_stage=%s rollback_failure_stage=%s",
    );
  });

  test("requires both restored artifacts and their proofs before reporting rollback", () => {
    const activation = readFileSync(join(import.meta.dir,
      "../deploy/activate-kmac-watcher.sh"), "utf8");
    const rollbackStart = activation.indexOf("rollback() {");
    const rollbackEnd = activation.indexOf("\n}\ntrap rollback ERR\n", rollbackStart);
    expect(rollbackStart).toBeGreaterThan(-1);
    expect(rollbackEnd).toBeGreaterThan(rollbackStart);
    const rollback = activation.slice(rollbackStart, rollbackEnd);

    expect(rollback).toContain('if atomic_mesh_restore; then mesh_restored=1; fi');
    expect(rollback).toContain('if atomic_link_switch "$OLD_RELEASE"; then link_restored=1; fi');
    expect(rollback).toContain("if (( mesh_restored && link_restored && watcher_restarted ))");
    expect(rollback).toContain('rollback_current_target_canonical="$(canonical_current_target 2>/dev/null || true)"');
    expect(rollback).toContain('rollback_mesh_sha256="$(sha256_file "$MESH_CONFIG" 2>/dev/null || true)"');
    expect(rollback).toContain('[[ "$rollback_current_target_canonical" == "$old_release_canonical" ]]');
    expect(rollback).toContain('[[ "$rollback_mesh_sha256" == "$EXPECTED_LIVE_MESH_SHA256" ]]');
    expect(rollback).toContain('&& (( rollback_seen > baseline_last_seen ));');
    expect(rollback).toContain("BLOCKED rollback_verification_failed");
  });
});
