import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export function desktopDataRoot(): string {
  return process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ArgusDesktopWeb")
    : join(homedir(), "Library", "Application Support", "ArgusDesktopWeb");
}

export async function openDesktopThread(id: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid thread ID");
  const uri = `codex://threads/${id}`;
  const command = process.platform === "darwin" ? "/usr/bin/open" : "powershell.exe";
  if (process.platform !== "darwin" && process.platform !== "win32") throw new Error("Desktop control requires macOS or Windows");
  const args = process.platform === "darwin" ? ["-b", "com.openai.codex", uri]
    : ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", `Start-Process -FilePath '${uri}'`];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Opening the desktop chat timed out")); }, 10000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Cannot open the desktop chat")); });
  });
}
