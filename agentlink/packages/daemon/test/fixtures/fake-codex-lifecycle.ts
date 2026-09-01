const mode = process.argv[2] ?? "healthy";
const decoder = new TextDecoder();
let buffer = "";
let listCalls = 0;
let experimentalApi = false;
let nextQueuedId = 1;
const queued = new Map<string, {
  id: string;
  clientUserMessageId: string;
  input: unknown[];
}>();

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sendSplit(value: unknown): void {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const marker = bytes.indexOf(Buffer.from("分", "utf8"));
  const splitAt = marker >= 0 ? marker + 1 : Math.max(1, Math.floor(bytes.length / 2));
  process.stdout.write(bytes.subarray(0, splitAt));
  setTimeout(() => process.stdout.write(bytes.subarray(splitAt)), 5);
}

function response(id: number | string | undefined, result: unknown): void {
  const value = { jsonrpc: "2.0", id, result };
  if (mode === "split") sendSplit(value);
  else send(value);
}

function error(id: number | string | undefined, message: string, code = -32602): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(message: {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
}): void {
  switch (message.method) {
    case "initialize":
      experimentalApi = message.params?.capabilities?.experimentalApi === true;
      if (mode === "exit-init") {
        setTimeout(() => process.exit(23), 5);
      } else if (mode !== "hang-init") {
        if (mode === "split") process.stderr.write("bounded diagnostic\n".repeat(24_000));
        response(message.id, {});
      }
      break;
    case "initialized":
      break;
    case "thread/read":
      if (mode === "legacy-read") {
        error(message.id, "Method not found: thread/read", -32601);
      } else if (mode === "paginated-read") {
        response(message.id, {
          thread: {
            id: "thread-paginated",
            cwd: "/workspace/paginated",
            canAcceptDirectInput: true,
            turns: [],
          },
        });
      }
      break;
    case "thread/turns/list": {
      if (mode === "legacy-read") {
        error(message.id, "Method not found: thread/turns/list", -32601);
        break;
      }
      if (mode !== "paginated-read") break;
      if (!experimentalApi) {
        error(message.id, "thread/turns/list requires experimentalApi capability");
        break;
      }
      const params = message.params ?? {};
      if (params.limit !== 40 || params.sortDirection !== "desc" || params.itemsView !== "full") {
        error(message.id, "invalid bounded turn page");
        break;
      }
      response(message.id, {
        data: [
          {
            id: "turn-new",
            status: "inProgress",
            items: [{ id: "new-agent", type: "agentMessage", text: "new reply" }],
          },
          {
            id: "turn-old",
            status: "completed",
            items: [{
              id: "old-user",
              type: "userMessage",
              content: [{ type: "text", text: "old prompt" }],
            }],
          },
        ],
        nextCursor: "older-turns",
      });
      break;
    }
    case "thread/list":
      listCalls += 1;
      if (mode === "timeout-once" && listCalls === 1) return;
      if (mode === "never-list") return;
      response(message.id, {
        data: [{
          id: "thread-fixture",
          preview: "分片响应",
          status: "idle",
          source: "vscode",
          updatedAt: 123,
          canAcceptDirectInput: true,
        }],
      });
      break;
    case "thread/start":
      if (mode === "never-thread-start") return;
      if (mode === "late-thread-start") {
        setTimeout(() => response(message.id, { thread: { id: "thread-late" } }), 60);
      } else {
        response(message.id, { thread: { id: "thread-new" } });
      }
      break;
    case "thread/fork": {
      if (mode !== "fork-history") break;
      const params = message.params ?? {};
      if (params.threadId !== "thread-source"
        || params.excludeTurns !== true
        || params.cwd !== "/workspace/fork") {
        error(message.id, "invalid thread fork");
        break;
      }
      response(message.id, {
        thread: { id: "thread-forked", forkedFromId: "thread-source", turns: [] },
        cwd: "/workspace/fork",
      });
      break;
    }
    case "thread/resume": {
      if (mode === "paginated-read") {
        error(message.id, "thread thread-paginated already has an active writer", -32000);
        break;
      }
      if (mode === "legacy-read") {
        response(message.id, {
          thread: { id: "thread-paginated", canAcceptDirectInput: true, turns: [] },
          cwd: "/workspace/paginated",
          initialTurnsPage: {
            data: [{
              id: "turn-old",
              status: "completed",
              items: [{
                id: "old-user",
                type: "userMessage",
                content: [{ type: "text", text: "legacy prompt" }],
              }],
            }],
          },
        });
        break;
      }
      if (mode === "legacy-queue") {
        response(message.id, {
          thread: { id: "thread-legacy", canAcceptDirectInput: true, turns: [] },
          cwd: "/workspace/legacy",
        });
        break;
      }
      if (mode !== "paginated-resume") break;
      const params = message.params ?? {};
      if (params.excludeTurns !== true) {
        send({
          jsonrpc: "2.0",
          method: "deprecationNotice",
          params: { summary: "Full-history hydration is deprecated for paginated threads." },
        });
        error(message.id, "full-history resume rejected");
        break;
      }
      const initial = params.initialTurnsPage;
      if (initial === undefined) {
        response(message.id, {
          thread: { id: "thread-paginated", canAcceptDirectInput: true, turns: [] },
          cwd: "/workspace/paginated",
        });
        break;
      }
      if (initial.limit !== 40 || initial.sortDirection !== "desc" || initial.itemsView !== "full") {
        error(message.id, "invalid bounded turn page");
        break;
      }
      response(message.id, {
        thread: { id: "thread-paginated", canAcceptDirectInput: true, turns: [] },
        cwd: "/workspace/paginated",
        initialTurnsPage: {
          data: [
            {
              id: "turn-new",
              status: "inProgress",
              items: [{ id: "new-agent", type: "agentMessage", text: "new reply" }],
            },
            {
              id: "turn-old",
              status: "completed",
              items: [{
                id: "old-user",
                type: "userMessage",
                content: [{ type: "text", text: "old prompt" }],
              }],
            },
          ],
          nextCursor: "older-turns",
        },
      });
      break;
    }
    case "thread/queue/add": {
      if (mode === "legacy-queue") {
        error(message.id, "Method not found: thread/queue/add", -32601);
        break;
      }
      if (!mode.startsWith("queue-")) break;
      if (!experimentalApi) {
        error(message.id, "thread/queue/add requires experimentalApi capability");
        break;
      }
      const params = message.params ?? {};
      if (typeof params.threadId !== "string"
        || typeof params.clientUserMessageId !== "string"
        || !Array.isArray(params.input)) {
        error(message.id, "invalid queue add");
        break;
      }
      const existing = [...queued.values()].find(
        (item) => item.clientUserMessageId === params.clientUserMessageId,
      );
      const submission = existing ?? {
        id: `queued-${nextQueuedId++}`,
        clientUserMessageId: params.clientUserMessageId,
        input: params.input,
      };
      queued.set(submission.id, submission);
      response(message.id, { queuedSubmission: submission });
      break;
    }
    case "thread/queue/list":
      if (mode.startsWith("queue-")) {
        response(message.id, { data: [...queued.values()], nextCursor: null });
      }
      break;
    case "thread/queue/delete": {
      if (!mode.startsWith("queue-")) break;
      const id = String(message.params?.queuedSubmissionId ?? "");
      const deleted = mode === "queue-cleanup-fails" ? false : queued.delete(id);
      response(message.id, { deleted });
      break;
    }
    case "thread/queue/start": {
      if (!mode.startsWith("queue-")) break;
      const id = String(message.params?.queuedSubmissionId ?? "");
      if (mode === "queue-owner-required") {
        error(message.id, "resume the thread before starting a queued message", -32000);
        break;
      }
      if (mode === "queue-cleanup-fails") {
        error(message.id, "queue start failed", -32000);
        break;
      }
      if (!queued.delete(id)) {
        error(message.id, `queued submission not found: ${id}`, -32000);
        break;
      }
      response(message.id, {
        turn: { id: "turn-queued", status: "inProgress", items: [] },
      });
      break;
    }
    case "turn/start":
      if (mode === "legacy-queue") {
        response(message.id, { turn: { id: "turn-legacy", status: "inProgress" } });
      }
      break;
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer += decoder.decode(chunk, { stream: true });
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});

if (mode === "stubborn") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}

export {};
