export type ReconnectState =
  | "idle"
  | "connecting"
  | "ready"
  | "backoff"
  | "failed"
  | "incompatible"
  | "stopped";

export type Handshake = {
  name: string;
  version: string;
  protocolVersion: string;
};

export type ReconnectErrorCode =
  | "connect_failed"
  | "handshake_invalid"
  | "catalog_load_failed"
  | "retry_exhausted"
  | "retry_failed"
  | "sleep_failed";

export type ReconnectStatus = {
  state: ReconnectState;
  attempt: number;
  generation: number;
  retryable: boolean;
  stage: string;
  errorCode?: ReconnectErrorCode;
  nextRetryAt?: number;
  handshake?: Handshake;
};

export type ReadyUpstreamResult =
  | { ok: true; generation: number }
  | { ok: false; errorCode: "not_ready" | "stopped" };

export type ReconnectUpstream<Catalog> = {
  handshake: Handshake;
  loadCatalog(signal: AbortSignal): Promise<Catalog>;
  close(): void | Promise<void>;
  onClose(callback: () => void): () => void;
};

export type ReconnectSupervisorOptions<
  Catalog,
  Upstream extends ReconnectUpstream<Catalog> = ReconnectUpstream<Catalog>,
> = {
  connect(signal: AbortSignal): Upstream | Promise<Upstream>;
  validateHandshake(handshake: Handshake): boolean;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Maximum connection attempts before entering the terminal failed state. */
  maxAttempts?: number;
  random?: () => number;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onCatalogChanged?: (catalog: Catalog) => void;
  onStatusChanged?: (status: ReconnectStatus) => void;
};

const defaultSleep = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) {
    reject(new DOMException("Aborted", "AbortError"));
    return;
  }
  const timer = setTimeout(onTimer, milliseconds);
  const onAbort = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    reject(new DOMException("Aborted", "AbortError"));
  };
  function onTimer() {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }
  signal.addEventListener("abort", onAbort, { once: true });
});

// Internal export keeps the platform sleep primitive directly testable.
export const __defaultReconnectSleep = defaultSleep;

type Generation<Catalog, Upstream extends ReconnectUpstream<Catalog>> = {
  upstream: Upstream;
  number: number;
  owner: number;
  closed: boolean;
  unsubscribe?: () => void;
};

type ResolvedReconnectSupervisorOptions<
  Catalog,
  Upstream extends ReconnectUpstream<Catalog>,
> = Omit<ReconnectSupervisorOptions<Catalog, Upstream>, "random" | "now" | "sleep"> & {
  random: () => number;
  now: () => number;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  maxAttempts: number;
};

export class ReconnectSupervisor<Catalog, Upstream extends ReconnectUpstream<Catalog> = ReconnectUpstream<Catalog>> {
  private readonly options: ResolvedReconnectSupervisorOptions<Catalog, Upstream>;
  private state: ReconnectState = "idle";
  private attempt = 0;
  private generation = 0;
  private status: ReconnectStatus = {
    state: "idle",
    attempt: 0,
    generation: 0,
    retryable: true,
    stage: "idle",
  };
  private loop: Promise<void> | undefined;
  private loopOwner: number | undefined;
  private stopPromise: Promise<void> | undefined;
  private stopInProgress = false;
  private startAfterStop = false;
  private stopped = false;
  private lifecycle = 0;
  private runController: AbortController | undefined;
  private activeGeneration: Generation<Catalog, Upstream> | undefined;
  private catalog: Catalog | undefined;
  private readonly closedUpstreams = new WeakSet<object>();

  constructor(options: ReconnectSupervisorOptions<Catalog, Upstream>) {
    this.options = {
      ...options,
      random: options.random ?? Math.random,
      now: options.now ?? Date.now,
      sleep: options.sleep ?? defaultSleep,
      maxAttempts: boundedMaxAttempts(options.maxAttempts),
    };
  }

  get currentStatus(): ReconnectStatus {
    return { ...this.status };
  }

  get currentCatalog(): Catalog | undefined {
    return this.catalog;
  }

