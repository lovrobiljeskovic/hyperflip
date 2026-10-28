/** Self-rescheduling loop: the next run is scheduled whether or not this one threw. */
export function every(ms: number, fn: () => Promise<unknown>, onError: (err: unknown) => void, unref = false): void {
  const run = async () => {
    try {
      await fn();
    } catch (err) {
      onError(err);
    } finally {
      const t = setTimeout(run, ms);
      if (unref) t.unref();
    }
  };
  void run();
}

/** Retries fn every ms until it resolves once; each failure goes to onError, then nothing more is scheduled. */
export function retryUntil(ms: number, fn: () => Promise<unknown>, onError: (err: unknown) => void): void {
  const run = async () => {
    try {
      await fn();
    } catch (err) {
      onError(err);
      setTimeout(run, ms);
    }
  };
  void run();
}

export function isStalled(lastTickAt: number, now: number, thresholdMs: number): boolean {
  return now - lastTickAt > thresholdMs;
}

/** A hung await never throws but setInterval still fires: exit on a stale stamp so systemd restarts us. */
export function watchdog(
  stamps: Record<string, number>,
  thresholdMs: () => number,
  onStall: (name: string, staleMs: number, thresholdMs: number) => void,
  periodMs = 10_000,
): void {
  setInterval(() => {
    for (const [name, t] of Object.entries(stamps)) {
      const threshold = thresholdMs();
      if (isStalled(t, Date.now(), threshold)) {
        onStall(name, Date.now() - t, threshold);
        process.exit(1);
      }
    }
  }, periodMs);
}
