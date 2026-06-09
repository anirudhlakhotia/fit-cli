/**
 * Workflow: decide where the FIT run should execute — the user's own machine, a
 * clean, throwaway AWS EC2 instance, or an EC2 instance that's already running
 * (e.g. one a previous run left up for debugging). Returns an ExecutionTarget the
 * rest of the flow can run commands against, plus a cleanup handle: a no-op for
 * local and for an existing instance (the user brought it, so we leave it alone);
 * for a freshly provisioned box, enough information for the caller to decide
 * whether to terminate it or keep it for debugging.
 *
 * The EC2 paths need AWS credentials. We read them from the normal environment
 * and the user's fit-cli config file; if they're missing or invalid we
 * say so and loop back to the choice, so the user can fall back to local
 * without re-running.
 *
 * Run this workflow on its own (picks a target, runs `uname -a` on it, cleans up):
 *   npx tsx src/workflows/fit-functional/select-execution-target/select-execution-target.ts
 */
import { type RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { ensureFitCliConfigEnv } from "../../../util/fit/config.js";
import { fitCliError, fitCliWarn } from "../../../util/non-fit/fit-cli-log.js";
import { input, select } from "../../../util/non-fit/prompts.js";
import { LocalTarget } from "../../../util/non-fit/local-target.js";
import { resolveRegion, type AwsOptions } from "../../../util/non-fit/aws/aws-cli.js";
import { checkCredentials } from "../../../util/non-fit/aws/identity.js";
import { listInstances } from "../../../util/non-fit/aws/list-instances.js";
import { terminateInstance } from "../../../util/non-fit/aws/terminate-instance.js";
import { type InstanceInfo } from "../../../util/non-fit/aws/parse-instance.js";
import { type ExecutionTarget } from "../../../util/non-fit/target.js";
import { FIT_INSTANCE_USER, provisionFitInstance } from "../../../util/fit/aws/fit-instance.js";
import { RemoteTarget } from "../../../util/non-fit/remote-target.js";
import { waitForSsh, type RemoteHost } from "../../../util/non-fit/ssh.js";
import type { ResolvedInstance } from "../../fit-shared/definition/resolve-definition.js";
import type { ResumeTargetState } from "../run-from-definition/resume-state.js";

/**
 * How to tear down (or leave up) the chosen target. The run owns the decision —
 * see the unified "leave everything up?" prompt in run-from-definition — so this
 * carries the primitives rather than prompting itself. `terminate` is present
 * only for an instance fit-cli is responsible for.
 */
export interface ExecutionTargetTeardown {
  kind: "local" | "remote";
  instanceId?: string;
  address?: string;
  region?: string;
  user?: string;
  identityFile?: string;
  /** Terminate the instance (and delete its key when known). */
  terminate?: () => Promise<void>;
}

/** The outcome of choosing where to run. */
export type ExecutionTargetOutcome =
  /** A target is ready; `teardown` carries how to dispose of (or keep) it. */
  | (RunOutput & { ready: true; target: ExecutionTarget; teardown: ExecutionTargetTeardown })
  /** No target is ready; the reason was already printed. */
  | (RunOutput & { ready: false });

type TargetChoice = "local" | "ec2" | "existing";

/** Sentinel value for the "type the connection details myself" choice. */
const MANUAL_INSTANCE = "__manual__";

function promptId(attempt: number, suffix: string): string {
  return `execution-target.attempt-${attempt}.${suffix}`;
}

const LOCAL_TEARDOWN: ExecutionTargetTeardown = { kind: "local" };

/**
 * Reconnect to the target a previous run used, without prompting — the resume
 * path. Local is immediate; a remote target is reached over SSH using the saved
 * address, user and key, and is verified reachable before returning.
 */
export async function reconnectExecutionTarget(target: ResumeTargetState): Promise<ExecutionTargetOutcome> {
  if (target.kind === "local") {
    return { ready: true, target: new LocalTarget(), teardown: LOCAL_TEARDOWN, artifacts: [], details: [] };
  }

  const { address, user, identityFile, instanceId, region } = target;
  if (!address || !user || !identityFile) {
    fitCliError("\nresume: the saved run state is missing the instance address, user or key.");
    return { ready: false, artifacts: [], details: [] };
  }

  const remoteHost: RemoteHost = { host: address, user, identityFile, agentForwarding: true };
  process.stdout.write(`Reconnecting to ${user}@${address}...`);
  if (!(await waitForSsh(remoteHost))) {
    console.log(" unreachable");
    fitCliError(`\nresume: couldn't reach ${user}@${address} over SSH. The instance may be stopped or gone.`);
    return { ready: false, artifacts: [], details: [] };
  }
  console.log(" ready");

  const teardown: ExecutionTargetTeardown = {
    kind: "remote",
    ...(instanceId ? { instanceId } : {}),
    address,
    ...(region ? { region } : {}),
    user,
    identityFile,
    ...(instanceId
      ? { terminate: () => terminateInstance(instanceId, region ? { region } : {}) }
      : {}),
  };
  return {
    ready: true,
    target: new RemoteTarget(remoteHost),
    teardown,
    artifacts: [],
    details: [{ label: "SSH debug command", value: `ssh -i ${identityFile} ${user}@${address}` }],
  };
}

/**
 * Acquire the execution target a single cycle declared in its definition, without
 * prompting for *which* kind of target to use — that choice lives in the file. A
 * localhost cycle (or any cycle when `forceLocalhost` is set) runs here on this
 * machine; an AWS cycle checks credentials and provisions a clean EC2 box whose
 * key lands under the cycle's run directory. Returns `ready: false` (reason already
 * printed) if EC2 credentials are unusable or provisioning fails, so the caller can
 * treat it as fatal to the cycle.
 */
export async function resolveCycleExecutionTarget(
  instance: ResolvedInstance,
  forceLocalhost: boolean,
  cycleIndex: number,
): Promise<ExecutionTargetOutcome> {
  if (forceLocalhost || instance.kind === "localhost") {
    return { ready: true, target: new LocalTarget(), teardown: LOCAL_TEARDOWN, artifacts: [], details: [] };
  }

  // AWS EC2 needs credentials, from the environment or config.yaml.
  await ensureFitCliConfigEnv({
    promptId: `execution-target.cycle-${cycleIndex}.config.create`,
    promptMessage: "No fit-cli config found. Run `npm run init` now before using EC2?",
  });
  const creds = await checkCredentials();
  if (!creds.ok) {
    fitCliError(`\nCan't use EC2 for this cycle: ${creds.message}`);
    console.log(
      "Add your AWS credentials with `npm run init`, or re-run with the localhost override to run everything locally.\n",
    );
    return { ready: false, artifacts: [], details: [] };
  }
  console.log(`\n✓ Using AWS account ${creds.identity.account} (${creds.identity.arn})`);

  try {
    const provisioned = await provisionFitInstance({
      instanceIndex: cycleIndex,
      ...(instance.instanceType ? { instanceType: instance.instanceType } : {}),
      ...(instance.region ? { region: instance.region } : {}),
    });
    const teardown: ExecutionTargetTeardown = {
      kind: "remote",
      instanceId: provisioned.instanceId,
      address: provisioned.address,
      region: instance.region ?? resolveRegion(),
      user: FIT_INSTANCE_USER,
      identityFile: provisioned.keyPath,
      terminate: provisioned.terminate,
    };
    return { ready: true, target: provisioned.target, teardown, artifacts: provisioned.artifacts, details: provisioned.details };
  } catch (err) {
    fitCliError(`\n✗ Could not provision an EC2 instance: ${err instanceof Error ? err.message : String(err)}`);
    return { ready: false, artifacts: [], details: [] };
  }
}

/**
 * Ask where the FIT run should execute and return a ready-to-use target. Local
 * is immediate; the EC2 paths check credentials (looping back to the prompt if
 * they're missing) and then either provision a fresh instance or connect to one
 * that's already running.
 */
export async function selectExecutionTarget(): Promise<ExecutionTargetOutcome> {
  let attempt = 1;
  for (;;) {
    const choice = await select<TargetChoice>({
      promptId: promptId(attempt, "choose"),
      message: "Where should this FIT run execute?",
      choices: [
        { name: "A clean AWS EC2 instance", value: "ec2" },
        { name: "This machine (local)", value: "local" },
          // Temporarily hidden as not sure how well this works currently..  Also it's maybe better handled with resume.
        // { name: "An existing EC2 instance", value: "existing" },
      ],
    });

    if (choice === "local") {
      return { ready: true, target: new LocalTarget(), teardown: LOCAL_TEARDOWN, artifacts: [], details: [] };
    }

    // Both EC2 paths need credentials, from the environment or config.yaml.
    await ensureFitCliConfigEnv({
      promptId: promptId(attempt, "config.create"),
      promptMessage: "No fit-cli config found. Run `npm run init` now before using EC2?",
    });
    const creds = await checkCredentials();
    if (!creds.ok) {
      fitCliError(`\nCan't use EC2: ${creds.message}`);
      console.log("Add your AWS credentials with `npm run init`, or use your normal AWS environment/config, then choose again.\n");
      attempt += 1;
      continue; // back to the target prompt
    }
    console.log(`\n✓ Using AWS account ${creds.identity.account} (${creds.identity.arn})`);

    if (choice === "existing") {
      const outcome = await connectExistingInstance(attempt);
      if (outcome === "back") {
        attempt += 1;
        continue; // back to the target prompt
      }
      return outcome;
    }

    try {
      const instance = await provisionFitInstance();
      const teardown: ExecutionTargetTeardown = {
        kind: "remote",
        instanceId: instance.instanceId,
        address: instance.address,
        region: resolveRegion(),
        user: FIT_INSTANCE_USER,
        identityFile: instance.keyPath,
        terminate: instance.terminate,
      };
      return { ready: true, target: instance.target, teardown, artifacts: instance.artifacts, details: instance.details };
    } catch (err) {
      console.error(`\n✗ Could not provision an EC2 instance: ${err instanceof Error ? err.message : String(err)}`);
      return { ready: false, artifacts: [], details: [] };
    }
  }
}

/**
 * Connect to an already-running EC2 instance the user supplies — typically one a
 * previous run left up for debugging. We list the fit-cli–owned boxes so they can
 * be picked from a menu (or the address typed by hand), then ask for the SSH key
 * and login user and verify the box is reachable. Cleanup is a no-op: the user
 * brought this instance, so tearing it down isn't ours to do.
 *
 * Returns "back" if the user wants to return to the target prompt (e.g. SSH never
 * came up), so the caller can loop without re-running.
 */
async function connectExistingInstance(attempt: number): Promise<ExecutionTargetOutcome | "back"> {
  const region = resolveRegion();
  const awsOptions: AwsOptions = region ? { region } : {};

  let running: InstanceInfo[];
  try {
    running = (await listInstances(undefined, awsOptions)).filter(
      (instance) => instance.state === "running" && (instance.publicDns || instance.publicIp),
    );
  } catch (err) {
    fitCliError(`\nCould not list fit-cli instances: ${err instanceof Error ? err.message : String(err)}\n`);
    return "back"; // back to the target prompt
  }

  if (running.length === 0) {
    fitCliWarn("\nNo running fit-cli EC2 instances found to reuse — pick another way to run.\n");
    return "back"; // back to the target prompt
  }

  const address = await select<string>({
    promptId: promptId(attempt, "existing.choose"),
    message: "Which instance should this FIT run use?",
    choices: [
      ...running.map((instance) => {
        const addr = instance.publicDns || instance.publicIp!;
        return { name: `${instance.instanceId} (${addr})`, value: addr };
      }),
      { name: "Enter an address manually", value: MANUAL_INSTANCE },
    ],
  });

  const host = address === MANUAL_INSTANCE
    ? await input({
        promptId: promptId(attempt, "existing.host"),
        message: "Instance public DNS or IP address:",
        validate: (value) => (value.trim().length > 0 ? true : "Enter a host or IP."),
      }).then((value) => value.trim())
    : address;

  const user = await input({
    promptId: promptId(attempt, "existing.user"),
    message: "SSH login user:",
    default: FIT_INSTANCE_USER,
  }).then((value) => value.trim() || FIT_INSTANCE_USER);

  const identityFile = await input({
    promptId: promptId(attempt, "existing.key"),
    message: "Path to the SSH private key (.pem):",
    validate: (value) => (value.trim().length > 0 ? true : "Enter the path to the private key."),
  }).then((value) => value.trim());

  const remoteHost: RemoteHost = { host, user, identityFile, agentForwarding: true };

  process.stdout.write("Checking SSH...");
  if (!(await waitForSsh(remoteHost))) {
    console.log(" unreachable");
    fitCliError(`\nCouldn't reach ${user}@${host} over SSH. Check the address, key and that the box is up.\n`);
    return "back";
  }
  console.log(" ready");

  console.log(`\n✓ Connected to existing instance ${user}@${host}`);
  // The user brought this instance, so fit-cli won't terminate it — no `terminate`.
  return {
    ready: true,
    target: new RemoteTarget(remoteHost),
    teardown: { kind: "remote", address: host, user, identityFile },
    artifacts: [],
    details: [{ label: "SSH debug command", value: `ssh -i ${identityFile} ${user}@${host}` }],
  };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const outcome = await selectExecutionTarget();
    if (!outcome.ready) {
      process.exit(1);
    }
    console.log(`\nTarget: ${outcome.target.description} (${outcome.target.kind})`);
    await outcome.target.run("uname", ["-a"]);
    if (outcome.teardown.terminate) {
      await outcome.teardown.terminate();
    }
    return { artifacts: outcome.artifacts, details: outcome.details };
  });
}
