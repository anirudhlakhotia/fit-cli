/**
 * Workflow: decide where the FIT run should execute — the user's own machine, or
 * a clean, throwaway AWS EC2 instance. Returns an ExecutionTarget the rest of the
 * flow can run commands against, plus a cleanup handle (a no-op for local; for
 * EC2, a prompt to keep the box for debugging or tear it down).
 *
 * The EC2 path needs AWS credentials. We read them from the normal environment
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
import { confirm, select } from "../../../../util/non-fit/prompts.js";
import { LocalTarget } from "../../../../util/non-fit/local-target.js";
import { resolveRegion } from "../../../../util/non-fit/aws/aws-cli.js";
import { checkCredentials } from "../../../../util/non-fit/aws/identity.js";
import { type ExecutionTarget } from "../../../../util/non-fit/target.js";
import { provisionFitInstance } from "../../../../util/fit/aws/fit-instance.js";

/** The outcome of choosing where to run. */
export type ExecutionTargetOutcome =
  /** A target is ready; call `cleanup` when the run is done. */
  | (RunOutput & { ready: true; target: ExecutionTarget; cleanup: () => Promise<void> })
  /** No target is ready; the reason was already printed. */
  | (RunOutput & { ready: false });

type TargetChoice = "local" | "ec2";

/**
 * Ask where the FIT run should execute and return a ready-to-use target. Local
 * is immediate; EC2 checks credentials (looping back to the prompt if they're
 * missing) and provisions a fresh instance.
 */
export async function selectExecutionTarget(): Promise<ExecutionTargetOutcome> {
  for (;;) {
    const choice = await select<TargetChoice>({
      promptId: "execution-target.choose",
      message: "Where should this FIT run execute?",
      choices: [
        { name: "This machine (local)", value: "local" },
        { name: "A clean AWS EC2 instance", value: "ec2" },
      ],
    });

    if (choice === "local") {
      return { ready: true, target: new LocalTarget(), cleanup: async () => {}, artifacts: [], details: [] };
    }

    // EC2: credentials come from the environment or config.yaml.
    await ensureFitCliConfigEnv({
      promptId: "execution-target.config.create",
      promptMessage: "No fit-cli config found. Run `npm run init` now before using EC2?",
    });
    const creds = await checkCredentials();
    if (!creds.ok) {
      console.log(`\n✗ Can't use EC2: ${creds.message}`);
      console.log("Add your AWS credentials with `npm run init`, or use your normal AWS environment/config, then choose again.\n");
      continue; // back to the local-vs-EC2 prompt
    }
    console.log(`\n✓ Using AWS account ${creds.identity.account} (${creds.identity.arn})`);

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
