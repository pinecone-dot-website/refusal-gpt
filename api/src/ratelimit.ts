/**
 * Rate limiting, in memory.
 *
 * No Redis: the droplet has ~350 MB free and five other Node processes. An
 * in-process limiter is correct for a single-instance service and costs nothing.
 * It resets on restart — acceptable, because a restart is not a thing a caller
 * can trigger.
 *
 * The limits mean different things and are charged at different moments:
 *
 *   per-minute — ABUSE protection. Charged on every request, including ones
 *                that fail validation. Cheap to serve, but a flood is a flood.
 *   per-day    — COST protection. Charged only when a GPU call is actually
 *                made. A client with a bug sending malformed requests should
 *                not burn its budget without ever reaching the model.
 *   global/day — the ACTUAL cost ceiling for the anonymous demo. Per-IP limits
 *                assume IPs are scarce. They are not. This is the number that
 *                decides what a bad day can cost, and when it trips the demo
 *                keeps working on canned lines rather than going down.
 *
 * A distress hit never reaches the model, so it is never charged a GPU call.
 * Being rate-limited also never suppresses one — see index.ts.
 */
import { config } from "./config.js";

type Window = { count: number; resetAt: number };
type Bucket = { minute: Window; day: Window };

const buckets = new Map<string, Bucket>();

/**
 * Pooled daily budgets, by name.
 *
 *   demo       — every anonymous /api/chat caller combined
 *   self-serve — every console-minted /v1 key combined
 *
 * Separate pools on purpose: a flood of self-serve keys must not be able to
 * starve the landing-page demo, which is the thing a visitor actually sees.
 */
const globalPools = new Map<string, Window>();

function startOfNextUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

export type Limits = { perMin: number; perDay: number };

export type RateResult =
  | { ok: true; remainingDay: number }
  | { ok: false; scope: "minute" | "day" | "global"; retryAfterSec: number };

function bucketFor(key: string, now: number): Bucket {
  let b = buckets.get(key);
  if (!b) {
    b = { minute: { count: 0, resetAt: now + 60_000 }, day: { count: 0, resetAt: startOfNextUtcDay(now) } };
    buckets.set(key, b);
  }
  if (now >= b.minute.resetAt) b.minute = { count: 0, resetAt: now + 60_000 };
  if (now >= b.day.resetAt) b.day = { count: 0, resetAt: startOfNextUtcDay(now) };
  return b;
}

/**
 * Charged on every request. Abuse protection.
 *
 * `key` is an API-key label on /v1/*, or "ip:<addr>" on the demo route. The
 * prefix keeps the two namespaces from colliding — nobody gets a free ride by
 * naming their key after an IP address.
 */
export function consumeRequest(key: string, limits: Limits, now = Date.now()): RateResult {
  const b = bucketFor(key, now);
  if (b.day.count >= limits.perDay) {
    return { ok: false, scope: "day", retryAfterSec: Math.ceil((b.day.resetAt - now) / 1000) };
  }
  if (b.minute.count >= limits.perMin) {
    return { ok: false, scope: "minute", retryAfterSec: Math.ceil((b.minute.resetAt - now) / 1000) };
  }
  b.minute.count += 1;
  return { ok: true, remainingDay: limits.perDay - b.day.count };
}

/** Charged immediately before an upstream call. Cost protection. */
export function consumeGpuCall(key: string, now = Date.now()): void {
  bucketFor(key, now).day.count += 1;
}

/**
 * The anonymous demo's shared budget. Checked before an upstream call and
 * charged at the same moment.
 *
 * Returns false when the day's budget is spent. The caller's job is then to
 * serve a canned line, NOT to error: a landing page whose demo 503s reads as
 * broken, and "broken" is the one joke this site cannot make.
 */
export function consumeGlobalCall(pool: string, limit: number, now = Date.now()): boolean {
  let w = globalPools.get(pool);
  if (!w || now >= w.resetAt) {
    w = { count: 0, resetAt: startOfNextUtcDay(now) };
    globalPools.set(pool, w);
  }
  if (w.count >= limit) return false;
  w.count += 1;
  return true;
}

export function consumeGlobalDemoCall(now = Date.now()): boolean {
  return consumeGlobalCall("demo", config.publicLimits.globalPerDay, now);
}

/** Exposed on /healthz so usage is visible without a log dive. */
export function snapshot(): {
  callers: Record<string, { minute: number; day: number }>;
  anonymousIps: number;
  globalDemoDay: number;
  pools: Record<string, number>;
} {
  const callers: Record<string, { minute: number; day: number }> = {};
  const now = Date.now();
  let anonymousIps = 0;
  for (const [key, b] of buckets) {
    if (key.startsWith("ip:")) {
      // Counting them is useful; listing visitor IPs on a public health check
      // is not, so the map only gets keyed callers.
      if (now < b.day.resetAt && b.day.count > 0) anonymousIps++;
      continue;
    }
    callers[key] = {
      minute: now >= b.minute.resetAt ? 0 : b.minute.count,
      day: now >= b.day.resetAt ? 0 : b.day.count,
    };
  }
  const pools: Record<string, number> = {};
  for (const [name, w] of globalPools) pools[name] = now >= w.resetAt ? 0 : w.count;

  return {
    callers,
    anonymousIps,
    globalDemoDay: pools["demo"] ?? 0,
    pools,
  };
}

/**
 * Drop buckets that have gone quiet. Called on a timer from index.ts — without
 * it, one map entry per visiting IP is an unbounded leak on a long-lived
 * process, which on a 1 GB box is a real outage and not a theoretical one.
 */
export function sweep(now = Date.now()): number {
  let dropped = 0;
  for (const [key, b] of buckets) {
    if (now >= b.minute.resetAt && (now >= b.day.resetAt || b.day.count === 0)) {
      buckets.delete(key);
      dropped++;
    }
  }
  return dropped;
}
