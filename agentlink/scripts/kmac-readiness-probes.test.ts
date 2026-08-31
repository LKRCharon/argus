import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeAndroidSdkReadiness,
  probeGitHubReadiness,
  redactProbeText,
  type ProbeCommandResult,
} from "../deploy/kmac-readiness-probes";

function commandSequence(results: ProbeCommandResult[]): {
  calls: Array<{
    command: string;
    args: readonly string[];
    env: Record<string, string>;
    timeoutMs: number;
    maxOutputBytes: number;
  }>;
  runner: (
    command: string,
    args: readonly string[],
    options: { env: Record<string, string>; timeoutMs: number; maxOutputBytes: number },
  ) => ProbeCommandResult;
} {
  const calls: Array<{
    command: string;
    args: readonly string[];
    env: Record<string, string>;
    timeoutMs: number;
    maxOutputBytes: number;
  }> = [];
  return {
    calls,
    runner: (command, args, options) => {
      calls.push({ command, args, ...options });
      return results.shift() ?? { status: 1, stdout: "", stderr: "" };
    },
  };
}

function sdkTree(root: string, includePackages = true): void {
  mkdirSync(join(root, "platform-tools"), { recursive: true });
  mkdirSync(join(root, "licenses"), { recursive: true });
  writeFileSync(join(root, "platform-tools", "adb"), "adb");
  chmodSync(join(root, "platform-tools", "adb"), 0o755);
  writeFileSync(join(root, "licenses", "android-sdk-license"), "license");
  if (!includePackages) return;
  mkdirSync(join(root, "platforms", "android-35"), { recursive: true });
  mkdirSync(join(root, "build-tools", "35.0.0"), { recursive: true });
  writeFileSync(join(root, "platforms", "android-35", "android.jar"), "platform");
  writeFileSync(join(root, "build-tools", "35.0.0", "aapt2"), "aapt2");
  chmodSync(join(root, "build-tools", "35.0.0", "aapt2"), 0o755);
}

