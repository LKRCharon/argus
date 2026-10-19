import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = join(process.env.LOCALAPPDATA!, "ArgusDesktopHost");
const stop = join(root, "stop");
if (process.platform !== "win32" || !existsSync(join(root, "host-supervisor.ts"))) throw new Error("Install the Windows host first");
switch (Bun.argv[2]) {
  case "stop": writeFileSync(stop, "user"); console.log("Stopping only the Argus host and its tunnel. Codex remains open."); break;
  case "start": {
    rmSync(stop, { force: true });
    const child = spawn(process.execPath, ["run", join(root, "host-supervisor.ts")], { detached: true, windowsHide: true, stdio: "ignore" }); child.unref(); break;
  }
  case "status": console.log(await (await fetch("http://127.0.0.1:18944/api/status", { signal: AbortSignal.timeout(5000) })).text()); break;
  default: throw new Error("Use start, stop, or status");
}
