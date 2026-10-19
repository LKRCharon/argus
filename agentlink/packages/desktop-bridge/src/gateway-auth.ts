import { createHash, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const derive = promisify(pbkdf2);
const WINDOW = 15 * 60 * 1000;
export interface GatewaySession { id: string; username: string; csrf: string; expires: number }

/** Reuses the OJ verifier read-only; passwords and raw session tokens are never stored. */
export class GatewayAuth {
  private fingerprint = "";
  private users: Record<string, { salt: string; hash: string }> = {};
  private loadedAt = -Infinity;
  private failures = new Map<string, number[]>();
  private attempts: number[] = [];
  private deriving = 0;
  private sessions = new Map<string, GatewaySession>();

  constructor(private file: string, private now = Date.now, private ttl = 12 * 60 * 60 * 1000, private allowedUsers?: string[]) { this.load(); }

  private load(): void {
    const now = this.now();
    if (now - this.loadedAt < 2000) return;
    // Fail closed when the shared verifier becomes unavailable or malformed.
    const content = readFileSync(this.file, "utf8");
    const hash = createHash("sha256").update(content).digest("hex");
    if (hash !== this.fingerprint) {
      const config = JSON.parse(content);
      if (config.version !== 1 || config.kdf !== "pbkdf2_sha256" || !config.users || !Object.keys(config.users).length) throw new Error("Invalid OJ authentication file");
      for (const record of Object.values(config.users) as any[]) {
        if (!record || typeof record.salt !== "string" || !/^(?:[a-f0-9]{2}){16,64}$/i.test(record.salt) || typeof record.hash !== "string" || !/^[a-f0-9]{64}$/i.test(record.hash)) throw new Error("Invalid OJ password verifier");
      }
      this.users = config.users; this.fingerprint = hash;
      this.sessions.clear();
    }
    this.loadedAt = now;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, session] of this.sessions) if (session.expires <= now) this.sessions.delete(key);
    for (const [key, failures] of this.failures) if (!failures.some(time => time > now - WINDOW)) this.failures.delete(key);
    this.attempts = this.attempts.filter(time => time > now - 60000);
  }

  async login(username: string, password: string, client: string): Promise<{ token: string; session: GatewaySession } | null> {
    this.load(); this.prune();
    const now = this.now();
    const recent = (this.failures.get(client) ?? []).filter(time => time > now - WINDOW);
    if (this.deriving >= 4 || this.attempts.length >= 64 || recent.length >= 8 || this.failures.size >= 2048 && !this.failures.has(client)) throw new Error("LOGIN_RATE_LIMIT");
    if (this.sessions.size >= 256) throw new Error("LOGIN_RATE_LIMIT");
    this.attempts.push(now);
    // Count in-flight attempts too, so concurrency cannot bypass the limit.
    recent.push(now); this.failures.set(client, recent); this.deriving++;
    const fingerprint = this.fingerprint;
    const record = (!this.allowedUsers || this.allowedUsers.includes(username)) && Object.hasOwn(this.users, username) ? this.users[username] : undefined;
    try {
      const actual = await derive(password, record ? Buffer.from(record.salt, "hex") : Buffer.from("argus-login-dummy-salt"), 600000, 32, "sha256");
      this.load();
      if (!record || fingerprint !== this.fingerprint || !timingSafeEqual(actual, Buffer.from(record.hash, "hex"))) return null;
      this.failures.delete(client);
      const token = randomBytes(32).toString("base64url"), id = this.digest(token);
      const session = { id, username, csrf: randomBytes(32).toString("hex"), expires: this.now() + this.ttl };
      this.sessions.set(id, session);
      return { token, session };
    } finally { this.deriving--; }
  }

  private digest(token: string): string { return createHash("sha256").update(token).digest("hex"); }
  resolve(token: string | null): GatewaySession | null {
    return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? this.resolveId(this.digest(token)) : null;
  }
  resolveId(id: string): GatewaySession | null {
    this.load();
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expires <= this.now()) { this.sessions.delete(id); return null; }
    return session;
  }
  revoke(id: string): void { this.sessions.delete(id); }
}
