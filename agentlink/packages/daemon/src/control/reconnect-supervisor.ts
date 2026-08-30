export type ReconnectState = "idle" | "connecting" | "ready" | "backoff" | "incompatible" | "stopped";

export type Handshake = { name: string; version: string; protocolVersion: string };
export type ReconnectErrorCode = "connect_failed" | "handshake_invalid" | "catalog_load_failed";
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
  if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
  const timer = setTimeout(done, milliseconds);
  const onAbort = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    reject(new DOMException("Aborted", "AbortError"));
  };
  function done() { signal.removeEventListener("abort", onAbort); resolve(); }
  signal.addEventListener("abort", onAbort, { once: true });
});

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
  private status: ReconnectStatus = { state: "idle", attempt: 0, generation: 0, retryable: true, stage: "idle" };
  private loop: Promise<void> | undefined;
  private stopped = false;
  private runController: AbortController | undefined;
  private activeGeneration: Generation<Catalog> | undefined;
  private catalog: Catalog | undefined;
  private readonly closedUpstreams = new WeakSet<object>();

  constructor(options: ReconnectSupervisorOptions<Catalog>) {
    this.options = { ...options, random: options.random ?? Math.random, now: options.now ?? Date.now, sleep: options.sleep ?? defaultSleep };
  }
  get currentStatus(): ReconnectStatus { return { ...this.status }; }
  get currentCatalog(): Catalog | undefined { return this.catalog; }
  start(): void {
    if (this.stopped || this.loop) return;
    this.loop = this.run().finally(() => { this.loop = undefined; });
  }
  stop(): Promise<void> {
    if (this.stopped) return this.loop ?? Promise.resolve();
    this.stopped = true;
    this.runController?.abort();
    this.publish({ state: "stopped", attempt: this.attempt, generation: this.generation, retryable: false, stage: "stopped" });
    const loop = this.loop;
    return (async () => { await loop; await this.closeActive(); })();
  }
  close(): Promise<void> { return this.stop(); }

  withReadyUpstream(stage: string, callback: (upstream: ReconnectUpstream<Catalog>) => void): ReadyUpstreamResult {
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
        this.publish({ state: "connecting", attempt: this.attempt, generation: this.generation, retryable: true, stage });
        upstream = await this.options.connect(signal);
        if (signal.aborted || this.stopped) { await this.closeOnce(upstream); break; }
        stage = "handshake";
        this.publish({ state: "connecting", attempt: this.attempt, generation: this.generation, retryable: true, stage, handshake: upstream.handshake });
        let compatible = false;
        try { compatible = this.options.validateHandshake(upstream.handshake); } catch { compatible = false; }
        if (!compatible) {
          await this.closeOnce(upstream);
          this.publish({ state: "incompatible", attempt: this.attempt, generation: this.generation, retryable: false, stage, errorCode: "handshake_invalid", handshake: upstream.handshake });
          break;
        }
        stage = "catalog";
        const catalog = await upstream.loadCatalog(signal);
        if (signal.aborted || this.stopped) { await this.closeOnce(upstream); break; }

        const current: Generation<Catalog> = { upstream, number: this.generation + 1, closed: false };
        this.activeGeneration = current;
        this.generation = current.number;
        this.attempt = 0;
        this.catalog = catalog;
        let closeNotified = false;
        let releaseGenerationWait: (() => void) | undefined;
        const notifyClose = () => {
          if (closeNotified || current.closed) return;
          closeNotified = true;
          current.closed = true;
          if (this.activeGeneration === current) this.activeGeneration = undefined;
          releaseGenerationWait?.();
        };
        current.unsubscribe = upstream.onClose(notifyClose);
        if (current.closed || signal.aborted || this.stopped) {
          await this.endGeneration(current);
          if (this.stopped) break;
          await this.backoff("closed");
          continue;
        }

        // State is committed before observers run, so catalog and status are coherent.
        this.publish({ state: "ready", attempt: 0, generation: current.number, retryable: true, stage: "ready", handshake: upstream.handshake });
        this.safeCall(this.options.onCatalogChanged, catalog);
        let onGenerationAbort: (() => void) | undefined;
        await new Promise<void>(resolve => {
          if (this.stopped || current.closed || signal.aborted) return resolve();
          releaseGenerationWait = resolve;
          onGenerationAbort = resolve;
          signal.addEventListener("abort", onGenerationAbort, { once: true });
        });
        if (onGenerationAbort) signal.removeEventListener("abort", onGenerationAbort);
        releaseGenerationWait = undefined;
        await this.endGeneration(current);
        if (this.stopped) break;
        await this.backoff("closed");
      } catch {
        if (upstream) await this.closeOnce(upstream);
        if (this.stopped || signal.aborted) break;
        const errorCode = this.errorCode(upstream, stage);
        if (errorCode === "handshake_invalid") {
          this.publish({ state: "incompatible", attempt: this.attempt, generation: this.generation, retryable: false, stage: "handshake", errorCode });
          break;
        }
        await this.backoff(stage === "catalog" ? "catalog" : "backoff", errorCode);
      } finally { this.runController = undefined; }
    }
  }

  private async backoff(stage: string, errorCode?: ReconnectErrorCode): Promise<void> {
    this.attempt++;
    const exponential = Math.min(this.options.maxBackoffMs, this.options.baseBackoffMs * 2 ** Math.max(0, this.attempt - 1));
    let jitter = 0;
    try { jitter = this.options.random(); } catch { jitter = 0; }
    jitter = Math.max(0, Math.min(1, Number.isFinite(jitter) ? jitter : 0));
    const delay = Math.min(this.options.maxBackoffMs, exponential * jitter);
    this.publish({ state: "backoff", attempt: this.attempt, generation: this.generation, retryable: true, stage, errorCode, nextRetryAt: this.options.now() + delay });
    const signal = this.runController?.signal;
    if (!signal) return;
    try { await this.options.sleep(delay, signal); } catch { /* stop aborts the configured sleep */ }
  }

  private errorCode(upstream: ReconnectUpstream<Catalog> | undefined, stage: string): ReconnectErrorCode {
    if (upstream) {
      try { if (!this.options.validateHandshake(upstream.handshake)) return "handshake_invalid"; } catch { return "handshake_invalid"; }
    }
    return stage === "catalog" ? "catalog_load_failed" : "connect_failed";
  }
  private publish(status: ReconnectStatus): void {
    this.status = status;
    this.state = status.state;
    this.safeCall(this.options.onStatusChanged, { ...status });
  }
  private safeCall<T>(callback: ((value: T) => void) | undefined, value: T): void {
    try { callback?.(value); } catch { /* consumer failures do not affect supervision */ }
  }
  private async endGeneration(generation: Generation<Catalog>): Promise<void> {
    generation.closed = true;
    if (this.activeGeneration === generation) this.activeGeneration = undefined;
    const unsubscribe = generation.unsubscribe;
    generation.unsubscribe = undefined;
    try { unsubscribe?.(); } catch { /* cleanup failures are deliberately hidden */ }
    await this.closeOnce(generation.upstream);
  }
  private async closeActive(): Promise<void> {
    const generation = this.activeGeneration;
    if (generation) await this.endGeneration(generation);
  }
  private async closeOnce(upstream: ReconnectUpstream<Catalog>): Promise<void> {
    if (this.closedUpstreams.has(upstream)) return;
    this.closedUpstreams.add(upstream);
    try { await upstream.close(); } catch { /* shutdown errors are deliberately hidden */ }
  }
}
