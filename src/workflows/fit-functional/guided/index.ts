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
import { combineArtifacts, type Artifact, type ArtifactCollection } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { FIT_PERFORMER } from "../../../util/fit/repos.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import { ensureRepo } from "../../../util/fit/ensure-repo.js";
import { ensureSdkWorkspace } from "../../../util/sdk/ensure-sdk-workspace.js";
import { selectOrCreateCluster } from "../../cluster-select-or-create/index.js";
import { checkBuildAndRunPerformer } from "../../performers/check-build-and-run-performer/index.js";
import { stopPerformerContainers } from "../../performers/stop-performer/index.js";
import { generateFitConfiguration } from "../steps/generate-fit-configuration.js";
import { selectAndRunFitTests } from "../workflows/select-and-run-fit-tests/index.js";

/** Walk through everything needed to run FIT functional tests for one SDK. */
export async function runFunctionalTests(rootDir: string): Promise<ArtifactCollection> {
  const artifacts: Artifact[] = [];

  // FIT itself must be present.
  if (!(await ensureRepo(FIT_PERFORMER, rootDir))) {
    console.log("\nOnce transactions-fit-performer is in place, run fit-cli again.");
    return { artifacts };
  }

  // Which SDK to test, and whether its performer is ready to run.
  const sdk = await chooseSdk();
  if (!(await ensureSdkWorkspace(sdk, rootDir))) {
    console.log("\nOnce the SDK workspace repos are in place, run fit-cli again.");
    return { artifacts };
  }

  const performer = await checkBuildAndRunPerformer(rootDir, sdk);
  if (!performer) {
    console.log("\nOnce the performer is ready to run, run fit-cli again.");
    return { artifacts };
  }
  artifacts.push(...performer.artifacts);

  try {
    // Existing cluster, or create a new one with cbdinocluster.
    const outcome = await selectOrCreateCluster();
    artifacts.push(...outcome.artifacts);
    if (!outcome.ready) {
      return { artifacts: combineArtifacts(artifacts) };
    }
    const fitConfig = generateFitConfiguration(outcome.cluster, rootDir);
    artifacts.push(...fitConfig.artifacts);

    const testRun = await selectAndRunFitTests(rootDir, fitConfig.path);
    artifacts.push(...testRun.artifacts);
    return { artifacts: combineArtifacts(artifacts) };
  } finally {
    await stopPerformerContainers([performer.containerId]);
    console.log(`\nPerformer logs:\n  ${performer.logFile}`);
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    return runFunctionalTests(rootDir);
  });
}
