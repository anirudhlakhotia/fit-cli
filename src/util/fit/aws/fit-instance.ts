/**
 * fit-instance — provision a clean EC2 instance for a FIT run. This is the
 * FIT-specific glue that composes the generic AWS/SSH plumbing in
 * util/non-fit/aws and util/non-fit/ssh into "give me a box I can run FIT on,
 * and a handle to tear it down". The reusable, FIT-agnostic pieces stay in
 * util/non-fit; only the opinions (instance defaults, the fit-cli ownership
 * tag, where the key lands) live here.
 *
 * Run on its own (provisions a box and prints how to reach it — does NOT
 * terminate it, so you can poke at it; tear it down with the printed command):
 *   npx tsx src/util/fit/aws/fit-instance.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactFromPath, type Artifact, type Detail } from "../../non-fit/artifacts.js";
import { isMain, runCli } from "../../non-fit/cli.js";
import { resolveRegion, type AwsOptions } from "../../non-fit/aws/aws-cli.js";
import { defaultAwsRegionMessage, resolveAwsRegion } from "../../non-fit/aws/region.js";
import { checkCredentials } from "../../non-fit/aws/identity.js";
import { findUbuntuAmi } from "../../non-fit/aws/image.js";
import { createInstance, waitForInstanceRunning, type BlockDeviceMapping } from "../../non-fit/aws/create-instance.js";
import { describeInstance } from "../../non-fit/aws/describe-instance.js";
import { findInstancesByKeyName } from "../../non-fit/aws/list-instances.js";
import { terminateInstance } from "../../non-fit/aws/terminate-instance.js";
import { ensureFitCliConfigEnv } from "../config.js";
import { createKeyPair, deleteKeyPair } from "../../non-fit/aws/key-pair.js";
import { ensureSecurityGroup } from "../../non-fit/aws/security-group.js";
import { instanceRunDir } from "../../non-fit/replay.js";
import { waitForSsh, type RemoteHost } from "../../non-fit/ssh.js";
import { RemoteTarget } from "../../non-fit/remote-target.js";
import { fitCliWarn } from "../../non-fit/fit-cli-log.js";
import { formatEc2DeletionResponsibilityBanner, terminateInstanceCommand } from "./lifecycle-warning.js";
import { warnAboutExistingInstances } from "./warn-existing-instances.js";

/** Security group fit-cli reuses across runs (port 22 open). */
export const FIT_SECURITY_GROUP = "fit-cli";

/** Tag stamped on every box fit-cli launches, so they can be found later. */
export const FIT_OWNER_TAG = { key: "fit-cli", value: "owned" } as const;

/** Login user for manual SSH. */
export const FIT_INSTANCE_USER = "ubuntu";

/**
 * Default instance type for FIT EC2 instances.
 *
 * Used as it's what has historically been used for FIT/PERF.
 * Should technically go into the database to allow apples-to-apples comparisons.
 *
 * Override with FIT_EC2_INSTANCE_TYPE.
 */
export function defaultInstanceType(): string {
  return process.env.FIT_EC2_INSTANCE_TYPE ?? "c5.4xlarge";
}

/**
 * Root EBS volume configuration for FIT instances.
 *
 * CBD-5001 - seeing issues with the default 8GB.
 * Bumping as also seeing issues with 50GB:
 * https://couchbase.slack.com/archives/C08FV3X1CCA/p1773408987562519?thread_ts=1773392405.251509&cid=C08FV3X1CCA
 */
export function fitBlockDeviceMappings(): BlockDeviceMapping[] {
  return [
    {
      deviceName: "/dev/sda1",
      volumeSizeGB: 250,
      volumeType: "gp3",
      deleteOnTermination: true,
    },
  ];
}

/** A provisioned EC2 instance, ready to use, with a teardown handle. */
export interface ProvisionedInstance {
  instanceId: string;
  /** Address used to reach it (public DNS, or public IP if DNS is absent). */
  address: string;
  /** Path to the generated private key on this machine. */
  keyPath: string;
  /** The host descriptor used for SSH. */
  host: RemoteHost;
  /** An ExecutionTarget that runs commands on this instance. */
  target: RemoteTarget;
  /** Files produced (the key, an instance-info record) for the run summary. */
  artifacts: Artifact[];
  /** Useful commands and facts for debugging and cleanup. */
  details: Detail[];
  /** Terminate the instance and delete its key pair. Safe to call once. */
  terminate: () => Promise<void>;
}

/** Options for provisioning (all optional; sensible FIT defaults apply). */
export interface ProvisionOptions {
  instanceType?: string;
  region?: string;
  /** Instance this execution target belongs to; its key and info land under that instance dir. */
  instanceIndex?: number;
}

/**
 * Provision a fresh EC2 instance suitable for a FIT run: latest Ubuntu LTS, the
 * shared fit-cli security group and a freshly-minted key pair. Waits until the
 * box is running and accepting SSH before returning. If anything fails after
 * the instance launches, it's terminated so we don't leak a paid box.
 */
