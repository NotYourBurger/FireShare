/** Most keys tracked at once; past this, keys whose window has ended are dropped. */
const MAX_KEYS = 10_000;

/**
 * Counts events per key in fixed windows, in memory. Each app process keeps
 * its own counts, and a restart clears them.
 */
export function createRateLimiter({
  limit,
  windowSeconds,
  now = () => new Date(),
}: {
  limit: number;
  windowSeconds: number;
  now?: () => Date;
}) {
  const windows = new Map<string, { count: number; resetAt: number }>();

  function current(key: string, at: number) {
    const window = windows.get(key);
    return window && window.resetAt > at ? window : undefined;
  }

  return {
    /** Seconds until `key` is allowed again, or 0 if it is now. */
    retryAfter(key: string): number {
      const at = now().getTime();
      const window = current(key, at);
      return window && window.count >= limit ? Math.ceil((window.resetAt - at) / 1000) : 0;
    },

    /** Counts one event for `key`. */
    hit(key: string) {
      const at = now().getTime();
      const window = current(key, at);
      if (window) {
        window.count++;
        return;
      }
      if (windows.size >= MAX_KEYS) {
        for (const [k, w] of windows) if (w.resetAt <= at) windows.delete(k);
      }
      windows.set(key, { count: 1, resetAt: at + windowSeconds * 1000 });
    },
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
