import { describe, expect, test } from "bun:test";
import { MeshGitHubStatusSchema } from "@agentlink/wire";
import {
  githubStatusEnvironment,
  KMAC_GITHUB_CLI_PATH,
  KMAC_GITHUB_STATUS_ARGS,
  runKmacGitHubStatus,
} from "../deploy/kmac-github-status";

const checkedAt = new Date("2026-08-31T00:00:00.000Z");

describe("KMac GitHub status runner", () => {
  test("uses one fixed github.com operation and strips hostile environment overrides", () => {
    const secret = "ghp_hostile-token-value";
    let call: {
      command: string;
      args: readonly string[];
      env: Record<string, string>;
      timeoutMs: number;
      maxOutputBytes: number;
    } | undefined;
    const status = runKmacGitHubStatus({
      env: {
        HOME: "/Users/kmac",
        PATH: "/tmp/hostile",
        GH_TOKEN: secret,
        GITHUB_TOKEN: "github-token-value",
        GH_ENTERPRISE_TOKEN: "enterprise-token-value",
        GITHUB_ENTERPRISE_TOKEN: "enterprise-token-value-2",
        GH_HOST: "evil.example",
        GH_CONFIG_DIR: "/tmp/hostile-config",
        XDG_CONFIG_HOME: "/tmp/hostile-xdg",
      },
      now: () => checkedAt,
      commandRunner: (command, args, options) => {
        call = { command, args, ...options };
        return {
          status: 0,
          stdout: JSON.stringify({
            hosts: {
              "github.com": [{
                active: true,
                error: "",
                gitProtocol: "ssh",
                host: "github.com",
                login: "octocat",
                scopes: "repo",
                state: "success",
                tokenSource: "keyring",
              }],
            },
          }),
          stderr: `warning: Authorization: Bearer ${secret}\n`,
        };
      },
    });

    expect(status).toEqual({
      status: "authenticated",
      login: "octocat",
      source: "keychain",
      checkedAt: checkedAt.toISOString(),
    });
    expect(call).toEqual({
      command: KMAC_GITHUB_CLI_PATH,
      args: KMAC_GITHUB_STATUS_ARGS,
      env: {
        HOME: "/Users/kmac",
        PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        GH_PROMPT_DISABLED: "1",
      },
      timeoutMs: 8_000,
      maxOutputBytes: 16 * 1024,
    });
    expect(JSON.stringify(status)).not.toContain(secret);
    expect(JSON.stringify(call)).not.toContain(secret);
  });

  test("returns strict, bounded states for unauthenticated, unavailable, and error results", () => {
    const unauthenticated = runKmacGitHubStatus({
      now: () => checkedAt,
      commandRunner: () => ({ status: 0, stdout: JSON.stringify({ hosts: {} }), stderr: "" }),
    });
    expect(unauthenticated).toMatchObject({
      status: "unauthenticated",
      login: null,
      source: "none",
      errorCode: "not-authenticated",
    });

    const unavailable = runKmacGitHubStatus({
      now: () => checkedAt,
      commandRunner: () => ({ status: null, stdout: "", stderr: "", timedOut: true }),
    });
    expect(unavailable).toMatchObject({ status: "unavailable", errorCode: "timeout" });

    const error = runKmacGitHubStatus({
      now: () => checkedAt,
      commandRunner: () => ({ status: 0, stdout: "success without an account", stderr: "" }),
    });
    expect(error).toMatchObject({ status: "error", errorCode: "invalid-output" });
  });

  test("distinguishes an unavailable credential from a credential rejected by GitHub", () => {
    const authEntry = (tokenSource: string) => JSON.stringify({
      hosts: {
        "github.com": [{
          active: true,
          error: "HTTP 401: Bad credentials",
          gitProtocol: "ssh",
          host: "github.com",
          login: "LKRCharon",
          state: "error",
          tokenSource,
        }],
      },
    });
    const unavailable = runKmacGitHubStatus({
      now: () => checkedAt,
      commandRunner: () => ({ status: 0, stdout: authEntry("default"), stderr: "" }),
    });
    expect(unavailable).toMatchObject({
      status: "unavailable",
      errorCode: "credential-unavailable",
      login: null,
      source: "none",
    });

    const invalid = runKmacGitHubStatus({
      now: () => checkedAt,
      commandRunner: () => ({ status: 0, stdout: authEntry("keyring"), stderr: "" }),
    });
    expect(invalid).toMatchObject({
      status: "unauthenticated",
      errorCode: "invalid-credential",
      login: null,
      source: "none",
    });
  });

  test("keeps network failures separate from invalid credentials", () => {
    const status = runKmacGitHubStatus({
      now: () => checkedAt,
      commandRunner: () => ({
        status: 0,
        stdout: JSON.stringify({
          hosts: {
            "github.com": [{
              active: true,
              error: "dial tcp: network is unreachable",
              gitProtocol: "ssh",
              host: "github.com",
              login: "octocat",
              state: "error",
              tokenSource: "keyring",
            }],
          },
        }),
        stderr: "",
      }),
    });
    expect(status).toMatchObject({ status: "unavailable", errorCode: "network-unavailable" });
  });

  test("rejects arbitrary fields and keeps redaction out of the public schema", () => {
    expect(MeshGitHubStatusSchema.safeParse({
      status: "authenticated",
      login: "octocat",
      source: "keychain",
      checkedAt: checkedAt.toISOString(),
      stdout: "ghp_should-never-appear",
    }).success).toBe(false);
    expect(MeshGitHubStatusSchema.safeParse({
      status: "authenticated",
      login: "octocat",
      source: "keychain",
      checkedAt: checkedAt.toISOString(),
    }).success).toBe(true);
  });

  test("does not let a caller replace the fixed operation", () => {
    expect(KMAC_GITHUB_STATUS_ARGS).toEqual([
      "auth",
      "status",
      "--active",
      "--hostname",
      "github.com",
      "--json",
      "hosts",
    ]);
    expect(githubStatusEnvironment({
      HOME: "/Users/kmac",
      GH_TOKEN: "ghp_secret",
      GITHUB_TOKEN: "secret",
      GH_CONFIG_DIR: "/tmp/config",
      PATH: "/tmp/path",
    })).toEqual({
      HOME: "/Users/kmac",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      GH_PROMPT_DISABLED: "1",
    });
  });
});
