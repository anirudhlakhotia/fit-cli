/**
 * The "Run situational tests" (FIT/SIT) guided flow. Situational testing checks
 * how an SDK copes with cluster rebalances and upgrades under sustained load.
 *
 * It reuses most of the functional machinery — the performer build/run and the
 * test-driver run are identical — and differs in three places: results go to a
 * timeseries database (hosted or local), the cluster is created and managed by
 * cbdino rather than selected up front, and the test list / Maven groups are
 * flipped to the situational tests.
 *
 * Remote (EC2) execution is being added separately; this flow runs locally.
 *
 * Run this flow on its own (skipping the top-level menu; add --root <dir>):
 *   npx tsx src/workflows/fit-situational/guided/guided.ts
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
import {
  checkBuildAndRunPerformer,
  stopManagedPerformer,
  type RunningPerformer,
} from "../../performers/check-build-and-run-performer/check-build-and-run-performer.js";
import { createLocalFitExecutionContext } from "../../fit-shared/util/remote-fit-run.js";
import { runTestDriver } from "../../fit-shared/run-test-driver/run-test-driver.js";
import {
  selectFitTests,
  SITUATIONAL_TEST_PATH_PREFIX,
  type FitTestDomain,
} from "../../fit-shared/select-fit-tests/select-fit-tests.js";
import { writeAgentsGuide } from "../../fit-shared/util/write-agents-guide.js";
import { chooseResultsDatabase } from "../../fit-shared/choose-results-database/choose-results-database.js";
import { generateSituationalConfiguration } from "../util/situational-config.js";

/** Maven groups that select the cbdino-managed situational tests. */
export const SITUATIONAL_MAVEN_TEST_ARGS = [
  "-Dgroups=situational,cbDino",
  "-DexcludedGroups=openshift,capella",
] as const;

/** The situational slice of the test-driver, with its own quick sanity test. */
export const SITUATIONAL_TEST_DOMAIN: FitTestDomain = {
  includePrefix: SITUATIONAL_TEST_PATH_PREFIX,
  sanitySelector: "com.couchbase.situational.tests.VolumeTest#steadyStateKvGets",
};

/** Where the situational results show up once a run has produced data. */
export const SITUATIONAL_RESULTS_URL = "https://performance-sdk.couchbase.com/results/situational";

/** Combine artifacts, drop an AGENTS.md guide into the run directory, and return both. */
function finalize(artifacts: readonly Artifact[], details: readonly Detail[]): RunOutput {
  const combined = combineArtifacts(artifacts);
  const guide = writeAgentsGuide(combined);
  console.log(`\nWhen this run produces data, view it at:\n  ${SITUATIONAL_RESULTS_URL}`);
  return {
    artifacts: combineArtifacts(combined, [guide.artifact]),
    details: combineDetails(details, [{ label: "Results UI", value: SITUATIONAL_RESULTS_URL }]),
  };
}

/** Walk through everything needed to run FIT situational tests for one SDK. */
export async function runSituationalTests(rootDir: string): Promise<RunOutput> {
  const artifacts: Artifact[] = [];
  const details: Detail[] = [];

  const sdk = await chooseSdk();
  const execution = createLocalFitExecutionContext(rootDir);

  // checkBuildAndRunPerformer ensures the FIT + SDK repos are cloned, then builds
  // and starts the performer — the same path the functional flow takes.
  let performer: RunningPerformer | undefined;
  try {
    performer = await checkBuildAndRunPerformer(execution, sdk);
    if (!performer) {
      console.log("\nOnce the performer is ready to run, run fit-cli again.");
      return { artifacts, details };
    }
    artifacts.push(...performer.artifacts);
    console.log(
      "\nNote: for a full cbdino run the performer must share cbdino's Docker network " +
        "(usually `dinonet`) so it can reach the cluster cbdino creates.",
    );

    // Pick where results land (hosted faas.couchbase.com, or a local Docker DB).
    const database = await chooseResultsDatabase(rootDir);
    artifacts.push(...database.artifacts);
    details.push(...database.details);
    if (!database.ready) {
      return finalize(artifacts, details);
    }

    const fitConfig = generateSituationalConfiguration(database.database, rootDir);
    artifacts.push(...fitConfig.artifacts);
    details.push(...fitConfig.details);

    const testSelection = await selectFitTests(execution, SITUATIONAL_TEST_DOMAIN);
    const testRun = await runTestDriver(execution, testSelection, fitConfig.path, [...SITUATIONAL_MAVEN_TEST_ARGS]);
    artifacts.push(...testRun.artifacts);
    details.push(...testRun.details);
    return finalize(artifacts, details);
  } finally {
    await stopManagedPerformer(execution, performer);
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    return runSituationalTests(rootDir);
  });
}
