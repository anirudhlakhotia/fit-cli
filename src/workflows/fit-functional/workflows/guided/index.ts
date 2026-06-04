/**
 * The "Run functional tests" guided flow. This orchestrates the steps needed to
 * run FIT functional tests for one SDK. Generic steps it reuses live under
 * src/util/; the FIT-functional steps live under ../steps/
 * alongside this guided flow.
 *
 * Run this flow on its own (skipping the top-level menu; add --root <dir> to
 * point at another workspace):
 *   npx tsx src/workflows/fit-functional/guided/index.ts
 */
import {
  combineArtifacts,
  combineDetails,
  type Artifact,
  type Detail,
  type RunOutput,
} from "../../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../../util/non-fit/cli.js";
import { FIT_PERFORMER } from "../../../../util/fit/repos.js";
import { rootDirFromArgv } from "../../../../util/fit/root.js";
import { chooseSdk } from "../../../../util/sdk/choose-sdk.js";
import { ensureRepo } from "../../../../util/fit/ensure-repo.js";
import { ensureSdkWorkspace } from "../../../../util/sdk/ensure-sdk-workspace.js";
import { selectOrCreateCluster } from "../../../cluster/cluster-select-or-create/index.js";
import { checkBuildAndRunPerformer } from "../../../performers/check-build-and-run-performer/index.js";
import { stopPerformerContainers } from "../../../performers/stop-performer/index.js";
import { generateFitConfiguration } from "../../../fit-shared/fit-configuration/generate-fit-configuration.js";
import { writeAgentsGuide } from "../../../fit-shared/write-agents-guide.js";
import { selectAndRunFitTests } from "../../../fit-shared/select-and-run-fit-tests/index.js";
import { selectExecutionTarget } from "../select-execution-target/index.js";

/**
 * Combine the run's artifacts, drop an AGENTS.md guide describing them into the
 * run directory, and return the combined list including that guide.
 */
function finalize(artifacts: readonly Artifact[], details: readonly Detail[]): RunOutput {
  const combined = combineArtifacts(artifacts);
  const guide = writeAgentsGuide(combined);
  return { artifacts: combineArtifacts(combined, [guide.artifact]), details: combineDetails(details) };
}

/** Walk through everything needed to run FIT functional tests for one SDK. */
export async function runFunctionalTests(rootDir: string): Promise<RunOutput> {
  const artifacts: Artifact[] = [];
  const details: Detail[] = [];

  // First: where should this run execute — locally, or on a clean EC2 instance?
  const executionTarget = await selectExecutionTarget();
  artifacts.push(...executionTarget.artifacts);
  details.push(...executionTarget.details);
  if (!executionTarget.ready) {
    return { artifacts, details };
  }
  const { target, cleanup } = executionTarget;
  if (target.kind === "remote") {
    console.log(
      "\n⚠ Running the FIT suite *on* the remote instance isn't wired up yet (that's the next phase).\n" +
        "  The EC2 box above is provisioned and SSH-able; the steps below execute locally for now.\n",
    );
  }

  try {
    // FIT itself must be present.
    if (!(await ensureRepo(FIT_PERFORMER, rootDir))) {
      console.log("\nOnce transactions-fit-performer is in place, run fit-cli again.");
      return { artifacts, details };
    }

    // Which SDK to test, and whether its performer is ready to run.
    const sdk = await chooseSdk();
    if (!(await ensureSdkWorkspace(sdk, rootDir))) {
      console.log("\nOnce the SDK workspace repos are in place, run fit-cli again.");
      return { artifacts, details };
    }

    const performer = await checkBuildAndRunPerformer(rootDir, sdk);
    if (!performer) {
      console.log("\nOnce the performer is ready to run, run fit-cli again.");
      return { artifacts, details };
    }
    artifacts.push(...performer.artifacts);
    details.push(...performer.details);

    try {
      // Existing cluster, or create a new one with cbdinocluster.
      const outcome = await selectOrCreateCluster();
      artifacts.push(...outcome.artifacts);
      details.push(...outcome.details);
      if (!outcome.ready) {
        return finalize(artifacts, details);
      }
      const fitConfig = generateFitConfiguration(outcome.cluster, rootDir);
      artifacts.push(...fitConfig.artifacts);
      details.push(...fitConfig.details);

      const testRun = await selectAndRunFitTests(rootDir, fitConfig.path);
      artifacts.push(...testRun.artifacts);
      details.push(...testRun.details);
      return finalize(artifacts, details);
    } finally {
      if (performer.containerId) {
        await stopPerformerContainers([performer.containerId]);
      }
      if (performer.logFile) {
        console.log(`\nPerformer logs:\n  ${performer.logFile}`);
      }
    }
  } finally {
    // Tear down (or keep, if the user wants to debug) the EC2 instance.
    await cleanup();
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    return runFunctionalTests(rootDir);
  });
}
