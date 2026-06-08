/**
 * The "Run functional tests" guided flow. This orchestrates the steps needed to
 * run FIT functional tests for one SDK. Generic steps it reuses live under
 * src/util/; the FIT-functional steps live under ../steps/
 * alongside this guided flow.
 *
 * Run this flow on its own (skipping the top-level menu; add --root <dir> to
 * point at another workspace):
 *   npx tsx src/workflows/fit-functional/guided/guided.ts
 */
import {
  combineArtifacts,
  combineDetails,
  type Artifact,
  type Detail,
  type RunOutput,
} from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import { selectOrCreateCluster } from "../../cluster/cluster-select-or-create/cluster-select-or-create.js";
import {
  checkBuildAndRunPerformer,
  stopManagedPerformer,
  type RunningPerformer,
} from "../../performers/check-build-and-run-performer/check-build-and-run-performer.js";
import { generateFitFunctionalDefinition } from "../../fit-shared/definition/generate-definition.js";
import { generateFitConfiguration } from "../../fit-shared/fit-configuration/generate-fit-configuration.js";
import { createFitExecutionContext } from "../../fit-shared/util/remote-fit-run.js";
import { runTestDriver } from "../../fit-shared/run-test-driver/run-test-driver.js";
import { selectFitTests } from "../../fit-shared/select-fit-tests/select-fit-tests.js";
import { writeAgentsGuide } from "../../fit-shared/util/write-agents-guide.js";
import {
  detectClusterDockerEnvironment,
  runPerformerClusterSanityCheck,
} from "../../fit-shared/util/performer-cluster-sanity.js";
import {
  selectExecutionTarget,
  teardownTargetInteractively,
} from "../select-execution-target/select-execution-target.js";

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

  // First: where should this run execute — locally, on a clean EC2 instance, or on an existing one?
  const executionTarget = await selectExecutionTarget();
  artifacts.push(...executionTarget.artifacts);
  details.push(...executionTarget.details);
  if (!executionTarget.ready) {
    return { artifacts, details };
  }
  const { target, teardown } = executionTarget;

  try {
    const sdk = await chooseSdk();
    const execution = await createFitExecutionContext(target, rootDir, sdk);
    artifacts.push(...execution.artifacts);
    details.push(...execution.details);
    let performer: RunningPerformer | undefined;

    try {
      // Existing cluster, or create a new one with cbdinocluster.
      const outcome = await selectOrCreateCluster();
      artifacts.push(...outcome.artifacts);
      details.push(...outcome.details);
      if (!outcome.ready) {
        return finalize(artifacts, details);
      }
      const clusterDockerEnvironment =
        execution.kind === "local" ? await detectClusterDockerEnvironment(outcome.cluster) : undefined;
      if (clusterDockerEnvironment) {
        console.log(
          `\n→ Cluster Docker networks: ${clusterDockerEnvironment.networkNames.join(", ")} ` +
            `(containers: ${clusterDockerEnvironment.containerNames.join(", ")})`,
        );
      }
      performer = await checkBuildAndRunPerformer(
        execution,
        sdk,
        undefined,
        execution.kind === "local" ? clusterDockerEnvironment?.networkNames[0] : undefined,
      );
      if (!performer) {
        console.log("\nOnce the performer is ready to run, run fit-cli again.");
        return { artifacts, details };
      }
      artifacts.push(...performer.artifacts);

      const fitConfig = generateFitConfiguration(outcome.cluster, rootDir);
      artifacts.push(...fitConfig.artifacts);
      details.push(...fitConfig.details);
      const performerSanity = await runPerformerClusterSanityCheck(
        outcome.cluster,
        performer.containerId,
        {
          captureCommand: (command, args) => execution.capture(command, args),
          dockerCommand: execution.dockerCommand,
        },
      );
      artifacts.push(...performerSanity.artifacts);
      if (!performerSanity.ok) {
        return finalize(artifacts, details);
      }

      const testSelection = await selectFitTests(execution);
      const definition = generateFitFunctionalDefinition(sdk, outcome.cluster, testSelection);
      artifacts.push(...definition.artifacts);
      details.push(...definition.details);
      const testRun = await runTestDriver(execution, testSelection, fitConfig.path);
      artifacts.push(...testRun.artifacts);
      details.push(...testRun.details);
      return finalize(artifacts, details);
    } finally {
      await stopManagedPerformer(execution, performer);
    }
  } finally {
    // Tear down (or keep, if the user wants to debug) the EC2 instance.
    await teardownTargetInteractively(teardown);
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    return runFunctionalTests(rootDir);
  });
}
