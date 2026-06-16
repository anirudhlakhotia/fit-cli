#!/usr/bin/env node
/**
 * Top-level entry for managing fit-cli EC2 instances.
 *
 * bun run cloud-instances -- list
 * bun run cloud-instances -- manage [--tag key=value] [--key <key-name>]
 * bun run cloud-instances -- delete <instance-id> [--force]
 * bun run cloud-instances -- remove-all [--all-users] [--older-than <duration>] [--dry-run] [--force]
 * bun run cloud-instances -- --help
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { logAwsAction, prepareAwsCli } from "../../cloud/util/aws/aws-cli.js";
import { AWS_REGION } from "../../cloud/util/aws/aws-target.js";
import { checkCredentials } from "../../cloud/util/aws/identity.js";
import { listInstances, LIVE_STATES } from "../../cloud/util/aws/list-instances.js";
import { terminateInstance } from "../../cloud/util/aws/terminate-instance.js";
import { describeInstance } from "../../cloud/util/aws/describe-instance.js";
import { formatAge, instanceAgeMs, parseDuration, selectAgedOut } from "../../cloud/util/aws/instance-age.js";
import { confirm } from "../../util/non-fit/prompts.js";
import { FIT_OWNER_TAG } from "../../fit/util/aws/fit-instance.js";
import {
  awsConsoleInstancesUrl,
  formatExistingInstancesBanner,
  terminateInstanceCommand,
  type InstanceListContext,
} from "../../fit/util/aws/lifecycle-warning.js";
import { manageInstances, type InstanceQuery } from "../../cloud/util/aws/manage-instances.js";

const HELP = `Manage fit-cli EC2 instances.

Usage:
  bun run cloud-instances -- list
  bun run cloud-instances -- manage [--tag key=value] [--key <key-name>]
  bun run cloud-instances -- delete <instance-id> [--force]
  bun run cloud-instances -- remove-all [--all-users] [--older-than <duration>] [--dry-run] [--force]
  bun run cloud-instances -- --help

Subcommands:
  list        Show all fit-cli instances with their status and cost context.
  manage      Interactively browse and act on instances (terminate, view details).
  delete      Terminate an instance by id (prompts for confirmation unless --force).
  remove-all  Terminate every fit-cli instance you created (add --all-users for
              everyone's; prompts for confirmation unless --force).

remove-all options:
  --all-users        Include instances created by everyone, not just you.
  --older-than <d>   Only reap instances launched at least this long ago, e.g.
                     24h, 90m, 2d. Boxes whose age can't be determined are kept.
  --dry-run          List what would be terminated, then exit without touching it.
  --force            Skip the confirmation prompt (required for unattended runs,
                     e.g. the scheduled cleanup workflow).`;

async function cmdList(argv: string[]): Promise<void> {
  await prepareAwsCli();

  logAwsAction("Listing fit-cli EC2 instances", {
    tag: `${FIT_OWNER_TAG.key}=${FIT_OWNER_TAG.value}`,
    states: LIVE_STATES,
  });

  const creds = await checkCredentials();
  const context: InstanceListContext | undefined = creds.ok
    ? { account: creds.identity.account, creator: creds.identity.arn.split("/").at(-1) ?? creds.identity.userId }
    : undefined;

  const instances = await listInstances(FIT_OWNER_TAG);

  if (instances.length === 0) {
    console.log(`No fit-cli EC2 instances found in ${AWS_REGION}.`);
    if (context) {
      console.log(`Filter: tag:fit-cli=owned  ·  account: ${context.account}  ·  user: ${context.creator}`);
    }
    console.log(`Console: ${awsConsoleInstancesUrl()}`);
    return;
  }

  console.log(formatExistingInstancesBanner(instances, context));
}

async function cmdManage(argv: string[]): Promise<void> {
  await prepareAwsCli();

  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index !== -1 ? argv[index + 1] : undefined;
  };

  let query: InstanceQuery;
  const key = flag("key");
  if (key) {
    query = { kind: "key", keyName: key };
  } else {
    const tag = flag("tag");
    query = {
      kind: "tag",
      tag: tag ? { key: tag.split("=")[0], value: tag.split("=")[1] ?? "" } : undefined,
    };
  }

  logAwsAction(
    "Managing EC2 instances",
    query.kind === "key"
      ? { keyName: query.keyName, states: LIVE_STATES }
      : { tag: query.tag ? `${query.tag.key}=${query.tag.value}` : "fit-cli=owned", states: LIVE_STATES },
  );

  await manageInstances(query);
}

async function cmdDelete(argv: string[]): Promise<void> {
  const instanceId = argv.find((arg) => !arg.startsWith("-"));
  if (!instanceId) {
    throw new Error("Usage: bun run cloud-instances -- delete <instance-id> [--force]");
  }

  const force = argv.includes("--force");
  await prepareAwsCli();

  logAwsAction("Terminating EC2 instance", { instanceId });

  const info = await describeInstance(instanceId);
  if (!info) {
    throw new Error(`Instance ${instanceId} not found in ${AWS_REGION}.`);
  }

  const addr = info.publicDns || info.publicIp;
  const creatorPart = info.creator ? `  created-by: ${info.creator}` : "";
  console.log(`Instance: ${instanceId}${addr ? ` (${addr})` : ""}${creatorPart}  state: ${info.state}`);
  console.log(`Terminate command: ${terminateInstanceCommand(instanceId)}`);

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

  await terminateInstance(instanceId);
  console.log(`✓ Terminating ${instanceId}`);
}

/** Derive the readable creator id fit-cli stamps as the `created-by` tag. */
function callerCreator(identity: { arn: string; userId: string }): string {
  return identity.arn.split("/").at(-1) ?? identity.userId;
}