  start(): void {
    if (this.stopInProgress) {
      this.startAfterStop = true;
      return;
    }
    if (this.loop) return;
    if (this.stopPromise) {
      this.stopPromise = undefined;
    }
    this.stopped = false;
    this.attempt = 0;
    const owner = ++this.lifecycle;
    const runPromise = Promise.resolve().then(() => this.run(owner));
    let trackedLoop!: Promise<void>;
    trackedLoop = runPromise.finally(() => {
      if (this.loop === trackedLoop && this.loopOwner === owner) {
        this.loop = undefined;
        this.loopOwner = undefined;
      }
    });
    this.loop = trackedLoop;
    this.loopOwner = owner;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;

    let resolveStop!: () => void;
    const stopPromise = new Promise<void>(resolve => {
      resolveStop = resolve;
    });
    this.stopPromise = stopPromise;
    this.stopInProgress = true;
    const owner = this.lifecycle;
    this.lifecycle++;
    this.stopped = true;
    this.runController?.abort();
    this.publish({
      state: "stopped",
      attempt: this.attempt,
      generation: this.generation,
      retryable: false,
      stage: "stopped",
    });
    const loop = this.loop;
    void (async () => {
      try {
        await loop;
      } catch {
        // Shutdown must still close the active generation after an unexpected loop failure.
      }
      try {
        await this.closeActive(owner);
      } finally {
        if (this.stopPromise === stopPromise) {
          this.stopInProgress = false;
          if (this.startAfterStop) {
            this.startAfterStop = false;
            this.stopPromise = undefined;
            this.start();
          }
        }
        resolveStop();
      }
    })();
    return stopPromise;
  }

  close(): Promise<void> {
    return this.stop();
  }

  withReadyUpstream(
    stage: string,
    callback: (upstream: Upstream) => void,
  ): ReadyUpstreamResult {
    void stage;
    const generation = this.activeGeneration;
    if (!generation || generation.closed || this.state !== "ready") {
      return { ok: false, errorCode: this.stopped ? "stopped" : "not_ready" };
    }
    this.safeCall(callback, generation.upstream);
    return { ok: true, generation: generation.number };
  }

  private async run(owner: number): Promise<void> {
    while (this.isOwner(owner)) {
      const controller = new AbortController();
      this.runController = controller;
      const signal = controller.signal;
      let stage = "connect";
      let upstream: Upstream | undefined;
      try {
        if (!this.isOwner(owner)) return;
        this.publish({
          state: "connecting",
          attempt: this.attempt,
          generation: this.generation,
          retryable: true,
          stage,
        });
        upstream = await this.options.connect(signal);
        if (!this.isOwner(owner) || signal.aborted) {
          await this.closeOnce(upstream);
          return;
        }

        stage = "handshake";
        this.publish({
          state: "connecting",
          attempt: this.attempt,
          generation: this.generation,
          retryable: true,
          stage,
          handshake: upstream.handshake,
        });
        if (!this.isOwner(owner) || signal.aborted) {
          await this.closeOnce(upstream);
          return;
        }
        let validHandshake = false;
        try {
          validHandshake = this.options.validateHandshake(upstream.handshake);
        } catch {
          validHandshake = false;
        }
        if (!validHandshake) {
          await this.closeOnce(upstream);
          if (!this.isOwner(owner) || signal.aborted) return;
          this.publish({
            state: "incompatible",
            attempt: this.attempt,
            generation: this.generation,
            retryable: false,
            stage,
            errorCode: "handshake_invalid",
          });
          return;
        }
        if (!this.isOwner(owner) || signal.aborted) {
          await this.closeOnce(upstream);
          return;
        }

        stage = "catalog";
        const candidateCatalog = await upstream.loadCatalog(signal);
        if (!this.isOwner(owner) || signal.aborted) {
          await this.closeOnce(upstream);
          return;
        }

        const candidate: Generation<Catalog, Upstream> = {
          upstream,
          number: this.generation + 1,
          owner,
          closed: false,
        };
        let closeNotified = false;
        let releaseGenerationWait: (() => void) | undefined;
        const notifyClose = () => {
          if (closeNotified || candidate.closed) return;
          closeNotified = true;
          candidate.closed = true;
          if (this.activeGeneration === candidate) this.activeGeneration = undefined;
          releaseGenerationWait?.();
        };

        try {
          candidate.unsubscribe = upstream.onClose(notifyClose);
        } catch {
          await this.closeOnce(upstream);
          if (!this.isOwner(owner) || signal.aborted) return;
          if (!(await this.backoff(owner, "catalog", "catalog_load_failed"))) return;
          continue;
        }

        if (candidate.closed || signal.aborted || !this.isOwner(owner)) {
          await this.endGeneration(candidate);
          if (!this.isOwner(owner)) return;
          if (!(await this.backoff(owner, "closed"))) return;
          continue;
        }

        // Commit catalog, active generation, generation, and attempt together.
        this.activeGeneration = candidate;
        this.generation = candidate.number;
        this.attempt = 0;
        this.catalog = candidateCatalog;
        this.publish({
          state: "ready",
          attempt: 0,
          generation: candidate.number,
          retryable: true,
          stage: "ready",
          handshake: upstream.handshake,
        });

        // A ready observer may synchronously stop or invalidate this generation.
        if (
          !this.isOwner(owner) ||
          candidate.closed ||
          this.activeGeneration !== candidate ||
          this.state !== "ready"
        ) {
          await this.endGeneration(candidate);
          if (!this.isOwner(owner)) return;
          if (!(await this.backoff(owner, "closed"))) return;
          continue;
        }
        this.safeCall(this.options.onCatalogChanged, candidateCatalog);

        let onGenerationAbort: (() => void) | undefined;
        await new Promise<void>(resolve => {
          if (!this.isOwner(owner) || candidate.closed || signal.aborted) {
            resolve();
            return;
          }
          releaseGenerationWait = resolve;
          onGenerationAbort = resolve;
          signal.addEventListener("abort", onGenerationAbort, { once: true });
        });
        if (onGenerationAbort) signal.removeEventListener("abort", onGenerationAbort);
        releaseGenerationWait = undefined;
        await this.endGeneration(candidate);
        if (!this.isOwner(owner)) return;
        if (!(await this.backoff(owner, "closed"))) return;
      } catch {
        if (upstream) await this.closeOnce(upstream);
        if (!this.isOwner(owner) || signal.aborted) return;
        if (!(await this.backoff(owner, stage === "catalog" ? "catalog" : "backoff", stage === "catalog" ? "catalog_load_failed" : "connect_failed"))) return;
      } finally {
        if (this.runController === controller) this.runController = undefined;
      }
    }
  }

