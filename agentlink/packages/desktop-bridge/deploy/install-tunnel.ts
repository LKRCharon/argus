import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { installAgent } from "./launchd";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { target: { type: "string" }, key: { type: "string" }, "known-hosts": { type: "string" } } });
if (!values.target || !/^[a-zA-Z0-9_.@-]+$/.test(values.target) || !values.key || !values["known-hosts"]) {
  throw new Error("Usage: bun install-tunnel.ts --target tunnel-user@relay.example --key /absolute/key --known-hosts /absolute/known_hosts");
}
const key = resolve(values.key), knownHosts = resolve(values["known-hosts"]);
if (!existsSync(key) || !existsSync(knownHosts)) throw new Error("SSH key and pinned known_hosts must already exist on this Mac");
// OpenSSH parses -o values as ssh_config syntax, even when argv preserves spaces.
const hostOption = `UserKnownHostsFile="${knownHosts.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
installAgent("codes.limen.argus-desktop-web.tunnel", ["/usr/bin/ssh", "-NT", "-i", key, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", hostOption, "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-R", "127.0.0.1:18943:127.0.0.1:18943", values.target], join(homedir(), "Library", "Logs", "ArgusDesktopWeb"));
console.log("Reverse listener is loopback-only. The relay SSH key must allow permitlisten=127.0.0.1:18943.");