async function cmdRemoveAll(argv: string[]): Promise<void> {
  const allUsers = argv.includes("--all-users");
  const force = argv.includes("--force");
  const dryRun = argv.includes("--dry-run");
  const olderThanIndex = argv.indexOf("--older-than");
  const olderThanArg = olderThanIndex !== -1 ? argv[olderThanIndex + 1] : undefined;
  if (olderThanIndex !== -1 && !olderThanArg) {
    throw new Error("--older-than needs a duration, e.g. --older-than 24h.");
  }
  // Parse up front so a bad duration fails before we touch AWS.
  const cutoffMs = olderThanArg !== undefined ? parseDuration(olderThanArg) : undefined;
  await prepareAwsCli();

  logAwsAction("Removing fit-cli EC2 instances", {
    tag: `${FIT_OWNER_TAG.key}=${FIT_OWNER_TAG.value}`,
    states: LIVE_STATES,
    scope: allUsers ? "all users" : "current user",
    ...(olderThanArg !== undefined ? { olderThan: olderThanArg } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  });

  const creds = await checkCredentials();
  const context: InstanceListContext | undefined = creds.ok
    ? { account: creds.identity.account, creator: callerCreator(creds.identity) }
    : undefined;
  if (!allUsers && !creds.ok) {
    throw new Error(
      "Can't determine who you are from AWS credentials, so can't scope removal to your own instances. " +
        "Fix your credentials, or pass --all-users to remove every fit-cli instance.",
    );
  }

  const all = await listInstances(FIT_OWNER_TAG);
  const scoped = allUsers ? all : all.filter((instance) => instance.creator === context?.creator);

  // Age-gate when asked. Anything younger than the cutoff (or whose age we can't
  // determine) is left alone — see selectAgedOut.
  let mine = scoped;
  if (cutoffMs !== undefined) {
    const now = Date.now();
    const { reap, keep } = selectAgedOut(scoped, cutoffMs, now);
    mine = reap;
    if (keep.length > 0) {
      console.log(
        `Skipping ${keep.length} instance(s) younger than ${olderThanArg} (or with unknown age): ` +
          keep
            .map((i) => {
              const age = instanceAgeMs(i, now);
              return `${i.instanceId} (${age === undefined ? "age unknown" : formatAge(age)})`;
            })
            .join(", "),
      );
    }
  }

  if (mine.length === 0) {
    const scope = allUsers ? "" : ` created by ${context?.creator}`;
    const ageNote = cutoffMs !== undefined ? ` older than ${olderThanArg}` : "";
    console.log(`No fit-cli EC2 instances${scope}${ageNote} found in ${AWS_REGION}.`);
    return;
  }

  console.log(formatExistingInstancesBanner(mine, context));

  if (dryRun) {
    console.log(`\nDry run — would terminate ${mine.length} instance(s); leaving them running.`);
    return;
  }

  if (!force) {
    const confirmed = await confirm({
      promptId: "cloud-instances.remove-all.confirm",
      message: `Terminate all ${mine.length} instance(s) above? This cannot be undone.`,
      default: false,
    });
    if (!confirmed) {
      console.log("Cancelled — instances left running.");
      return;
    }
  }

  const failures: { instanceId: string; error: string }[] = [];
  for (const instance of mine) {
    try {
      await terminateInstance(instance.instanceId);
      console.log(`✓ Terminating ${instance.instanceId}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failures.push({ instanceId: instance.instanceId, error });
      console.error(`✗ Failed to terminate ${instance.instanceId}: ${error}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to terminate ${failures.length} of ${mine.length} instance(s).`);
  }
  console.log(`\n✓ Terminating ${mine.length} instance(s).`);
}

export function runCloudInstancesMain(): void {
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

    if (subcommand === "manage") {
      await cmdManage(rest);
      return;
    }

    if (subcommand === "delete") {
      await cmdDelete(rest);
      return;
    }

    if (subcommand === "remove-all") {
      await cmdRemoveAll(rest);
      return;
    }

    console.error(`Unknown subcommand: ${subcommand}\n`);
    console.error(HELP);
    process.exit(2);
  });
}

if (isMain(import.meta.url)) {
  runCloudInstancesMain();
}
