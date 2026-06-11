/**
 * create-instance — launch a single EC2 instance and (optionally) wait for it to
 * reach the running state. Pure plumbing over the aws CLI; the JSON shaping lives
 * in parse-instance.ts. Nothing here is FIT-specific — the caller passes the AMI,
 * instance type, key, security group and any user-data/tags.
 *
 * Run on its own (the AMI/key/SG must already exist — see image.ts, key-pair.ts,
 * security-group.ts):
 *   npx tsx src/util/non-fit/aws/create-instance.ts \
 *     --ami ami-0123 --type t3.micro --key my-key --sg sg-0123 [--subnet subnet-0123] [--tag fit-cli=owned] [--wait]
 */
import { isMain, runCli } from "../cli.js";
import { awsJson, awsText, logAwsAction, prepareAwsCli } from "./aws-cli.js";
import { parseInstances, type DescribeInstancesResponse } from "./parse-instance.js";

/** A single EBS block-device mapping. */
export interface BlockDeviceMapping {
  deviceName: string;
  volumeSizeGB: number;
  volumeType?: string;
  deleteOnTermination?: boolean;
}

/** Everything needed to launch one instance. */
export interface CreateInstanceSpec {
  amiId: string;
  instanceType: string;
  keyName: string;
  securityGroupId: string;
  /** Subnet to launch into. Required when the account/region has no default VPC. */
  subnetId?: string;
  /** Cloud-init / shell user-data run at first boot (plain text). */
  userData?: string;
  /** Tags applied to the instance, e.g. { "fit-cli": "owned" }. */
  tags?: Record<string, string>;
  /** EBS block-device mappings (e.g. root volume size & type). */
  blockDeviceMappings?: BlockDeviceMapping[];
}

function tagSpecification(tags: Record<string, string>): string {
  const entries = Object.entries(tags)
    .map(([key, value]) => `{Key=${key},Value=${value}}`)
    .join(",");
  return `ResourceType=instance,Tags=[${entries}]`;
}

function blockDeviceMappingArgs(mappings: BlockDeviceMapping[]): string[] {
  const args: string[] = [];
  for (const m of mappings) {
    const ebs: string[] = [`VolumeSize=${m.volumeSizeGB}`];
    if (m.volumeType) {
      ebs.push(`VolumeType=${m.volumeType}`);
    }
    if (m.deleteOnTermination !== undefined) {
      ebs.push(`DeleteOnTermination=${m.deleteOnTermination}`);
    }
    args.push(
      "--block-device-mappings",
      `DeviceName=${m.deviceName},Ebs={${ebs.join(",")}}`,
    );
  }
  return args;
}

/**
 * Build the `aws ec2 run-instances` argument list for a spec. Pure (no I/O) so
 * the arg shaping — including the optional `--subnet-id` — can be unit tested.
 */
export function runInstancesArgs(spec: CreateInstanceSpec): string[] {
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
  if (spec.subnetId) {
    args.push("--subnet-id", spec.subnetId);
  }
  if (spec.userData) {
    // The aws CLI base64-encodes a plain --user-data value for us.
    args.push("--user-data", spec.userData);
  }
  if (spec.tags && Object.keys(spec.tags).length > 0) {
    args.push("--tag-specifications", tagSpecification(spec.tags));
  }
  if (spec.blockDeviceMappings && spec.blockDeviceMappings.length > 0) {
    args.push(...blockDeviceMappingArgs(spec.blockDeviceMappings));
  }
  return args;
}

/** Launch a single instance and return its id (it will still be "pending"). */
export async function createInstance(spec: CreateInstanceSpec): Promise<string> {
  const response = await awsJson<DescribeInstancesResponse>(runInstancesArgs(spec));
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
export async function waitForInstanceRunning(instanceId: string): Promise<void> {
  await awsText(["ec2", "wait", "instance-running", "--instance-ids", instanceId]);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    await prepareAwsCli();
    const argv = process.argv.slice(2);
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
        "Usage: create-instance.ts --ami <id> --type <type> --key <name> --sg <id> [--subnet <id>] [--tag k=v] [--user-data <text>] [--wait]",
      );
    }
    const subnetId = flag("subnet");
    const tagFlag = flag("tag");
    const tags = tagFlag ? { [tagFlag.split("=")[0]]: tagFlag.split("=")[1] ?? "" } : undefined;
    const userData = flag("user-data");
    const wait = argv.includes("--wait");
    logAwsAction("Creating EC2 instance", {
      amiId,
      instanceType,
      keyName,
      securityGroupId,
      subnetId,
      tag: tagFlag,
      wait,
      userData: userData ? "provided" : undefined,
    });
    const id = await createInstance({ amiId, instanceType, keyName, securityGroupId, subnetId, userData, tags });
    console.log(`✓ Launched ${id}`);
    if (wait) {
      console.log("Waiting for it to reach running...");
      await waitForInstanceRunning(id);
      console.log(`✓ ${id} is running`);
    }
  });
}
