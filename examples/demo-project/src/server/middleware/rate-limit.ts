import type { RateLimit } from "../config";
import { HttpError } from "../http";

interface Window {
  startedAt: number;
  count: number;
}

export interface RateLimiter {
  /** Throws a 429 `HttpError` when the client exceeded the group's limit. */
  check(group: string, request: Request): void;
}

/**
 * Fixed-window limiter keyed by group and client address. It is intentionally
 * simple: Orbit runs as a single process, so in-memory counters are accurate.
 */
export function createRateLimiter(
  limits: Record<string, RateLimit>,
  now: () => number = Date.now,
): RateLimiter {
  const windows = new Map<string, Window>();

  return {
    check(group, request) {
      const limit = limits[group];
      if (!limit) return;
      const client = request.headers.get("x-forwarded-for") ?? "local";
      const key = `${group}:${client}`;
      const windowMs = limit.windowSeconds * 1000;
      const current = windows.get(key);
      const time = now();

      if (!current || time - current.startedAt >= windowMs) {
        windows.set(key, { startedAt: time, count: 1 });
        return;
      }
      current.count += 1;
      if (current.count > limit.limit) {
        const retryAfter = Math.ceil((current.startedAt + windowMs - time) / 1000);
        throw new HttpError(429, "rate_limited", `Too many ${group} requests`, {
          "retry-after": String(retryAfter),
        });
      }
    },
  };
}
