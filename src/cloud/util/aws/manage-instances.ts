/**
 * manage-instances — an interactive companion to list-instances: show the
 * non-terminated EC2 instances (by default the ones fit-cli owns, so you can see
 * boxes left running) and act on them, one at a time. Right now the action that
 * matters is terminate, but the loop is shaped so other per-instance actions can
 * slot in alongside it.
 *
 * This is pure plumbing over the existing aws helpers — listInstances /
 * findInstancesByKeyName to find boxes, describeInstance to inspect one, and
 * terminateInstance to reap it — plus the shared prompt wrappers so it replays
 * and runs non-interactively like every other fit-cli flow. It knows nothing
 * about FIT.
 *
 * Run on its own:
 *   bun src/cloud/util/aws/manage-instances.ts                       # fit-cli=owned
 *   bun src/cloud/util/aws/manage-instances.ts --tag env=ci
 *   bun src/cloud/util/aws/manage-instances.ts --key fit-cli-abc123
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { confirm, select } from "../../../util/non-fit/prompts.js";
import { logAwsAction, prepareAwsCli } from "./aws-cli.js";
import { describeInstance } from "./describe-instance.js";
import { findInstancesByKeyName, listInstances, LIVE_STATES } from "./list-instances.js";
import { type InstanceInfo } from "./parse-instance.js";
import { terminateInstance } from "./terminate-instance.js";

/** How to find the instances to manage: a tag (default fit-cli=owned) or a key pair. */
export type InstanceQuery =
  | { kind: "tag"; tag?: { key: string; value: string } }
  | { kind: "key"; keyName: string };

/** Run the appropriate listing for a query. */
async function findInstances(query: InstanceQuery): Promise<InstanceInfo[]> {
  return query.kind === "key"
    ? findInstancesByKeyName(query.keyName)
    : listInstances(query.tag);
}

/** A one-line, human-readable summary of an instance for a menu choice. */
export function describeInstanceLine(instance: InstanceInfo): string {
  const parts = [instance.instanceId, instance.state];
  if (instance.name) {
    parts.push(instance.name);
  }
  if (instance.instanceType) {
    parts.push(instance.instanceType);
  }
  if (instance.publicIp) {
    parts.push(instance.publicIp);
  }
  if (instance.creator) {
    parts.push(`created-by:${instance.creator}`);
  }
  return parts.join("  ·  ");
}

/** Special menu values that aren't an instance id. */
const REFRESH = "\0refresh";
const QUIT = "\0quit";

/** Per-instance actions. */
type InstanceAction = "terminate" | "details" | "back";

/** Print the current set of instances, or a friendly note when there are none. */
function reportInstances(instances: InstanceInfo[]): void {
  if (instances.length === 0) {
    console.log("No matching instances.");
    return;
  }
  console.log(`${instances.length} instance${instances.length === 1 ? "" : "s"}:`);
  for (const instance of instances) {
    console.log(`  ${describeInstanceLine(instance)}`);
  }
}

/** Ask which instance (or top-level action) the user wants to act on. */
async function chooseInstance(instances: InstanceInfo[], round: number): Promise<string> {
  return select<string>({
    promptId: `aws.manage-instances.choose-${round}`,
    message: "Pick an instance to act on",
    choices: [
      ...instances.map((instance) => ({
        name: describeInstanceLine(instance),
        value: instance.instanceId,
      })),
      { name: "↻ Refresh list", value: REFRESH },
      { name: "Quit", value: QUIT },
    ],
  });
}

/** Ask what to do with the chosen instance. */
async function chooseAction(instance: InstanceInfo, round: number): Promise<InstanceAction> {
  return select<InstanceAction>({
    promptId: `aws.manage-instances.action-${round}`,
    message: `What would you like to do with ${describeInstanceLine(instance)}?`,
    choices: [
      { name: "Show details", value: "details" },
      { name: "Terminate (delete)", value: "terminate" },
      { name: "Back", value: "back" },
    ],
  });
}

/**
 * Terminate the instance after an explicit confirmation. Returns true if it was
 * terminated, false if the user backed out.
 */
async function terminateWithConfirm(
  instance: InstanceInfo,
  round: number,
): Promise<boolean> {
  const confirmed = await confirm({
    promptId: `aws.manage-instances.confirm-terminate-${round}`,
    message: `Terminate ${describeInstanceLine(instance)}? This cannot be undone.`,
    default: false,
  });
  if (!confirmed) {
    console.log("Left it running.");
    return false;
  }
  await terminateInstance(instance.instanceId);
  console.log(`✓ Terminating ${instance.instanceId}`);
  return true;
}

/**
 * Show the instances matching a query and let the user act on them in a loop
 * until they quit. Each pass re-lists from AWS so the view stays accurate after
 * a termination.
 */
export async function manageInstances(query: InstanceQuery, creatorFilter?: string): Promise<void> {
  // Prompt ids must be unique within a run, so each pass of the loop carries its
  // own round number to keep its prompts distinct from the previous pass's.
  for (let round = 0; ; round++) {
    const all = await findInstances(query);
    const instances = creatorFilter ? all.filter((i) => i.creator === creatorFilter) : all;
    reportInstances(instances);

    const choice = await chooseInstance(instances, round);
    if (choice === QUIT) {
      return;
    }
    if (choice === REFRESH || instances.length === 0) {
      continue;
    }

    const instance = instances.find((candidate) => candidate.instanceId === choice);
    if (!instance) {
      // The instance went away between listing and choosing — just re-list.
      continue;
    }

    const action = await chooseAction(instance, round);
    if (action === "details") {
      const details = await describeInstance(instance.instanceId);
      console.log(JSON.stringify(details ?? instance, null, 2));
    } else if (action === "terminate") {
      await terminateWithConfirm(instance, round);
    }
  }
}

/** Build the query from the same flags list-instances accepts (--key / --tag). */
function queryFromArgv(argv: readonly string[]): InstanceQuery {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index !== -1 ? argv[index + 1] : undefined;
  };
  const key = flag("key");
  if (key) {
    return { kind: "key", keyName: key };
  }
  const tag = flag("tag");
  return {
    kind: "tag",
    tag: tag ? { key: tag.split("=")[0], value: tag.split("=")[1] ?? "" } : undefined,
  };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    const query = queryFromArgv(argv);
    await prepareAwsCli();
    logAwsAction(
      "Managing EC2 instances",
      query.kind === "key"
        ? { keyName: query.keyName, states: LIVE_STATES }
        : { tag: query.tag ? `${query.tag.key}=${query.tag.value}` : "fit-cli=owned", states: LIVE_STATES },
    );
    await manageInstances(query);
  });
}
