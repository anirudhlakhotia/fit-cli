/**
 * lifecycle-warning — GCP counterpart of ../aws/lifecycle-warning.ts's
 * printed guidance: how to reach a launched instance and how to delete it,
 * shown so a debuggable box doesn't quietly keep incurring GCP charges.
 */
import { formatBanner } from "../aws/lifecycle-warning.js";

export function gcpTerminateInstanceCommand(name: string, zone: string, project: string): string {
  return `bun src/cloud/util/gcp/terminate-instance.ts --project ${project} --zone ${zone} --name ${name}`;
}

/**
 * The human debug-access command: an interactive shell over an IAP-tunneled
 * SSH connection. No open port, no managed key pair — just
 * `roles/iap.tunnelResourceAccessor` + `roles/compute.osLogin` and the
 * `gcloud` CLI (fine for a human at a terminal; fit-cli's own automation uses
 * IapTarget directly).
 */
export function gcpDebugAccessCommand(name: string, zone: string, project: string): string {
  return `gcloud compute ssh ${name} --zone ${zone} --project ${project} --tunnel-through-iap`;
}

export function formatGcpDeletionResponsibilityBanner(
  name: string,
  zone: string,
  project: string,
  address?: string,
  interactive?: boolean,
): string {
  const cleanupLine = interactive
    ? "fit-cli will offer to delete it at the end of the run."
    : "fit-cli will automatically delete it at the end of the run.";
  return formatBanner("GCP INSTANCE LIFECYCLE WARNING", [
    `Instance: ${name}${address ? ` (${address})` : ""}`,
    `Project/zone: ${project}/${zone}`,
    "",
    "This instance keeps incurring GCP charges until it is deleted.",
    cleanupLine,
    "If you keep it running, or leave before cleanup, you must delete it yourself.",
    "A scheduled sweep (.github/workflows/cleanup-instances.yaml) reaps abandoned GCP boxes too, but only after the TTL — don't rely on it instead of cleaning up.",
    "Delete it with:",
    `  ${gcpTerminateInstanceCommand(name, zone, project)}`,
  ]);
}
