/**
 * list-instances — find non-terminated EC2 instances, either by a tag (default
 * the fit-cli ownership tag, so you can see boxes left running) or by the key
 * pair they were launched with. Pure plumbing over the EC2 SDK; the JSON shaping
 * lives in parse-instance.ts.
 *
 * Run on its own:
 *   bun src/cloud/util/aws/list-instances.ts                                 # fit-cli=owned
 *   bun src/cloud/util/aws/list-instances.ts --tag env=ci
 *   bun src/cloud/util/aws/list-instances.ts --key fit-cli-abc123
 */
import { DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { logAwsAction, prepareAwsCli } from "./aws-cli.js";
import { ec2Client } from "./aws-clients.js";
import { parseInstances, type InstanceInfo } from "./parse-instance.js";

/** Instance states worth listing — everything except terminated. */
export const LIVE_STATES = ["pending", "running", "stopping", "stopped"];

/**
 * List instances carrying a given tag (default the fit-cli ownership tag),
 * excluding terminated ones, so callers can find boxes left running.
 */
export async function listInstances(
  tag: { key: string; value: string } = { key: "fit-cli", value: "owned" },
): Promise<InstanceInfo[]> {
  const response = await ec2Client.send(new DescribeInstancesCommand({
    Filters: [
      { Name: `tag:${tag.key}`, Values: [tag.value] },
      { Name: "instance-state-name", Values: LIVE_STATES },
    ],
  }));
  return parseInstances(response);
}

/**
 * Find non-terminated instances launched with a given key pair name. A key pair
 * is minted fresh per provisioning attempt, so this uniquely identifies the
 * box(es) from one run — useful for reaping a leak when launch failed before we
 * captured the instance id.
 */
export async function findInstancesByKeyName(keyName: string): Promise<InstanceInfo[]> {
  const response = await ec2Client.send(new DescribeInstancesCommand({
    Filters: [
      { Name: "key-name", Values: [keyName] },
      { Name: "instance-state-name", Values: LIVE_STATES },
    ],
  }));
  return parseInstances(response);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    const flag = (name: string): string | undefined => {
      const index = argv.indexOf(`--${name}`);
      return index !== -1 ? argv[index + 1] : undefined;
    };
    const key = flag("key");
    const tagFlag = flag("tag");
    await prepareAwsCli();
    logAwsAction("Listing EC2 instances", key ? { keyName: key, states: LIVE_STATES } : {
      tag: tagFlag ?? "fit-cli=owned",
      states: LIVE_STATES,
    });
    const instances = key
      ? await findInstancesByKeyName(key)
      : await listInstances(
          tagFlag ? { key: tagFlag.split("=")[0], value: tagFlag.split("=")[1] ?? "" } : undefined,
        );
    console.log(instances.length ? JSON.stringify(instances, null, 2) : "No matching instances.");
  });
}
