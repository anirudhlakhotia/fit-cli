/**
 * parse-instance — flatten an EC2 instances JSON response into a simple list of
 * the fields we use. Pure logic, separated from the IO in instance.ts so it can
 * be unit tested (see tests/parse-instance.test.ts).
 *
 * It handles both shapes the aws CLI returns, because they differ:
 *   describe-instances nests instances inside reservations:
 *     { "Reservations": [ { "Instances": [ { "InstanceId": ..., ... } ] } ] }
 *   run-instances returns the launched instances at the top level:
 *     { "Instances": [ { "InstanceId": ..., ... } ] }
 */

/** The bits of an EC2 instance we care about. */
export interface InstanceInfo {
  instanceId: string;
  /** Lifecycle state, e.g. "pending", "running", "terminated". */
  state: string;
  /** Public DNS name, present once the instance is running (may be empty). */
  publicDns?: string;
  /** Public IPv4 address, present once the instance is running. */
  publicIp?: string;
}

/** A raw EC2 instance entry, as it appears in either response shape. */
interface RawInstance {
  InstanceId?: string;
  State?: { Name?: string };
  PublicDnsName?: string;
  PublicIpAddress?: string;
}

/**
 * Shape of the parts of an EC2 instances response we read. `Reservations` is the
 * describe-instances form; the top-level `Instances` is the run-instances form.
 */
export interface DescribeInstancesResponse {
  Reservations?: Array<{ Instances?: RawInstance[] }>;
  Instances?: RawInstance[];
}

/**
 * Flatten all instances — across every reservation, plus any at the top level
 * (run-instances) — into our shape, in the order they appear.
 */
export function parseInstances(response: DescribeInstancesResponse): InstanceInfo[] {
  const raw: RawInstance[] = [
    ...(response.Reservations ?? []).flatMap((reservation) => reservation.Instances ?? []),
    ...(response.Instances ?? []),
  ];
  const instances: InstanceInfo[] = [];
  for (const instance of raw) {
    if (!instance.InstanceId) {
      continue;
    }
    instances.push({
      instanceId: instance.InstanceId,
      state: instance.State?.Name ?? "unknown",
      publicDns: instance.PublicDnsName || undefined,
      publicIp: instance.PublicIpAddress || undefined,
    });
  }
  return instances;
}
