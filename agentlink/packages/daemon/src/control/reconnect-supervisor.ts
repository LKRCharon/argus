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

export type ReconnectStatus = {
  state: ReconnectState;
  attempt: number;
  generation: number;
  retryable: boolean;
  stage: string;
  errorCode?: "connect_failed" | "handshake_invalid" | "catalog_load_failed";
  nextRetryAt?: number;
  handshake?: Handshake;
};

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

const defaultSleep = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });

export class ReconnectSupervisor<Catalog> {
  private readonly options: Required<Omit<ReconnectSupervisorOptions<Catalog>, "connect" | "validateHandshake" | "onCatalogChanged" | "onStatusChanged">> &
    Pick<ReconnectSupervisorOptions<Catalog>, "connect" | "validateHandshake" | "onCatalogChanged" | "onStatusChanged">;
  private state: ReconnectState = "idle";
  private attempt = 0;
  private generation = 0;
  private status: ReconnectStatus = {
    state: "idle", attempt: 0, generation: 0, retryable: true, stage: "idle",
  };
  private loop: Promise<void> | undefined;
  private stopped = false;
  private runController: AbortController | undefined;
  private activeUpstream: ReconnectUpstream<Catalog> | undefined;
  private catalog: Catalog | undefined;
  private hasCatalog = false;
  private readyCallbacks = new Map<number, Set<(upstream: ReconnectUpstream<Catalog>) => void>>();
  private pendingReadyCallbacks = new Set<(upstream: ReconnectUpstream<Catalog>) => void>();

  constructor(options: ReconnectSupervisorOptions<Catalog>) {
    this.options = {
      ...options,
      random: options.random ?? Math.random,
      now: options.now ?? Date.now,
      sleep: options.sleep ?? defaultSleep,
    };
  }

  get currentStatus(): ReconnectStatus { return { ...this.status }; }
  get currentCatalog(): Catalog | undefined { return this.catalog; }

  start(): void {
    if (this.stopped) return;
    if (this.loop) return;
    this.loop = this.run().finally(() => { this.loop = undefined; });
  }

  stop(): Promise<void> {
    if (this.stopped) return this.loop ?? Promise.resolve();
    this.stopped = true;
    this.runController?.abort();
    this.publish({ state: "stopped", attempt: this.attempt, generation: this.generation,
      retryable: false, stage: "stopped" });
    const loop = this.loop;
    return (async () => {
      await loop;
      await this.closeActive();
    })();
  }

  close(): Promise<void> { return this.stop(); }

