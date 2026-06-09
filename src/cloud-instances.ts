#!/usr/bin/env node
/**
 * Top-level entry for managing fit-cli EC2 instances.
 *
 * npm run cloud-instances -- list   [--region <r>]
 * npm run cloud-instances -- delete <instance-id> [--region <r>] [--force]
 * npm run cloud-instances -- --help
 */
import { isMain, runCli } from "./util/non-fit/cli.js";
import { logAwsAction, prepareAwsCli, resolveRegion } from "./util/non-fit/aws/aws-cli.js";
import { checkCredentials } from "./util/non-fit/aws/identity.js";
import { listInstances, LIVE_STATES } from "./util/non-fit/aws/list-instances.js";
import { terminateInstance } from "./util/non-fit/aws/terminate-instance.js";
import { describeInstance } from "./util/non-fit/aws/describe-instance.js";
import { confirm } from "./util/non-fit/prompts.js";
import { FIT_OWNER_TAG } from "./util/fit/aws/fit-instance.js";
import {
  awsConsoleInstancesUrl,
  formatExistingInstancesBanner,
  terminateInstanceCommand,
  type InstanceListContext,
} from "./util/fit/aws/lifecycle-warning.js";

const HELP = `Manage fit-cli EC2 instances.

Usage:
  npm run cloud-instances -- list   [--region <region>]
  npm run cloud-instances -- delete <instance-id> [--region <region>] [--force]
  npm run cloud-instances -- --help

Subcommands:
  list    Show all fit-cli instances in the region with their status and cost context.
  delete  Terminate an instance by id (prompts for confirmation unless --force).`;

async function cmdList(argv: string[]): Promise<void> {
  const awsOptions = await prepareAwsCli(argv);
  const region = resolveRegion(awsOptions);

  logAwsAction("Listing fit-cli EC2 instances", awsOptions, {
    tag: `${FIT_OWNER_TAG.key}=${FIT_OWNER_TAG.value}`,
    states: LIVE_STATES,
  });

  const creds = await checkCredentials(awsOptions);
  const context: InstanceListContext | undefined = creds.ok
    ? { account: creds.identity.account, creator: creds.identity.arn.split("/").at(-1) ?? creds.identity.userId }
    : undefined;

  const instances = await listInstances(FIT_OWNER_TAG, { region });

  if (instances.length === 0) {
    console.log(`No fit-cli EC2 instances found in ${region}.`);
    if (context) {
      console.log(`Filter: tag:fit-cli=owned  ·  account: ${context.account}  ·  user: ${context.creator}`);
    }
    console.log(`Console: ${awsConsoleInstancesUrl(region)}`);
    return;
  }

  console.log(formatExistingInstancesBanner(instances, region, context));
}

async function cmdDelete(argv: string[]): Promise<void> {
  // Separate the instance-id positional from flags; skip the value after --region.
  const regionFlagIdx = argv.indexOf("--region");
  const positionals = argv.filter(
    (arg, i) => !arg.startsWith("-") && i !== regionFlagIdx + 1,
  );
  const instanceId = positionals[0];
  if (!instanceId) {
    throw new Error("Usage: npm run cloud-instances -- delete <instance-id> [--region <region>] [--force]");
  }

  const force = argv.includes("--force");
  const awsOptions = await prepareAwsCli(argv);
  const region = resolveRegion(awsOptions);

  logAwsAction("Terminating EC2 instance", awsOptions, { instanceId });

  const info = await describeInstance(instanceId, awsOptions);
  if (!info) {
    throw new Error(`Instance ${instanceId} not found in ${region}.`);
  }

  const addr = info.publicDns || info.publicIp;
  const creatorPart = info.creator ? `  created-by: ${info.creator}` : "";
  console.log(`Instance: ${instanceId}${addr ? ` (${addr})` : ""}${creatorPart}  state: ${info.state}`);
  console.log(`Terminate command: ${terminateInstanceCommand(instanceId, region)}`);

  if (!force) {
    const confirmed = await confirm({
      promptId: "cloud-instances.delete.confirm",
      message: `Terminate ${instanceId}? This cannot be undone.`,
      default: false,
    });
    if (!confirmed) {
      console.log("Cancelled — instance left running.");
      return;
    }
  }

  await terminateInstance(instanceId, awsOptions);
  console.log(`✓ Terminating ${instanceId}`);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const [subcommand, ...rest] = process.argv.slice(2);

    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      console.log(HELP);
      if (!subcommand) process.exit(2);
      return;
    }

    if (subcommand === "list") {
      await cmdList(rest);
      return;
    }

    if (subcommand === "delete") {
      await cmdDelete(rest);
      return;
    }

    console.error(`Unknown subcommand: ${subcommand}\n`);
    console.error(HELP);
    process.exit(2);
  });
}
