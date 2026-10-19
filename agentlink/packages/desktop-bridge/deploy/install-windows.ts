import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

if (process.platform !== "win32") throw new Error("Run this on the Windows desktop host");
const { values } = parseArgs({ args: Bun.argv.slice(2), options: { target: { type: "string" }, key: { type: "string" }, "known-hosts": { type: "string" }, revision: { type: "string" } } });
if (!values.target || !/^[a-zA-Z0-9_.@-]+$/.test(values.target) || !values.key || !values["known-hosts"] || values.revision && !/^[a-f0-9]{40}$/.test(values.revision)) throw new Error("Provide --target --key --known-hosts [--revision Git-SHA]");
const key = resolve(values.key), knownHosts = resolve(values["known-hosts"]);
if (!existsSync(key) || !existsSync(knownHosts)) throw new Error("Enroll a dedicated restricted tunnel key and pin known_hosts first");
const source = resolve(import.meta.dir, ".."), root = join(process.env.LOCALAPPDATA!, "ArgusDesktopHost");
if (!existsSync(join(source, "web/app.js"))) throw new Error("Run bun run desktop:build first");
mkdirSync(root, { recursive: true });
const stopFile = join(root, "stop"); writeFileSync(stopFile, "install");
for (let attempt = 0; attempt < 40 && existsSync(join(root, "supervisor.pid")); attempt++) await new Promise(resolve => setTimeout(resolve, 1000));
if (existsSync(join(root, "supervisor.pid"))) throw new Error("Existing host did not stop; inspect its log before replacing it");
const release = join(root, "releases", new Date().toISOString().replaceAll(/[:.]/g, "-") + "-" + crypto.randomUUID().slice(0, 6));
const target = join(release, "packages/desktop-bridge"); mkdirSync(target, { recursive: true });
for (const name of ["src", "web"]) cpSync(join(source, name), join(target, name), { recursive: true });
const daemon = join(release, "packages/daemon/src"); mkdirSync(daemon, { recursive: true });
cpSync(resolve(source, "../daemon/src/codex-appserver.ts"), join(daemon, "codex-appserver.ts"));
const hash = createHash("sha256");
function hashTree(path: string, prefix = "") {
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) hashTree(join(path, entry.name), name + "/");
    else if (entry.isFile()) hash.update(name + "\0").update(readFileSync(join(path, entry.name)));
  }
}
hashTree(join(release, "packages"));
writeFileSync(join(release, "release.json"), JSON.stringify({ commit: values.revision ?? null, sourceSha256: hash.digest("hex"), installedAt: new Date().toISOString() }, null, 2));
writeFileSync(join(root, "config.json"), JSON.stringify({ target: values.target, key, knownHosts }, null, 2));
cpSync(join(source, "deploy/windows/host-supervisor.ts"), join(root, "host-supervisor.ts"));
cpSync(join(source, "deploy/windows/host-control.ts"), join(root, "host-control.ts"));
writeFileSync(join(root, "current.next.json"), JSON.stringify({ path: release }));
renameSync(join(root, "current.next.json"), join(root, "current.json"));
rmSync(stopFile, { force: true });
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const boot = `& ${quote(process.execPath)} run ${quote(join(root, "host-supervisor.ts"))}`;
const shortcut = join(process.env.APPDATA!, "Microsoft/Windows/Start Menu/Programs/Startup/Argus Desktop Host.lnk");
const command = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${quote(shortcut)}); $s.TargetPath='powershell.exe'; $s.Arguments=${quote(`-NoProfile -NonInteractive -WindowStyle Hidden -Command "${boot}"`)}; $s.WindowStyle=7; $s.Description='Argus Windows desktop bridge'; $s.Save(); Start-Process -FilePath 'powershell.exe' -ArgumentList ${quote(`-NoProfile -NonInteractive -WindowStyle Hidden -Command "${boot}"`)} -WindowStyle Hidden`;
const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, encoding: "utf8" });
if (result.status !== 0) throw new Error("Could not install the per-user background launcher: " + result.stderr);
console.log("Windows host installed on 127.0.0.1:18944 with per-user login startup. The original Codex App is preserved.");