describe("KMac readiness probes", () => {
  test("reports only GitHub login metadata and never command secrets", () => {
    const commands = commandSequence([
      {
        status: 0,
        stdout: JSON.stringify({
          hosts: {
            "github.com": [{
              active: true,
              error: "",
              gitProtocol: "ssh",
              host: "github.com",
              login: "octocat",
              state: "success",
              tokenSource: "keyring",
            }],
          },
        }),
        stderr: "",
      },
      { status: 0, stdout: "deadbeef\tHEAD\n", stderr: "" },
    ]);
    const secret = "ghp_fake-token-value";
    const result = probeGitHubReadiness({
      env: {
        HOME: "/Users/tester",
        PATH: "/usr/bin",
        GH_TOKEN: secret,
      },
      ghPath: "gh",
      gitPath: "git",
      gitRemote: "git@github.com:owner/repo.git",
      commandRunner: commands.runner,
    });

    expect(result).toEqual({
      provider: "github",
      status: {
        status: "authenticated",
        login: "octocat",
        source: "keychain",
        checkedAt: expect.any(String),
      },
      credentialSource: "keychain",
      identity: { login: "octocat" },
      gitSsh: { reachable: true, state: "reachable" },
      api: { classification: "authenticated" },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(commands.calls.map((call) => call.args)).toEqual([
      ["auth", "status", "--active", "--hostname", "github.com", "--json", "hosts"],
      ["-c", "core.askPass=", "ls-remote", "--heads", "git@github.com:owner/repo.git"],
    ]);
    expect(commands.calls.flatMap((call) => call.args)).not.toContain("--show-token");
    expect(commands.calls.map(({ timeoutMs, maxOutputBytes }) => ({ timeoutMs, maxOutputBytes }))).toEqual([
      { timeoutMs: 8_000, maxOutputBytes: 16 * 1024 },
      { timeoutMs: 8_000, maxOutputBytes: 32 * 1024 },
    ]);
    expect(commands.calls[0].env.GH_TOKEN).toBeUndefined();
    expect(commands.calls[0].env.GITHUB_TOKEN).toBeUndefined();
    expect(commands.calls[1].env.GH_TOKEN).toBeUndefined();
  });

  test("classifies keychain, auth, and transport outcomes without raw diagnostics", () => {
    const keychain = commandSequence([
      {
        status: 0,
        stdout: JSON.stringify({
          hosts: {
            "github.com": [{
              active: true,
              error: "",
              gitProtocol: "ssh",
              host: "github.com",
              login: "octocat",
              state: "success",
              tokenSource: "keyring",
            }],
          },
        }),
        stderr: "",
      },
      { status: 1, stdout: "", stderr: "Permission denied (publickey)." },
    ]);
    expect(probeGitHubReadiness({
      env: { HOME: "/Users/tester", PATH: "/usr/bin" },
      ghPath: "gh",
      gitPath: "git",
      commandRunner: keychain.runner,
    })).toMatchObject({
      credentialSource: "keychain",
      status: { status: "authenticated" },
      identity: { login: "octocat" },
      api: { classification: "authenticated" },
      gitSsh: { reachable: false, state: "unreachable" },
    });

    const forbidden = commandSequence([
      { status: 0, stdout: JSON.stringify({ hosts: {} }), stderr: "" },
      { status: 1, stdout: "", stderr: "network unreachable" },
    ]);
    expect(probeGitHubReadiness({
      env: { HOME: "/Users/tester", PATH: "/usr/bin" },
      ghPath: "gh",
      gitPath: "git",
      commandRunner: forbidden.runner,
    })).toMatchObject({
      credentialSource: "none",
      status: { status: "unauthenticated" },
      identity: null,
      api: { classification: "unauthenticated" },
      gitSsh: { state: "unreachable" },
    });
  });

  test("redacts private keys, bearer tokens, and authorization headers", () => {
    const diagnostic = [
      "Authorization: Bearer abc123",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "private bytes",
      "-----END OPENSSH PRIVATE KEY-----",
      "token=ghp_fake-token-value",
    ].join("\n");
    const redacted = redactProbeText(diagnostic);
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("private bytes");
    expect(redacted).not.toContain("ghp_fake-token-value");
    expect(redacted).toContain("[REDACTED]");
  });

  test("reports ready SDK state from ANDROID_HOME without touching adb", () => {
    const root = mkdtempSync(join(tmpdir(), "argus-android-ready-"));
    try {
      sdkTree(root);
      const result = probeAndroidSdkReadiness({
        env: {
          HOME: "/Users/tester",
          PATH: join(root, "platform-tools"),
          ANDROID_HOME: root,
        },
        platform: "darwin",
      });
      expect(result).toEqual({
        provider: "android",
        state: "ready",
        sdkRootSource: "ANDROID_HOME",
        tooling: { adb: true, sdkRoot: true },
        adb: { available: true, source: "PATH" },
        license: { present: true },
        packages: { platformTools: true, platformApi35: true, buildToolsApi35: true },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("distinguishes missing packages, license, and tooling", () => {
    const packagesRoot = mkdtempSync(join(tmpdir(), "argus-android-packages-"));
    const licenseRoot = mkdtempSync(join(tmpdir(), "argus-android-license-"));
    try {
      sdkTree(packagesRoot, false);
      expect(probeAndroidSdkReadiness({
        env: { HOME: "/Users/tester", ANDROID_SDK_ROOT: packagesRoot, PATH: "/usr/bin" },
        platform: "darwin",
      }).state).toBe("missing-packages");

      sdkTree(licenseRoot);
      rmSync(join(licenseRoot, "licenses", "android-sdk-license"));
      expect(probeAndroidSdkReadiness({
        env: { HOME: "/Users/tester", ANDROID_SDK_ROOT: licenseRoot, PATH: join(licenseRoot, "platform-tools") },
        platform: "darwin",
      }).state).toBe("missing-license");

      expect(probeAndroidSdkReadiness({
        env: {
          HOME: "/Users/tester",
          ANDROID_HOME: join(packagesRoot, "does-not-exist"),
          PATH: "/usr/bin",
        },
        knownSdkRoots: [join(packagesRoot, "also-missing")],
        platform: "darwin",
      })).toMatchObject({
        state: "missing-tooling",
        sdkRootSource: "none",
        tooling: { adb: false, sdkRoot: false },
        adb: { available: false, source: "none" },
      });
    } finally {
      rmSync(packagesRoot, { recursive: true, force: true });
      rmSync(licenseRoot, { recursive: true, force: true });
    }
  });

  test("falls back to a known SDK location and makes no adb command", () => {
    const root = mkdtempSync(join(tmpdir(), "argus-android-known-"));
    const calls: string[][] = [];
    try {
      sdkTree(root);
      const result = probeAndroidSdkReadiness({
        env: { HOME: "/Users/tester", PATH: "/usr/bin" },
        knownSdkRoots: [root],
        commandRunner: (command, args) => {
          calls.push([command, ...args]);
          throw new Error("adb must not be invoked");
        },
      });
      expect(result).toMatchObject({ state: "ready", sdkRootSource: "known-location", adb: { source: "sdk-root" } });
      expect(calls).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("wires the structured probe into readiness without device commands", () => {
    const readiness = readFileSync(join(import.meta.dir, "../deploy/kmac-readiness.sh"), "utf8");
    expect(readiness).toContain("kmac-readiness-probes.ts");
    expect(readiness).toContain("READINESS_PROBES");
    expect(readiness).toContain("GITHUB_AUTH");
    expect(readiness).toContain("kmac-github-status-v1");
    expect(readiness).not.toContain("NONINTERACTIVE_GH");
    expect(readiness).not.toContain("adb devices");
    expect(readiness).not.toContain("adb start-server");
    expect(readiness).not.toContain("--licenses");
  });
});
