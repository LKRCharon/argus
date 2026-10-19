import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export function installAgent(label: string, args: string[], logs: string, workingDirectory?: string): void {
  if (process.platform !== "darwin") throw new Error("Run this installer on macOS");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const agents = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  const path = join(agents, label + ".plist");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${escape(label)}</string>
<key>ProgramArguments</key><array>${args.map(value => `<string>${escape(value)}</string>`).join("")}</array>
${workingDirectory ? `<key>WorkingDirectory</key><string>${escape(workingDirectory)}</string>` : ""}
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>${escape(join(logs, label + ".out.log"))}</string>
<key>StandardErrorPath</key><string>${escape(join(logs, label + ".error.log"))}</string>
</dict></plist>\n`;
  writeFileSync(path, xml, { mode: 0o600 });
  const domain = `gui/${process.getuid!()}`;
  spawnSync("/bin/launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" });
  // launchctl can return from bootout before removing the old job registration.
  let result = spawnSync("/bin/launchctl", ["bootstrap", domain, path], { encoding: "utf8" });
  for (let attempt = 0; result.status !== 0 && attempt < 40; attempt++) {
    Bun.sleepSync(250);
    result = spawnSync("/bin/launchctl", ["bootstrap", domain, path], { encoding: "utf8" });
  }
  if (result.status !== 0) throw new Error(result.stderr || "launchctl bootstrap failed");
  console.log(`Installed ${label}`);
}