  private async backoff(owner: number, stage: string, errorCode?: ReconnectErrorCode): Promise<boolean> {
    if (!this.isOwner(owner)) return false;
    this.attempt++;
    if (this.attempt >= this.options.maxAttempts) {
      this.publish({
        state: "failed",
        attempt: this.attempt,
        generation: this.generation,
        retryable: false,
        stage,
        errorCode: "retry_exhausted",
      });
      return false;
    }
    const exponential = Math.min(
      this.options.maxBackoffMs,
      this.options.baseBackoffMs * 2 ** Math.max(0, this.attempt - 1),
    );
    let jitter = 0;
    try {
      jitter = this.options.random();
    } catch {
      jitter = 0;
    }
    jitter = Math.max(0, Math.min(1, Number.isFinite(jitter) ? jitter : 0));
    const delay = Math.min(this.options.maxBackoffMs, exponential * jitter);
    let nextRetryAt: number;
    try {
      nextRetryAt = this.options.now() + delay;
    } catch {
      this.publish({
        state: "failed",
        attempt: this.attempt,
        generation: this.generation,
        retryable: false,
        stage: "backoff",
        errorCode: "retry_failed",
      });
      return false;
    }
    if (!this.isOwner(owner)) return false;
    this.publish({
      state: "backoff",
      attempt: this.attempt,
      generation: this.generation,
      retryable: true,
      stage,
      errorCode,
      nextRetryAt,
    });
    const signal = this.runController?.signal;
    if (!signal || !this.isOwner(owner)) {
      if (this.isOwner(owner)) {
        this.publish({
          state: "failed",
          attempt: this.attempt,
          generation: this.generation,
          retryable: false,
          stage: "backoff",
          errorCode: "retry_failed",
        });
      }
      return false;
    }
    try {
      await this.options.sleep(delay, signal);
      if (!this.isOwner(owner) || signal.aborted) return false;
      return true;
    } catch {
      if (!this.isOwner(owner) || signal.aborted) return false;
      this.publish({
        state: "failed",
        attempt: this.attempt,
        generation: this.generation,
        retryable: false,
        stage: "backoff",
        errorCode: "sleep_failed",
      });
      return false;
    }
  }

  private isOwner(owner: number): boolean {
    return !this.stopped && this.lifecycle === owner;
  }

  private publish(status: ReconnectStatus): void {
    this.status = status;
    this.state = status.state;
    this.safeCall(this.options.onStatusChanged, { ...status });
  }

  private safeCall<T>(callback: ((value: T) => void) | undefined, value: T): void {
    try {
      callback?.(value);
    } catch {
      // Observer and operation failures must not affect supervision.
    }
  }

  private async endGeneration(generation: Generation<Catalog, Upstream>): Promise<void> {
    generation.closed = true;
    if (this.activeGeneration === generation) this.activeGeneration = undefined;
    const unsubscribe = generation.unsubscribe;
    generation.unsubscribe = undefined;
    try {
      unsubscribe?.();
    } catch {
      // Cleanup failures are deliberately hidden.
    }
    await this.closeOnce(generation.upstream);
  }

  private async closeActive(owner?: number): Promise<void> {
    const generation = this.activeGeneration;
    if (generation && (owner === undefined || generation.owner === owner)) {
      await this.endGeneration(generation);
    }
  }

  private async closeOnce(upstream: Upstream): Promise<void> {
    if (this.closedUpstreams.has(upstream)) return;
    this.closedUpstreams.add(upstream);
    try {
      await upstream.close();
    } catch {
      // Shutdown errors are deliberately hidden.
    }
  }
}

function boundedMaxAttempts(value: number | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("maxAttempts must be a positive integer");
  }
  return value;
}
