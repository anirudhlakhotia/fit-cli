/**
 * instance-age — pure helpers for age-based GCP instance reaping. GCP
 * counterpart of ../aws/instance-age.ts's `instanceAgeMs`/`selectAgedOut` — the
 * duration parsing and rendering (`parseDuration`/`formatAge`) are cloud-agnostic
 * so they're reused directly from the AWS module rather than duplicated.
 *
 * Used by `cloud-instances remove-all --cloud gcp --older-than <duration>`.
 */
import { formatAge, parseDuration } from "../aws/instance-age.js";
import type { GcpInstanceInfo } from "./parse-instance.js";

export { formatAge, parseDuration };

/** Age of a GCP instance in ms relative to `now`, or undefined if it has no creation time. */
export function instanceAgeMs(instance: GcpInstanceInfo, now: number): number | undefined {
  if (!instance.creationTimestamp) {
    return undefined;
  }
  const created = Date.parse(instance.creationTimestamp);
  return Number.isNaN(created) ? undefined : now - created;
}

/**
 * Split instances into those old enough to reap (created at least `cutoffMs`
 * ago) and the rest. Instances whose age can't be determined (missing/unparseable
 * creation time) are deliberately kept, never reaped — mirrors the AWS version's
 * same policy of never terminating a box we can't prove is old.
 */
export function selectAgedOut(
  instances: GcpInstanceInfo[],
  cutoffMs: number,
  now: number,
): { reap: GcpInstanceInfo[]; keep: GcpInstanceInfo[] } {
  const reap: GcpInstanceInfo[] = [];
  const keep: GcpInstanceInfo[] = [];
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
