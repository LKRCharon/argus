import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installAgent } from "./launchd";

if (process.platform !== "darwin") throw new Error("Run on the Mac that hosts the original App");
const source = resolve(import.meta.dir, "..");
if (!existsSync(join(source, "web", "app.js"))) throw new Error("Build the web assets first: bun run desktop:build");
const root = join(homedir(), "Library", "Application Support", "ArgusDesktopWeb");
const release = join(root, "releases", new Date().toISOString().replaceAll(/[:.]/g, "-") + "-" + crypto.randomUUID().slice(0, 6));
const packageTarget = join(release, "packages", "desktop-bridge");
mkdirSync(packageTarget, { recursive: true, mode: 0o700 });
cpSync(join(source, "src"), join(packageTarget, "src"), { recursive: true });
cpSync(join(source, "web"), join(packageTarget, "web"), { recursive: true });
const daemonTarget = join(release, "packages", "daemon", "src");
mkdirSync(daemonTarget, { recursive: true });
cpSync(resolve(source, "../daemon/src/codex-appserver.ts"), join(daemonTarget, "codex-appserver.ts"));
const hash = createHash("sha256");
function hashTree(path: string, relative = "") {
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const name = relative + entry.name;
    if (entry.isDirectory()) hashTree(join(path, entry.name), name + "/");
    else if (entry.isFile()) hash.update(name + "\0").update(readFileSync(join(path, entry.name)));
  }
}
hashTree(join(release, "packages"));
const commit = process.argv.find(argument => argument.startsWith("--revision="))?.slice("--revision=".length) ?? null;
if (commit !== null && !/^[0-9a-f]{40}$/.test(commit)) throw new Error("Invalid Git revision");
writeFileSync(join(release, "release.json"), JSON.stringify({ sourceSha256: hash.digest("hex"), commit, installedAt: new Date().toISOString() }, null, 2) + "\n", {mode:0o600});
const current = join(root, "current");
if (existsSync(current) && !lstatSync(current).isSymbolicLink()) throw new Error("Refusing to replace an unmanaged current directory");
const next = join(root, "current.next");
if (existsSync(next)) {
  if (!lstatSync(next).isSymbolicLink()) throw new Error("Unexpected current.next path");
  unlinkSync(next);
}
symlinkSync(release, next); renameSync(next, current);
installAgent("codes.limen.argus-desktop-web", [process.execPath, "run", join(current, "packages", "desktop-bridge", "src", "server.ts")], join(homedir(), "Library", "Logs", "ArgusDesktopWeb"), current);
console.log("Mac web service: http://127.0.0.1:18943/");
console.log("Previous releases and the original App are preserved.");
