/**
 * list-instances — find instances by label (GCP's counterpart of an EC2 tag),
 * default the fit-cli ownership label, so you can see boxes left running.
 * Pure plumbing over the compute SDK; the shaping lives in parse-instance.ts.
 * Mirrors src/cloud/util/aws/list-instances.ts.
 *
 * Run on its own:
 *   bun src/cloud/util/gcp/list-instances.ts --project couchbase-qe --zone us-west1-a
 *   bun src/cloud/util/gcp/list-instances.ts --project couchbase-qe --zone us-west1-a --label env=ci
 *   bun src/cloud/util/gcp/list-instances.ts --project couchbase-qe --zone us-west1-a --all
 */
import type { protos } from "@google-cloud/compute";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { instancesClient } from "./gcp-clients.js";
import { preflightGcpProject } from "./identity.js";
import { parseInstances, type GcpInstanceInfo } from "./parse-instance.js";

/**
 * List instances in `zone` carrying a given label (default the fit-cli
 * ownership label). Pass `null` to list every instance in the zone regardless
 * of label. Unlike AWS, GCP has no single "list across all states" concept to
 * exclude — a deleted instance simply isn't returned, so there's no
 * LIVE_STATES filter to mirror.
 */
export async function listGcpInstances(
  project: string,
  zone: string,
  label: { key: string; value: string } | null = { key: "fit-cli", value: "owned" },
): Promise<GcpInstanceInfo[]> {
  const raw: protos.google.cloud.compute.v1.IInstance[] = [];
  for await (const instance of instancesClient.listAsync(
    {
      project,
      zone,
      ...(label ? { filter: `labels.${label.key}="${label.value}"` } : {}),
    },
    { autoPaginate: false },
  )) {
    raw.push(instance);
  }
  return parseInstances(raw);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    const flag = (n: string): string | undefined => {
      const i = argv.indexOf(`--${n}`);
      return i !== -1 ? argv[i + 1] : undefined;
    };
    const project = flag("project");
    const zone = flag("zone");
    const labelFlag = flag("label");
    const all = argv.includes("--all");
    if (!project || !zone) {
      throw new Error("Usage: list-instances.ts --project <id> --zone <zone> [--label k=v | --all]");
    }
    const label = all ? null : labelFlag ? { key: labelFlag.split("=")[0], value: labelFlag.split("=")[1] ?? "" } : undefined;
    await preflightGcpProject(project);
    const instances = await listGcpInstances(project, zone, label);
    console.log(instances.length ? JSON.stringify(instances, null, 2) : "No matching instances.");
  });
}
