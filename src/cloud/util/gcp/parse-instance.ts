/**
 * parse-instance — flatten a GCP compute Instance proto into the simple shape
 * fit-cli reads. Pure logic, separated from the SDK calls in
 * {create,describe,list,terminate}-instance.ts so it can be unit tested (see
 * tests/parse-instance.test.ts). Mirrors src/cloud/util/aws/parse-instance.ts.
 */
import type { protos } from "@google-cloud/compute";

type RawInstance = protos.google.cloud.compute.v1.IInstance;

/** The bits of a GCP compute instance we care about. */
export interface GcpInstanceInfo {
  name: string;
  /** Lifecycle status, e.g. "PROVISIONING", "RUNNING", "TERMINATED". */
  status: string;
  /** External (public) IPv4 address, present once the instance is running and has one. */
  externalIp?: string;
  /** Internal (RFC1918) IPv4 address. */
  internalIp?: string;
  /** Value of the "name" label under labels, if the caller used one for a human-readable identity — labels themselves are returned verbatim below. */
  labels?: Record<string, string>;
  /** Machine type as GCP returns it — a full URL ending in .../machineTypes/<type>. */
  machineTypeUrl?: string;
  /** Creation time as the RFC3339 string GCP returns, if present. */
  creationTimestamp?: string;
}

/** Flatten a raw Instance proto into our shape, or null if it has no name (shouldn't happen for a real instance). */
export function parseInstance(raw: RawInstance): GcpInstanceInfo | null {
  if (!raw.name) {
    return null;
  }
  const nic = raw.networkInterfaces?.[0];
  const externalIp = nic?.accessConfigs?.[0]?.natIP ?? undefined;
  return {
    name: raw.name,
    status: raw.status ?? "unknown",
    ...(externalIp ? { externalIp } : {}),
    ...(nic?.networkIP ? { internalIp: nic.networkIP } : {}),
    ...(raw.labels ? { labels: raw.labels } : {}),
    ...(raw.machineType ? { machineTypeUrl: raw.machineType } : {}),
    ...(raw.creationTimestamp ? { creationTimestamp: raw.creationTimestamp } : {}),
  };
}

/** Flatten a page of instances (as returned by InstancesClient.list) into our shape, dropping any without a name. */
export function parseInstances(raw: readonly RawInstance[]): GcpInstanceInfo[] {
  return raw.map(parseInstance).filter((instance): instance is GcpInstanceInfo => instance !== null);
}
