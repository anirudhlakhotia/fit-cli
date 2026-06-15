/**
 * instance-age — pure helpers for age-based instance reaping. Separated from the
 * IO in cloud-instances.ts so the duration parsing and the "is this box old
 * enough to kill?" decision can be unit tested (see tests/instance-age.test.ts).
 *
 * Used by `cloud-instances remove-all --older-than <duration>`, which the
 * scheduled cleanup workflow drives so a cron run only reaps abandoned boxes and
 * never an instance that's mid test-run.
 */
import type { InstanceInfo } from "./parse-instance.js";

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/**
 * Parse a duration like "24h", "90m", "2d" or "3600s" into milliseconds. Accepts
 * a single integer-and-unit pair; throws on anything else so a typo in the
 * workflow fails loudly rather than silently reaping with the wrong cutoff.
 */
export function parseDuration(text: string): number {
  const match = /^(\d+)\s*([smhd])$/.exec(text.trim());
  if (!match) {
    throw new Error(`Invalid duration "${text}". Expected an integer and a unit, e.g. 24h, 90m, 2d, 3600s.`);
  }
  return Number(match[1]) * UNIT_MS[match[2]];
}

/** Age of an instance in ms relative to `now`, or undefined if it has no launch time. */
export function instanceAgeMs(instance: InstanceInfo, now: number): number | undefined {
  if (!instance.launchTime) {
    return undefined;
  }
  const launched = Date.parse(instance.launchTime);
  return Number.isNaN(launched) ? undefined : now - launched;
}

/**
 * Split instances into those old enough to reap (launched at least `cutoffMs`
 * ago) and the rest. Instances whose age can't be determined (missing/unparseable
 * launch time) are deliberately kept, never reaped — we won't terminate a box we
 * can't prove is old.
 */
export function selectAgedOut(
  instances: InstanceInfo[],
  cutoffMs: number,
  now: number,
): { reap: InstanceInfo[]; keep: InstanceInfo[] } {
  const reap: InstanceInfo[] = [];
  const keep: InstanceInfo[] = [];
  for (const instance of instances) {
    const age = instanceAgeMs(instance, now);
    if (age !== undefined && age >= cutoffMs) {
      reap.push(instance);
    } else {
      keep.push(instance);
    }
  }
  return { reap, keep };
}

/** Render a millisecond age as a short "2d 3h"-style string for log output. */
export function formatAge(ms: number): string {
  if (ms < 0) ms = 0;
  const days = Math.floor(ms / UNIT_MS.d);
  const hours = Math.floor((ms % UNIT_MS.d) / UNIT_MS.h);
  const minutes = Math.floor((ms % UNIT_MS.h) / UNIT_MS.m);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes && !days) parts.push(`${minutes}m`);
  return parts.length ? parts.join(" ") : "<1m";
}
