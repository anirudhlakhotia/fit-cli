/**
 * Workflow: decide where the FIT run should execute — the user's own machine, a
 * clean, throwaway AWS EC2 instance, or an EC2 instance that's already running
 * (e.g. one a previous run left up for debugging). Returns an ExecutionTarget the
 * rest of the flow can run commands against, plus a cleanup handle: a no-op for
 * local and for an existing instance (the user brought it, so we leave it alone);
 * for a freshly provisioned box, a prompt to keep it for debugging or tear it down.
 *
 * The EC2 paths need AWS credentials. We read them from the normal environment
 * and the user's fit-cli config file; if they're missing or invalid we
 * say so and loop back to the choice, so the user can fall back to local
 * without re-running.
 *
 * Run this workflow on its own (picks a target, runs `uname -a` on it, cleans up):
 *   npx tsx src/workflows/fit-functional/workflows/select-execution-target/index.ts
 */
import { type RunOutput } from "../../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../../util/non-fit/cli.js";
import { ensureFitCliConfigEnv } from "../../../../util/fit/config.js";
import { confirm, input, select } from "../../../../util/non-fit/prompts.js";
import { LocalTarget } from "../../../../util/non-fit/local-target.js";
import { resolveRegion, type AwsOptions } from "../../../../util/non-fit/aws/aws-cli.js";
import { checkCredentials } from "../../../../util/non-fit/aws/identity.js";
import { listInstances } from "../../../../util/non-fit/aws/list-instances.js";
import { type InstanceInfo } from "../../../../util/non-fit/aws/parse-instance.js";
import { type ExecutionTarget } from "../../../../util/non-fit/target.js";
import { FIT_INSTANCE_USER, provisionFitInstance } from "../../../../util/fit/aws/fit-instance.js";
import { RemoteTarget } from "../../../../util/non-fit/remote-target.js";
import { waitForSsh, type RemoteHost } from "../../../../util/non-fit/ssh.js";

/** The outcome of choosing where to run. */
export type ExecutionTargetOutcome =
  /** A target is ready; call `cleanup` when the run is done. */
  | (RunOutput & { ready: true; target: ExecutionTarget; cleanup: () => Promise<void> })
  /** No target is ready; the reason was already printed. */
  | (RunOutput & { ready: false });

type TargetChoice = "local" | "ec2" | "existing";

/** Sentinel value for the "type the connection details myself" choice. */
const MANUAL_INSTANCE = "__manual__";

/**
 * Ask where the FIT run should execute and return a ready-to-use target. Local
 * is immediate; the EC2 paths check credentials (looping back to the prompt if
 * they're missing) and then either provision a fresh instance or connect to one
 * that's already running.
 */
export async function selectExecutionTarget(): Promise<ExecutionTargetOutcome> {
  for (;;) {
    const choice = await select<TargetChoice>({
      promptId: "execution-target.choose",
      message: "Where should this FIT run execute?",
      choices: [
        { name: "This machine (local)", value: "local" },
        { name: "A clean AWS EC2 instance", value: "ec2" },
        { name: "An existing EC2 instance", value: "existing" },
      ],
    });

    if (choice === "local") {
      return { ready: true, target: new LocalTarget(), cleanup: async () => {}, artifacts: [], details: [] };
    }

    // Both EC2 paths need credentials, from the environment or config.yaml.
    await ensureFitCliConfigEnv({
      promptId: "execution-target.config.create",
      promptMessage: "No fit-cli config found. Run `npm run init` now before using EC2?",
    });
    const creds = await checkCredentials();
    if (!creds.ok) {
      console.log(`\n✗ Can't use EC2: ${creds.message}`);
      console.log("Add your AWS credentials with `npm run init`, or use your normal AWS environment/config, then choose again.\n");
      continue; // back to the target prompt
    }
    console.log(`\n✓ Using AWS account ${creds.identity.account} (${creds.identity.arn})`);

    if (choice === "existing") {
      const outcome = await connectExistingInstance();
      if (outcome === "back") {
        continue; // back to the target prompt
      }
      return outcome;
    }

    try {
      const instance = await provisionFitInstance();
      const cleanup = async (): Promise<void> => {
        const keep = await confirm({
          promptId: "execution-target.teardown.keep",
          message: `Keep EC2 instance ${instance.instanceId} running for debugging?`,
          default: false,
        });
        if (keep) {
          console.log(`\nLeaving ${instance.instanceId} running at ${instance.address}.`);
          console.log(
            `Terminate later: npx tsx src/util/non-fit/aws/terminate-instance.ts --id ${instance.instanceId} --region ${resolveRegion()}`,
          );
          return;
        }
        console.log(`\nTerminating ${instance.instanceId}...`);
        await instance.terminate();
        console.log("✓ Terminated.");
      };
      return { ready: true, target: instance.target, cleanup, artifacts: instance.artifacts, details: instance.details };
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
async function connectExistingInstance(): Promise<ExecutionTargetOutcome | "back"> {
  const region = resolveRegion();
  const awsOptions: AwsOptions = region ? { region } : {};

  let running: InstanceInfo[] = [];
  try {
    running = (await listInstances(undefined, awsOptions)).filter(
      (instance) => instance.state === "running" && (instance.publicDns || instance.publicIp),
    );
  } catch (err) {
    console.log(`\n⚠ Could not list fit-cli instances: ${err instanceof Error ? err.message : String(err)}`);
    console.log("You can still enter the connection details by hand.");
  }

  const address = await select<string>({
    promptId: "execution-target.existing.choose",
    message: running.length ? "Which instance should this FIT run use?" : "No fit-cli instances found — enter details manually.",
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
        promptId: "execution-target.existing.host",
        message: "Instance public DNS or IP address:",
        validate: (value) => (value.trim().length > 0 ? true : "Enter a host or IP."),
      }).then((value) => value.trim())
    : address;

  const user = await input({
    promptId: "execution-target.existing.user",
    message: "SSH login user:",
    default: FIT_INSTANCE_USER,
  }).then((value) => value.trim() || FIT_INSTANCE_USER);

  const identityFile = await input({
    promptId: "execution-target.existing.key",
    message: "Path to the SSH private key (.pem):",
    validate: (value) => (value.trim().length > 0 ? true : "Enter the path to the private key."),
  }).then((value) => value.trim());

  const remoteHost: RemoteHost = { host, user, identityFile };

  process.stdout.write("Checking SSH...");
  if (!(await waitForSsh(remoteHost))) {
    console.log(" unreachable");
    console.log(`\n✗ Couldn't reach ${user}@${host} over SSH. Check the address, key and that the box is up.\n`);
    return "back";
  }
  console.log(" ready");

  console.log(`\n✓ Connected to existing instance ${user}@${host}`);
  return {
    ready: true,
    target: new RemoteTarget(remoteHost),
    cleanup: () => {
      console.log(`\nLeaving existing instance ${host} as we found it (you brought it; you tear it down).`);
      return Promise.resolve();
    },
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
    await outcome.cleanup();
    return { artifacts: outcome.artifacts, details: outcome.details };
  });
}
