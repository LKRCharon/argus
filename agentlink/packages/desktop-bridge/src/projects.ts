import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "./ipc";

/** Some desktop builds keep their project assignments in this compatibility cache. */
export function projectAssignments(state: Message): Map<string, string> {
  const legacy = Object.assign(Object.create(null), ...Object.entries(state["app-server-project-id-by-legacy-project-id-by-host"] ?? {}).filter(([host]) => host.startsWith("local:")).map(([, value]) => value));
  const result = new Map<string, string>();
  for (const [threadId, assignment] of Object.entries(state["thread-project-assignments"] ?? {}) as [string, Message][]) {
    if (assignment?.projectKind !== "local" || typeof assignment.projectId !== "string") continue;
    result.set(threadId, typeof legacy[assignment.projectId] === "string" ? legacy[assignment.projectId] : assignment.projectId);
  }
  return result;
}

export class DesktopProjects {
  private stamp = "";
  private assignments = new Map<string, string>();
  constructor(private path = join(homedir(), ".codex", ".codex-global-state.json")) {}
  read(): Map<string, string> {
    try {
      const stat = statSync(this.path);
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024 || process.platform !== "win32" && stat.uid !== process.getuid!()) return new Map();
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      if (stamp !== this.stamp) {
        this.assignments = projectAssignments(JSON.parse(readFileSync(this.path, "utf8"))); this.stamp = stamp;
      }
      return this.assignments;
    } catch { return new Map(); }
  }
}
