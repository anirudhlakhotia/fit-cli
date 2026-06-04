/**
 * create-instance — launch a single EC2 instance and (optionally) wait for it to
 * reach the running state. Pure plumbing over the aws CLI; the JSON shaping lives
 * in parse-instance.ts. Nothing here is FIT-specific — the caller passes the AMI,
 * instance type, key, security group and any user-data/tags.
 *
 * Run on its own (the AMI/key/SG must already exist — see image.ts, key-pair.ts,
 * security-group.ts):
 *   npx tsx src/util/non-fit/aws/create-instance.ts \
 *     --ami ami-0123 --type t3.micro --key my-key --sg sg-0123 [--tag fit-cli=owned] [--wait] [--region eu-west-1]
 */
import { isMain, runCli } from "../cli.js";
import { awsJson, awsText, logAwsAction, prepareAwsCli, type AwsOptions } from "./aws-cli.js";
import { parseInstances, type DescribeInstancesResponse } from "./parse-instance.js";

/** Everything needed to launch one instance. */
export interface CreateInstanceSpec {
  amiId: string;
  instanceType: string;
  keyName: string;
  securityGroupId: string;
  /** Cloud-init / shell user-data run at first boot (plain text). */
  userData?: string;
  /** Tags applied to the instance, e.g. { "fit-cli": "owned" }. */
  tags?: Record<string, string>;
}

function tagSpecification(tags: Record<string, string>): string {
  const entries = Object.entries(tags)
    .map(([key, value]) => `{Key=${key},Value=${value}}`)
    .join(",");
  return `ResourceType=instance,Tags=[${entries}]`;
}

/** Launch a single instance and return its id (it will still be "pending"). */
export async function createInstance(spec: CreateInstanceSpec, options: AwsOptions = {}): Promise<string> {
  const args = [
    "ec2",
    "run-instances",
    "--image-id",
    spec.amiId,
    "--instance-type",
    spec.instanceType,
    "--key-name",
    spec.keyName,
    "--security-group-ids",
    spec.securityGroupId,
    "--count",
    "1",
  ];
  if (spec.userData) {
    // The aws CLI base64-encodes a plain --user-data value for us.
    args.push("--user-data", spec.userData);
  }
  if (spec.tags && Object.keys(spec.tags).length > 0) {
    args.push("--tag-specifications", tagSpecification(spec.tags));
  }
  const response = await awsJson<DescribeInstancesResponse>(args, options);
  const launched = parseInstances(response);
  if (launched.length === 0) {
    // AWS may have created an instance even though we couldn't read its id back
    // (e.g. an unexpected response shape). Surface the raw response so callers
    // can find and reap any box rather than silently leaking a paid instance.
    throw new Error(`run-instances returned no parseable instance:\n${JSON.stringify(response)}`);
  }
  return launched[0].instanceId;
}

/** Block until the instance reaches the "running" state (EC2's own waiter). */
export async function waitForInstanceRunning(instanceId: string, options: AwsOptions = {}): Promise<void> {
  await awsText(["ec2", "wait", "instance-running", "--instance-ids", instanceId], options);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    const awsOptions = prepareAwsCli(argv);
    const flag = (name: string): string | undefined => {
      const index = argv.indexOf(`--${name}`);
      return index !== -1 ? argv[index + 1] : undefined;
    };
    const amiId = flag("ami");
    const instanceType = flag("type");
    const keyName = flag("key");
    const securityGroupId = flag("sg");
    if (!amiId || !instanceType || !keyName || !securityGroupId) {
      throw new Error(
        "Usage: create-instance.ts --ami <id> --type <type> --key <name> --sg <id> [--tag k=v] [--user-data <text>] [--wait] [--region <aws-region>]",
      );
    }
    const tagFlag = flag("tag");
    const tags = tagFlag ? { [tagFlag.split("=")[0]]: tagFlag.split("=")[1] ?? "" } : undefined;
    const userData = flag("user-data");
    const wait = argv.includes("--wait");
    logAwsAction("Creating EC2 instance", awsOptions, {
      amiId,
      instanceType,
      keyName,
      securityGroupId,
      tag: tagFlag,
      wait,
      userData: userData ? "provided" : undefined,
    });
    const id = await createInstance({ amiId, instanceType, keyName, securityGroupId, userData, tags }, awsOptions);
    console.log(`✓ Launched ${id}`);
    if (wait) {
      console.log("Waiting for it to reach running...");
      await waitForInstanceRunning(id, awsOptions);
      console.log(`✓ ${id} is running`);
    }
  });
}