  withReadyUpstream(stage: string, callback: (upstream: ReconnectUpstream<Catalog>) => void): void {
    const upstream = this.activeUpstream;
    if (!upstream || this.state !== "ready") {
      this.pendingReadyCallbacks.add(callback);
      void stage;
      return;
    }
    this.invokeReadyCallback(callback, upstream, this.generation);
    void stage;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      this.runController = new AbortController();
      const signal = this.runController.signal;
      let stage = "connect";
      this.publish({ state: "connecting", attempt: this.attempt, generation: this.generation,
        retryable: true, stage: "connect" });
      let upstream: ReconnectUpstream<Catalog> | undefined;
      try {
        upstream = await this.options.connect(signal);
        if (signal.aborted || this.stopped) { await this.closeOnce(upstream); break; }
        stage = "handshake";
        this.publish({ state: "connecting", attempt: this.attempt, generation: this.generation,
          retryable: true, stage: "handshake", handshake: upstream.handshake });
        if (!this.options.validateHandshake(upstream.handshake)) {
          await this.closeOnce(upstream);
          this.publish({ state: "incompatible", attempt: this.attempt, generation: this.generation,
            retryable: false, stage: "handshake", errorCode: "handshake_invalid", handshake: upstream.handshake });
          break;
        }
        stage = "catalog";
        const catalog = await upstream.loadCatalog(signal);
        if (signal.aborted || this.stopped) { await this.closeOnce(upstream); break; }
        this.activeUpstream = upstream;
        this.generation++;
        this.attempt = 0;
        this.catalog = catalog;
        this.hasCatalog = true;
        this.publish({ state: "ready", attempt: 0, generation: this.generation,
          retryable: true, stage: "ready", handshake: upstream.handshake });
        this.safeCall(this.options.onCatalogChanged, catalog);
        const pending = this.pendingReadyCallbacks;
        this.pendingReadyCallbacks = new Set();
        for (const callback of pending) this.invokeReadyCallback(callback, upstream, this.generation);
        const generation = this.generation;
        let reconnecting = false;
        const unsubscribe = upstream.onClose(() => {
          if (reconnecting || this.stopped || this.activeUpstream !== upstream) return;
          reconnecting = true;
          this.runController?.abort();
        });
        await new Promise<void>((resolve) => {
          if (this.stopped || reconnecting) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        unsubscribe();
        if (this.activeUpstream === upstream) this.activeUpstream = undefined;
        await this.closeOnce(upstream);
        if (this.stopped) break;
        this.publish({ state: "backoff", attempt: this.attempt + 1, generation,
          retryable: true, stage: "closed" });
      } catch (error) {
        if (upstream) await this.closeOnce(upstream);
        if (this.stopped || signal.aborted) break;
        const errorCode = this.errorCode(error, upstream, stage);
        if (errorCode === "handshake_invalid") {
          this.publish({ state: "incompatible", attempt: this.attempt, generation: this.generation,
            retryable: false, stage: "handshake", errorCode });
          break;
        }
        this.attempt++;
        const exponential = Math.min(this.options.maxBackoffMs,
          this.options.baseBackoffMs * 2 ** Math.max(0, this.attempt - 1));
        const jitter = Math.max(0, Math.min(1, this.options.random()));
        const delay = Math.min(this.options.maxBackoffMs, exponential * jitter);
        const nextRetryAt = this.options.now() + delay;
        this.publish({ state: "backoff", attempt: this.attempt, generation: this.generation,
          retryable: true, stage: "backoff", errorCode, nextRetryAt });
        try { await this.options.sleep(delay, signal); } catch { break; }
      } finally { this.runController = undefined; }
    }
  }

  private errorCode(error: unknown, upstream: ReconnectUpstream<Catalog> | undefined, stage: string): ReconnectStatus["errorCode"] {
    if (upstream && !this.options.validateHandshake(upstream.handshake)) return "handshake_invalid";
    void error;
    return stage === "catalog" ? "catalog_load_failed" : "connect_failed";
  }

  private invokeReadyCallback(callback: (upstream: ReconnectUpstream<Catalog>) => void, upstream: ReconnectUpstream<Catalog>, generation: number): void {
    let callbacks = this.readyCallbacks.get(generation);
    if (!callbacks) this.readyCallbacks.set(generation, callbacks = new Set());
    if (callbacks.has(callback)) return;
    callbacks.add(callback);
    try { callback(upstream); } catch { /* consumer failures must not affect supervision */ }
  }

  private publish(status: ReconnectStatus): void {
    this.status = status;
    this.state = status.state;
    this.safeCall(this.options.onStatusChanged, { ...status });
  }

  private safeCall<T>(callback: ((value: T) => void) | undefined, value: T): void {
    try { callback?.(value); } catch { /* observers are isolated from the loop */ }
  }

  private async closeActive(): Promise<void> {
    const upstream = this.activeUpstream;
    this.activeUpstream = undefined;
    if (upstream) await this.closeOnce(upstream);
  }

  private async closeOnce(upstream: ReconnectUpstream<Catalog>): Promise<void> {
    const marker = upstream as ReconnectUpstream<Catalog> & { __reconnectClosed?: boolean };
    if (marker.__reconnectClosed) return;
    marker.__reconnectClosed = true;
    try { await upstream.close(); } catch { /* shutdown errors are deliberately hidden */ }
  }
}
