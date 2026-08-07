/**
 * gcp-cli — small shared helpers for the rest of cloud/util/gcp, mirroring the
 * console-logging and local-identity conventions in ../aws/aws-cli.ts. GCP has
 * no assumed-role/STS identity to report (see identity.ts's preflight checks
 * for that), so this only covers what's left: consistent action logging, and
 * deriving the same OS-user-based "creator" string fit-instance.ts stamps onto
 * launched instances.
 */
import { loadEnvironments } from "../../../fit/util/environments.js";

/**
 * The `created-by` label value fit-cli stamps on every GCP instance it
 * launches (see fit/util/gcp/fit-instance.ts). GCP has no ARN to derive an
 * identity from like AWS's callerCreator, so this falls back to the OS user,
 * folded into GCP's label-safe charset.
 */
export function localGcpCreator(): string {
  return (process.env.USER ?? process.env.LOGNAME ?? "user").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

/** Project + zone fit-cli operates in by default, from environments.json5's defaults.gcp. */
export function defaultGcpProjectZone(): { project?: string; zone?: string } {
  const gcp = loadEnvironments().defaults.gcp ?? {};
  return { project: gcp.project ?? undefined, zone: gcp.zone ?? undefined };
}

function formatGcpDetail(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return typeof value;
}

/** Print a short, consistent summary of the GCP action about to be run, mirroring logAwsAction. */
export function logGcpAction(action: string, project: string, zone: string, details: Record<string, unknown> = {}): void {
  console.log(`${action} (project: ${project}, zone: ${zone})`);
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      console.log(`  ${key}: ${value.join(", ")}`);
      continue;
    }
    console.log(`  ${key}: ${formatGcpDetail(value)}`);
  }
}
