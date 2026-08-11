/**
 * instances-cli — the GCP-specific logic behind cloud-instances' list/remove/
 * remove-all subcommands. Mirrors ../aws/instances-cli.ts; cloud-instances.ts
 * is glue and doesn't touch GCP directly.
 */
import { checkGcpCredentials } from "./identity.js";
import { listGcpInstances } from "./list-instances.js";
import { terminateGcpInstance } from "./terminate-instance.js";
import { describeGcpInstance } from "./describe-instance.js";
import { type GcpInstanceInfo } from "./parse-instance.js";
import * as instanceAge from "./instance-age.js";
import { localGcpCreator, logGcpAction } from "./gcp-cli.js";
import { gcpTerminateInstanceCommand } from "../../../fit/util/gcp/lifecycle-warning.js";
import { confirm } from "../../../util/non-fit/prompts.js";
import type { InstanceRow } from "../instance-row.js";

export const FIT_GCP_LABEL = { key: "fit-cli", value: "owned" } as const;

function formatGcpInstancesList(instances: GcpInstanceInfo[]): string {
  return instances
    .map((i) => {
      const addr = i.externalIp || i.internalIp;
      const creator = i.labels?.["created-by"];
      return `  ${i.name}${addr ? ` (${addr})` : ""}  status: ${i.status}${creator ? `  created-by: ${creator}` : ""}`;
    })
    .join("\n");
}

export async function listInstanceRows(opts: { allUsers: boolean; project: string; zone: string }): Promise<InstanceRow[]> {
  const { allUsers, project, zone } = opts;
  await checkGcpCredentials(project);
  const creator = localGcpCreator();

  logGcpAction("Listing fit-cli GCP instances", project, zone, {
    label: `${FIT_GCP_LABEL.key}=${FIT_GCP_LABEL.value}`,
    scope: allUsers ? "all users" : "current user",
  });

  const all = await listGcpInstances(project, zone, FIT_GCP_LABEL);
  const instances = allUsers ? all : all.filter((i) => i.labels?.["created-by"] === creator);
  return instances.map((i) => ({
    cloud: "GCP" as const,
    id: i.name,
    address: i.externalIp || i.internalIp || "-",
    state: i.status,
    creator: i.labels?.["created-by"] ?? "-",
  }));
}

/** Used by cloud-instances.ts's `remove` to auto-detect which cloud an identifier belongs to. */
export async function findInstance(opts: { identifier: string; project: string; zone: string }): Promise<boolean> {
  const { identifier, project, zone } = opts;
  const creds = await checkGcpCredentials(project);
  if (!creds.ok) return false;
  return Boolean(await describeGcpInstance(project, zone, identifier).catch(() => null));
}

export async function removeInstance(opts: { name: string; force: boolean; project: string; zone: string }): Promise<void> {
  const { name, force, project, zone } = opts;
  await checkGcpCredentials(project);

  logGcpAction("Deleting GCP instance", project, zone, { name });

  const info = await describeGcpInstance(project, zone, name);
  if (!info) {
    throw new Error(`Instance ${name} not found in ${project}/${zone}.`);
  }

  const addr = info.externalIp || info.internalIp;
  const creatorPart = info.labels?.["created-by"] ? `  created-by: ${info.labels["created-by"]}` : "";
  console.log(`Instance: ${name}${addr ? ` (${addr})` : ""}${creatorPart}  status: ${info.status}`);
  console.log(`Delete command: ${gcpTerminateInstanceCommand(name, zone, project)}`);

  if (!force) {
    const confirmed = await confirm({
      promptId: "cloud-instances.remove.confirm",
      message: `Delete ${name}? This cannot be undone.`,
      default: false,
    });
    if (!confirmed) {
      console.log("Cancelled — instance left running.");
      return;
    }
  }

  await terminateGcpInstance(project, zone, name);
  console.log(`✓ Deleted ${name}`);
}

export async function removeAllInstances(opts: {
  allUsers: boolean;
  force: boolean;
  dryRun: boolean;
  olderThan?: string;
  project: string;
  zone: string;
}): Promise<void> {
  const { allUsers, force, dryRun, olderThan, project, zone } = opts;
  // Parse up front so a bad duration fails before we touch GCP.
  const cutoffMs = olderThan !== undefined ? instanceAge.parseDuration(olderThan) : undefined;

  await checkGcpCredentials(project);
  const creator = localGcpCreator();

  logGcpAction("Removing fit-cli GCP instances", project, zone, {
    label: `${FIT_GCP_LABEL.key}=${FIT_GCP_LABEL.value}`,
    scope: allUsers ? "all users" : "current user",
    ...(olderThan !== undefined ? { olderThan } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  });

  const all = await listGcpInstances(project, zone, FIT_GCP_LABEL);
  const scoped = allUsers ? all : all.filter((instance) => instance.labels?.["created-by"] === creator);

  let mine = scoped;
  if (cutoffMs !== undefined) {
    const now = Date.now();
    const { reap, keep } = instanceAge.selectAgedOut(scoped, cutoffMs, now);
    mine = reap;
    if (keep.length > 0) {
      console.log(
        `Skipping ${keep.length} instance(s) younger than ${olderThan} (or with unknown age): ` +
          keep
            .map((i) => {
              const age = instanceAge.instanceAgeMs(i, now);
              return `${i.name} (${age === undefined ? "age unknown" : instanceAge.formatAge(age)})`;
            })
            .join(", "),
      );
    }
  }

  if (mine.length === 0) {
    const scope = allUsers ? "" : ` created by ${creator}`;
    const ageNote = cutoffMs !== undefined ? ` older than ${olderThan}` : "";
    console.log(`No fit-cli GCP instances${scope}${ageNote} found in ${project}/${zone}.`);
    return;
  }

  console.log(formatGcpInstancesList(mine));

  if (dryRun) {
    console.log(`\nDry run — would delete ${mine.length} instance(s); leaving them running.`);
    return;
  }

  if (!force) {
    const confirmed = await confirm({
      promptId: "cloud-instances.remove-all.confirm",
      message: `Delete all ${mine.length} instance(s) above? This cannot be undone.`,
      default: false,
    });
    if (!confirmed) {
      console.log("Cancelled — instances left running.");
      return;
    }
  }

  const failures: { name: string; error: string }[] = [];
  for (const instance of mine) {
    try {
      await terminateGcpInstance(project, zone, instance.name);
      console.log(`✓ Deleting ${instance.name}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failures.push({ name: instance.name, error });
      console.error(`✗ Failed to delete ${instance.name}: ${error}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to delete ${failures.length} of ${mine.length} instance(s).`);
  }
  console.log(`\n✓ Deleted ${mine.length} instance(s).`);
}
