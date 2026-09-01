const mode = process.argv[2] ?? "healthy";
const decoder = new TextDecoder();
let buffer = "";
let listCalls = 0;

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

function error(id: number | string | undefined, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code: -32602, message } });
}

function handle(message: {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
}): void {
  switch (message.method) {
    case "initialize":
      if (mode === "exit-init") {
        setTimeout(() => process.exit(23), 5);
      } else if (mode !== "hang-init") {
        if (mode === "split") process.stderr.write("bounded diagnostic\n".repeat(24_000));
        response(message.id, {});
      }
      break;
    case "initialized":
      break;
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
    case "thread/resume": {
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
