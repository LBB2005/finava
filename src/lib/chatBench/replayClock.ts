/**
 * Chat replay bench (dev only): replay time. It runs at `speed` × real time,
 * can pause, and wakes sleepers when replay time reaches their target, so a
 * recorded stream plays back at its own pace, or 4× faster, or frozen.
 */
export class ReplayClock {
  private base = 0;
  /** Real time the current running stretch began; null while paused. */
  private runningSince: number | null = null;
  private _speed: number;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();

  constructor(opts: { speed?: number; now?: () => number } = {}) {
    this._speed = opts.speed ?? 1;
    this.now = opts.now ?? (() => performance.now());
  }

  get speed(): number {
    return this._speed;
  }

  get paused(): boolean {
    return this.runningSince == null;
  }

  /** Replay ms since the first play(). */
  elapsed(): number {
    return this.base + (this.runningSince == null ? 0 : (this.now() - this.runningSince) * this._speed);
  }

  play(): void {
    if (this.runningSince != null) return;
    this.runningSince = this.now();
    this.changed();
  }

  pause(): void {
    if (this.runningSince == null) return;
    this.base = this.elapsed();
    this.runningSince = null;
    this.changed();
  }

  setSpeed(speed: number): void {
    this.base = this.elapsed();
    if (this.runningSince != null) this.runningSince = this.now();
    this._speed = speed;
    this.changed();
  }

  /** Resolves once replay time reaches `target` ms. Rejects with an AbortError if `signal` aborts. */
  sleepUntil(target: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
        signal?.removeEventListener("abort", check);
      };
      const check = () => {
        if (signal?.aborted) {
          done();
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        const remaining = target - this.elapsed();
        if (remaining <= 0) {
          done();
          resolve();
          return;
        }
        clearTimeout(timer);
        if (!this.paused) timer = setTimeout(check, remaining / this._speed);
      };
      this.listeners.add(check);
      signal?.addEventListener("abort", check);
      check();
    });
  }

  private changed() {
    for (const l of [...this.listeners]) l();
  }
}
