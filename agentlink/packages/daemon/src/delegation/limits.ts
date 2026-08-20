import { DelegationSafeIdSchema } from "./schemas";

export interface DelegationLimiterOptions {
  windowMs?: number;
  maxRequests?: number;
  maxActive?: number;
  now?: () => number;
}

export interface DelegationLimitPermit {
  readonly principalId: string;
  release(): void;
}

export type DelegationLimitDecision =
  | {
    allowed: true;
    active: number;
    remaining: number;
    permit: DelegationLimitPermit;
  }
  | {
    allowed: false;
    reason: "rate-limit" | "max-active";
    active: number;
    remaining: number;
    retryAfterMs?: number;
  };

interface PrincipalWindow {
  starts: number[];
  active: number;
}

/** Process-local admission control; durable job state remains in the journal. */
export class DelegationRequestLimiter {
  private readonly states = new Map<string, PrincipalWindow>();
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly maxActive: number;
  private readonly now: () => number;

  constructor(options: DelegationLimiterOptions = {}) {
    this.windowMs = positiveInteger(options.windowMs ?? 60_000, "windowMs");
    this.maxRequests = positiveInteger(options.maxRequests ?? 30, "maxRequests");
    this.maxActive = positiveInteger(options.maxActive ?? 2, "maxActive");
    this.now = options.now ?? Date.now;
  }

  tryStart(principalIdInput: string): DelegationLimitDecision {
    const principalId = DelegationSafeIdSchema.parse(principalIdInput);
    const now = this.now();
    const state = this.states.get(principalId) ?? { starts: [], active: 0 };
    this.prune(state, now);

    if (state.active >= this.maxActive) {
      this.states.set(principalId, state);
      return {
        allowed: false,
        reason: "max-active",
        active: state.active,
        remaining: Math.max(0, this.maxRequests - state.starts.length),
      };
    }

    if (state.starts.length >= this.maxRequests) {
      this.states.set(principalId, state);
      const oldest = state.starts[0]!;
      return {
        allowed: false,
        reason: "rate-limit",
        active: state.active,
        remaining: 0,
        retryAfterMs: Math.max(1, oldest + this.windowMs - now),
      };
    }

    state.starts.push(now);
    state.active += 1;
    this.states.set(principalId, state);
    let released = false;
    const permit: DelegationLimitPermit = {
      principalId,
      release: () => {
        if (released) return;
        released = true;
        const current = this.states.get(principalId);
        if (!current) return;
        current.active = Math.max(0, current.active - 1);
        this.prune(current, this.now());
        if (current.active === 0 && current.starts.length === 0) this.states.delete(principalId);
      },
    };
    return {
      allowed: true,
      active: state.active,
      remaining: Math.max(0, this.maxRequests - state.starts.length),
      permit,
    };
  }

  snapshot(principalIdInput: string): { active: number; requestsInWindow: number } {
    const principalId = DelegationSafeIdSchema.parse(principalIdInput);
    const state = this.states.get(principalId);
    if (!state) return { active: 0, requestsInWindow: 0 };
    this.prune(state, this.now());
    if (state.active === 0 && state.starts.length === 0) this.states.delete(principalId);
    return { active: state.active, requestsInWindow: state.starts.length };
  }

  private prune(state: PrincipalWindow, now: number): void {
    const cutoff = now - this.windowMs;
    let firstLive = 0;
    while (firstLive < state.starts.length && state.starts[firstLive]! <= cutoff) firstLive += 1;
    if (firstLive > 0) state.starts.splice(0, firstLive);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
