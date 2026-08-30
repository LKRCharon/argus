export type ReconnectState =
  | "idle"
  | "connecting"
  | "ready"
  | "backoff"
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

export type ReconnectSupervisorOptions<Catalog> = {
  connect(signal: AbortSignal): ReconnectUpstream<Catalog> | Promise<ReconnectUpstream<Catalog>>;
  validateHandshake(handshake: Handshake): boolean;
  baseBackoffMs: number;
  maxBackoffMs: number;
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

type Generation<Catalog> = {
  upstream: ReconnectUpstream<Catalog>;
  number: number;
  closed: boolean;
  unsubscribe?: () => void;
};

export class ReconnectSupervisor<Catalog> {
  private readonly options: Required<Omit<ReconnectSupervisorOptions<Catalog>, "connect" | "validateHandshake" | "onCatalogChanged" | "onStatusChanged">> &
    Pick<ReconnectSupervisorOptions<Catalog>, "connect" | "validateHandshake" | "onCatalogChanged" | "onStatusChanged">;
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
  private stopPromise: Promise<void> | undefined;
  private stopped = false;
  private runController: AbortController | undefined;
  private activeGeneration: Generation<Catalog> | undefined;
  private catalog: Catalog | undefined;
  private readonly closedUpstreams = new WeakSet<object>();

  constructor(options: ReconnectSupervisorOptions<Catalog>) {
    this.options = {
      ...options,
      random: options.random ?? Math.random,
      now: options.now ?? Date.now,
      sleep: options.sleep ?? defaultSleep,
    };
  }

  get currentStatus(): ReconnectStatus {
    return { ...this.status };
  }

  get currentCatalog(): Catalog | undefined {
    return this.catalog;
  }

  start(): void {
    if (this.stopped || this.loop) return;
    const runPromise = Promise.resolve().then(() => this.run());
    this.loop = runPromise.finally(() => {
      this.loop = undefined;
    });
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;

    let resolveStop!: () => void;
    this.stopPromise = new Promise<void>(resolve => {
      resolveStop = resolve;
    });
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
        await this.closeActive();
      } finally {
        resolveStop();
      }
    })();
    return this.stopPromise;
  }

  close(): Promise<void> {
    return this.stop();
  }

  withReadyUpstream(
    stage: string,
    callback: (upstream: ReconnectUpstream<Catalog>) => void,
  ): ReadyUpstreamResult {
    void stage;
    const generation = this.activeGeneration;
    if (!generation || generation.closed || this.state !== "ready") {
      return { ok: false, errorCode: this.stopped ? "stopped" : "not_ready" };
    }
    this.safeCall(callback, generation.upstream);
    return { ok: true, generation: generation.number };
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      this.runController = new AbortController();
      const signal = this.runController.signal;
      let stage = "connect";
      let upstream: ReconnectUpstream<Catalog> | undefined;
      try {
        this.publish({
          state: "connecting",
          attempt: this.attempt,
          generation: this.generation,
          retryable: true,
          stage,
        });
        upstream = await this.options.connect(signal);
        if (signal.aborted || this.stopped) {
          await this.closeOnce(upstream);
          break;
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
        let validHandshake = false;
        try {
          validHandshake = this.options.validateHandshake(upstream.handshake);
        } catch {
          validHandshake = false;
        }
        if (!validHandshake) {
          await this.closeOnce(upstream);
          this.publish({
            state: "incompatible",
            attempt: this.attempt,
            generation: this.generation,
            retryable: false,
            stage,
            errorCode: "handshake_invalid",
          });
          break;
        }

        stage = "catalog";
        const candidateCatalog = await upstream.loadCatalog(signal);
        if (signal.aborted || this.stopped) {
          await this.closeOnce(upstream);
          break;
        }

        const candidate: Generation<Catalog> = {
          upstream,
          number: this.generation + 1,
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
          if (this.stopped || signal.aborted) break;
          if (!(await this.backoff("catalog", "catalog_load_failed"))) break;
          continue;
        }

        if (candidate.closed || signal.aborted || this.stopped) {
          await this.endGeneration(candidate);
          if (this.stopped) break;
          if (!(await this.backoff("closed"))) break;
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
          this.stopped ||
          candidate.closed ||
          this.activeGeneration !== candidate ||
          this.state !== "ready"
        ) {
          await this.endGeneration(candidate);
          if (this.stopped) break;
          if (!(await this.backoff("closed"))) break;
          continue;
        }
        this.safeCall(this.options.onCatalogChanged, candidateCatalog);

        let onGenerationAbort: (() => void) | undefined;
        await new Promise<void>(resolve => {
          if (this.stopped || candidate.closed || signal.aborted) {
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
        if (this.stopped) break;
        if (!(await this.backoff("closed"))) break;
      } catch {
        if (upstream) await this.closeOnce(upstream);
        if (this.stopped || signal.aborted) break;
        if (!(await this.backoff(stage === "catalog" ? "catalog" : "backoff", stage === "catalog" ? "catalog_load_failed" : "connect_failed"))) break;
      } finally {
        this.runController = undefined;
      }
    }
  }

  private async backoff(stage: string, errorCode?: ReconnectErrorCode): Promise<boolean> {
    this.attempt++;
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
    this.publish({
      state: "backoff",
      attempt: this.attempt,
      generation: this.generation,
      retryable: true,
      stage,
      errorCode,
      nextRetryAt: this.options.now() + delay,
    });
    const signal = this.runController?.signal;
    if (!signal) return true;
    try {
      await this.options.sleep(delay, signal);
      return true;
    } catch {
      if (this.stopped || signal.aborted) return true;
      this.publish({
        state: "backoff",
        attempt: this.attempt,
        generation: this.generation,
        retryable: false,
        stage: "backoff",
        errorCode: "sleep_failed",
      });
      return false;
    }
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

  private async endGeneration(generation: Generation<Catalog>): Promise<void> {
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

  private async closeActive(): Promise<void> {
    const generation = this.activeGeneration;
    if (generation) await this.endGeneration(generation);
  }

  private async closeOnce(upstream: ReconnectUpstream<Catalog>): Promise<void> {
    if (this.closedUpstreams.has(upstream)) return;
    this.closedUpstreams.add(upstream);
    try {
      await upstream.close();
    } catch {
      // Shutdown errors are deliberately hidden.
    }
  }
}