export async function provisionFitInstance(options: ProvisionOptions = {}): Promise<ProvisionedInstance> {
  await ensureFitCliConfigEnv({
    promptId: "fit-instance.config.create",
    promptMessage: "No fit-cli config found. Run `npm run init` now before provisioning an EC2 instance?",
  });
  const { region, source } = resolveAwsRegion({ region: options.region });
  if (source === "default") {
    console.log(defaultAwsRegionMessage(region));
  }
  const awsOptions: AwsOptions = { region };

  const creds = await checkCredentials(awsOptions);
  if (!creds.ok) {
    throw new Error(`AWS credentials are not usable: ${creds.message}`);
  }
  // Last segment of the ARN is the most readable creator identifier:
  //   arn:aws:iam::123:user/alice          → alice
  //   arn:aws:sts::123:assumed-role/R/sess → sess
  const creatorTag = creds.identity.arn.split("/").at(-1) ?? creds.identity.userId;

  // Before launching anything, warn about fit-cli boxes already running in this
  // region (same owner/account, owned-by-fit tag) so a forgotten, still-billing
  // instance is noticed rather than stacked on top of.
  const existingInstances = await warnAboutExistingInstances(awsOptions, {
    account: creds.identity.account,
    creator: creatorTag,
  });

  const instanceType = options.instanceType ?? defaultInstanceType();
  console.log(`Provisioning a ${instanceType} EC2 instance in ${region}...`);

  const amiId = await findUbuntuAmi(awsOptions);
  const securityGroupId = await ensureSecurityGroup(
    { name: FIT_SECURITY_GROUP, description: "fit-cli ephemeral test instances", ingressPorts: [22] },
    awsOptions,
  );

  const keyName = `fit-cli-${Date.now().toString(36)}`;
  const instanceDir = instanceRunDir(options.instanceIndex ?? 0);
  mkdirSync(instanceDir, { recursive: true, mode: 0o700 });
  const keyPath = join(instanceDir, `${keyName}.pem`);
  await createKeyPair(keyName, keyPath, awsOptions);

  let instanceId: string | undefined;
  try {
    instanceId = await createInstance(
      {
        amiId,
        instanceType,
        keyName,
        securityGroupId,
        tags: { [FIT_OWNER_TAG.key]: FIT_OWNER_TAG.value, "created-by": creatorTag },
        blockDeviceMappings: fitBlockDeviceMappings(),
      },
      awsOptions,
    );
    console.log(`  launched ${instanceId}, waiting for it to start...`);
    await waitForInstanceRunning(instanceId, awsOptions);

    const info = await describeInstance(instanceId, awsOptions);
    const address = info?.publicDns || info?.publicIp;
    if (!address) {
      throw new Error(`Instance ${instanceId} is running but has no public address.`);
    }

    const host: RemoteHost = { host: address, user: FIT_INSTANCE_USER, identityFile: keyPath, agentForwarding: true };
    process.stdout.write("  waiting for SSH...");
    if (!(await waitForSsh(host))) {
      throw new Error(`Timed out waiting for SSH on ${address}.`);
    }
    console.log(" ready");

    const id = instanceId;
    const terminate = async (): Promise<void> => {
      await terminateInstance(id, awsOptions);
      await deleteKeyPair(keyName, awsOptions).catch(() => {});
    };

    const infoPath = join(instanceDir, "ec2-instance.json");
    writeFileSync(
      infoPath,
      `${JSON.stringify({ instanceId: id, address, region, instanceType, keyPath }, null, 2)}\n`,
    );
    const artifacts = [
      artifactFromPath(keyPath, "SSH private key for the EC2 test instance"),
      artifactFromPath(infoPath, "EC2 test instance details (id, address, region)"),
    ];
    const details = [
      {
        label: "SSH debug command",
        value: `ssh -i ${keyPath} ${FIT_INSTANCE_USER}@${address}`,
      },
      {
        label: "Terminate instance command",
        value: terminateInstanceCommand(id, region),
      },
    ];

    console.log(`\n✓ EC2 instance ${id} is ready at ${address}`);
    fitCliWarn(`\n${formatEc2DeletionResponsibilityBanner(id, region, address, existingInstances)}\n`);
    console.log("Debug it directly with:");
    console.log(`  ssh -i ${keyPath} ${FIT_INSTANCE_USER}@${address}`);
    return { instanceId: id, address, keyPath, host, target: new RemoteTarget(host), artifacts, details, terminate };
  } catch (err) {
    // Don't leave a paid box (or its key) lying around if bring-up failed. If we
    // never captured the instance id (e.g. launch threw mid-call), sweep by the
    // run's unique key name so an instance AWS created anyway can't leak.
    const leaked = instanceId
      ? [instanceId]
      : await findInstancesByKeyName(keyName, awsOptions)
          .then((found) => found.map((i) => i.instanceId))
          .catch(() => []);
    for (const id of leaked) {
      await terminateInstance(id, awsOptions).catch(() => {});
    }
    await deleteKeyPair(keyName, awsOptions).catch(() => {});
    throw err;
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const provisioned = await provisionFitInstance();
    console.log(`\nLeaving it running. Terminate when done with:`);
    console.log(`  ${terminateInstanceCommand(provisioned.instanceId, resolveRegion())}`);
    return { artifacts: provisioned.artifacts, details: provisioned.details };
  });
}
