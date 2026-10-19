import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";

export interface Delivery {
  id: string;
  threadId: string;
  hash: string;
  state: string;
  turnId: string | null;
  note: string | null;
  updatedAt: number;
}

export interface Creation {
  id: string;
  projectId: string;
  threadId: string | null;
  state: string;
  note: string | null;
}

/** Write before dispatch. A restarted or timed-out request is never sent again. */
export class Deliveries {
  private db: Database;
  private tracked = new Map<string, Pick<Delivery, "state" | "turnId">>();
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.db.exec("CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, threadId TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, turnId TEXT, note TEXT, updatedAt INTEGER NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS creations (id TEXT PRIMARY KEY,projectId TEXT NOT NULL,threadId TEXT,state TEXT NOT NULL,note TEXT)");
    this.db.query("UPDATE deliveries SET state='unknown', note='Bridge restarted during delivery; check history before resending', updatedAt=? WHERE state IN ('received','dispatching')").run(Date.now());
    this.db.exec("UPDATE creations SET state='unknown',note='Bridge restarted during creation; check the original App' WHERE state='creating'");
    for (const row of this.db.query<Delivery, []>("SELECT id,state,turnId FROM deliveries").all()) this.tracked.set(row.id, row);
  }

  claimCreation(id: string, projectId: string): { creation: Creation; fresh: boolean } {
    const insert = this.db.query("INSERT OR IGNORE INTO creations(id,projectId,state) VALUES (?,?,'creating')").run(id, projectId);
    const creation = this.creation(id)!;
    if (creation.projectId !== projectId) throw new Error("Creation ID belongs to another project");
    return { creation, fresh: insert.changes === 1 };
  }

  creation(id: string): Creation | null { return this.db.query<Creation, [string]>("SELECT * FROM creations WHERE id=?").get(id); }

  updateCreation(id: string, state: string, threadId: string | null = null, note: string | null = null): Creation {
    this.db.query("UPDATE creations SET state=?,threadId=COALESCE(?,threadId),note=? WHERE id=?").run(state, threadId, note, id);
    return this.creation(id)!;
  }

  claim(id: string, threadId: string, text: string, mode: string): { delivery: Delivery; fresh: boolean } {
    const hash = createHash("sha256").update(JSON.stringify({ threadId, text, mode })).digest("hex");
    const insert = this.db.query("INSERT OR IGNORE INTO deliveries(id,threadId,hash,state,updatedAt) VALUES (?,?,?,'received',?)").run(id, threadId, hash, Date.now());
    let delivery = this.get(id)!;
    if (delivery.hash !== hash) throw new Error("Message ID already belongs to a different message");
    const retry = delivery.state === "blocked" && this.db.query("UPDATE deliveries SET state='received',note=NULL,updatedAt=? WHERE id=? AND state='blocked'").run(Date.now(), id).changes === 1;
    if (retry) delivery = this.get(id)!;
    this.tracked.set(id, { state: delivery.state, turnId: delivery.turnId });
    return { delivery, fresh: insert.changes === 1 || retry };
  }

  get(id: string): Delivery | null { return this.db.query<Delivery, [string]>("SELECT * FROM deliveries WHERE id=?").get(id); }

  update(id: string, state: string, turnId: string | null = null, note: string | null = null): Delivery {
    this.db.query("UPDATE deliveries SET state=?,turnId=COALESCE(?,turnId),note=?,updatedAt=? WHERE id=?").run(state, turnId, note, Date.now(), id);
    const delivery = this.get(id)!;
    this.tracked.set(id, { state: delivery.state, turnId: delivery.turnId });
    return delivery;
  }

  observe(turns: Record<string, any>[]): void {
    for (const turn of turns) {
      const turnId = turn.turnId ?? turn.id;
      if (typeof turnId !== "string") continue;
      const ids = new Set([turn.params?.clientUserMessageId, ...(turn.items ?? []).map((item: any) => item.type === "userMessage" ? item.clientId : item.type === "steeringUserMessage" && item.status === "accepted" ? item.clientUserMessageId : null)]);
      const state = turn.status === "inProgress" ? "started" : turn.status === "completed" ? "completed" : turn.status ?? "started";
      for (const id of ids) {
        if (typeof id !== "string") continue;
        const previous = this.tracked.get(id);
        if (previous && (previous.state !== state || previous.turnId !== turnId)) this.update(id, state, turnId);
      }
    }
  }

  close(): void { this.db.close(); }
}
