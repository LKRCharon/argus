import { expect, test } from "bun:test";
import { projectAssignments } from "../src/projects";

test("project filters use native desktop membership even when the server uses migrated IDs", () => {
  const result = projectAssignments({
    "app-server-project-id-by-legacy-project-id-by-host": {"local:/test/.codex": {"legacy-project":"server-project"},"remote:other":{"legacy-project":"wrong-host"}},
    "thread-project-assignments": {"older-chat":{projectKind:"local",projectId:"legacy-project"},"newer-chat":{projectKind:"local",projectId:"server-project"},"remote-chat":{projectKind:"remote",projectId:"legacy-project"}},
  });
  expect(result.get("older-chat")).toBe("server-project");
  expect(result.get("newer-chat")).toBe("server-project");
  expect(result.has("remote-chat")).toBe(false);
});
