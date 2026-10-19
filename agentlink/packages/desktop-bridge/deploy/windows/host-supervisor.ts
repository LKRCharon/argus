import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

if (process.platform !== "win32") throw new Error("Windows host supervisor only");
const root = resolve(process.env.ARGUS_WINDOWS_HOME ?? join(process.env.LOCALAPPDATA!, "ArgusDesktopHost"));
const logRoot = join(root, "logs"), pidFile = join(root, "supervisor.pid"), stopFile = join(root, "stop");
mkdirSync(logRoot, { recursive: true });
if (existsSync(stopFile)) process.exit(0);
let prior = 0;
try { prior = Number(readFileSync(pidFile, "utf8")); } catch {}
if (prior > 0) { try { process.kill(prior, 0); process.exit(0); } catch {} }
writeFileSync(pidFile, String(process.pid));
const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
const current = JSON.parse(readFileSync(join(root, "current.json"), "utf8"));
const entry = resolve(current.path, "packages/desktop-bridge/src/server.ts");
if (!entry.startsWith(root + "\\") || !existsSync(entry)) throw new Error("Invalid installed release");
let stopping = false;
const children = new Set<ChildProcess>();
function log(service: string, text: string) { appendFileSync(join(logRoot, "supervisor.log"), `${new Date().toISOString()} ${service}: ${text}\n`); }
function terminate(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid || !children.has(child)) return;
  // Only this supervisor's child tree; the user's desktop App is not a child.
  spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
}
async function run(service: string, command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  let failures = 0;
  while (!stopping) {
    const started = Date.now();
    const child = spawn(command, args, { cwd: dirname(entry), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", bytes => log(service, String(bytes).trim()));
    await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", error => { log(service, error.message); resolve(); }); });
    children.delete(child);
    if (stopping) return;
    failures = Date.now() - started > 60000 ? 0 : failures + 1;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(failures, 5)) + Math.random() * 500;
    log(service, `disconnected; retry in ${Math.round(delay)} ms`);
    const retryAt = Date.now() + delay;
    while (!stopping && Date.now() < retryAt) await new Promise(resolve => setTimeout(resolve, Math.min(1000, retryAt - Date.now())));
  }
}
function stop() { if (stopping) return; stopping = true; for (const child of children) terminate(child); }
const timer = setInterval(() => {
  if (existsSync(stopFile)) stop();
  // Keep local diagnostics bounded without logging commands, passwords or chat data.
  try { const path = join(logRoot, "supervisor.log"); if (Bun.file(path).size > 5 * 1024 * 1024) { rmSync(path + ".previous", { force: true }); renameSync(path, path + ".previous"); } } catch {}
}, 1000);
process.once("SIGINT", stop); process.once("SIGTERM", stop);
try {
  const knownHosts = `UserKnownHostsFile="${config.knownHosts.replaceAll("\\", "/").replaceAll('"', '\\"')}"`;
  await Promise.all([
    run("bridge", process.execPath, ["run", entry], { ...process.env, ARGUS_WEB_PORT: "18944", ARGUS_WEB_DATA: join(root, "state") }),
    run("tunnel", "ssh.exe", ["-NT", "-i", config.key, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", knownHosts, "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-R", "127.0.0.1:18944:127.0.0.1:18944", config.target]),
  ]);
} finally {
  stop(); clearInterval(timer);
  try { if (Number(readFileSync(pidFile, "utf8")) === process.pid) rmSync(pidFile); } catch {}
}
