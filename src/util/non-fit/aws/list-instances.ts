/**
 * list-instances — find non-terminated EC2 instances, either by a tag (default
 * the fit-cli ownership tag, so you can see boxes left running) or by the key
 * pair they were launched with. Pure plumbing over the aws CLI; the JSON shaping
 * lives in parse-instance.ts.
 *
 * Run on its own:
 *   npx tsx src/util/non-fit/aws/list-instances.ts                                 # fit-cli=owned
 *   npx tsx src/util/non-fit/aws/list-instances.ts --tag env=ci
 *   npx tsx src/util/non-fit/aws/list-instances.ts --key fit-cli-abc123
 *   npx tsx src/util/non-fit/aws/list-instances.ts --region eu-west-1
 */
import { isMain, runCli } from "../cli.js";
import { awsJson, logAwsAction, prepareAwsCli, type AwsOptions } from "./aws-cli.js";
import { parseInstances, type DescribeInstancesResponse, type InstanceInfo } from "./parse-instance.js";

/** Instance states worth listing — everything except terminated. */
const LIVE_STATES = "pending,running,stopping,stopped";

/**
 * List instances carrying a given tag (default the fit-cli ownership tag),
 * excluding terminated ones, so callers can find boxes left running.
 */
export async function listInstances(
  tag: { key: string; value: string } = { key: "fit-cli", value: "owned" },
  options: AwsOptions = {},
): Promise<InstanceInfo[]> {
  const response = await awsJson<DescribeInstancesResponse>(
    [
      "ec2",
      "describe-instances",
      "--filters",
      `Name=tag:${tag.key},Values=${tag.value}`,
      `Name=instance-state-name,Values=${LIVE_STATES}`,
    ],
    options,
  );
  return parseInstances(response);
}

/**
 * Find non-terminated instances launched with a given key pair name. A key pair
 * is minted fresh per provisioning attempt, so this uniquely identifies the
 * box(es) from one run — useful for reaping a leak when launch failed before we
 * captured the instance id.
 */
export async function findInstancesByKeyName(keyName: string, options: AwsOptions = {}): Promise<InstanceInfo[]> {
  const response = await awsJson<DescribeInstancesResponse>(
    [
      "ec2",
      "describe-instances",
      "--filters",
      `Name=key-name,Values=${keyName}`,
      `Name=instance-state-name,Values=${LIVE_STATES}`,
    ],
    options,
  );
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
    const awsOptions = prepareAwsCli(argv);
    logAwsAction("Listing EC2 instances", awsOptions, key ? { keyName: key, states: LIVE_STATES } : {
      tag: tagFlag ?? "fit-cli=owned",
      states: LIVE_STATES,
    });
    const instances = key
      ? await findInstancesByKeyName(key, awsOptions)
      : await listInstances(
          tagFlag ? { key: tagFlag.split("=")[0], value: tagFlag.split("=")[1] ?? "" } : undefined,
          awsOptions,
        );
    console.log(instances.length ? JSON.stringify(instances, null, 2) : "No matching instances.");
  });
}
