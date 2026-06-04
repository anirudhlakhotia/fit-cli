/**
 * Workflow: run FIT functional tests from a `fit-functional-tests` definition
 * file, with no prompting. This is the repeatable counterpart to the guided
 * flow (../guided/index.ts) — same steps, but the SDK, cluster and test
 * selection all come from the file instead of being asked for. It's the
 * recommended way to run FIT on CI.
 *
 * Run on its own (add --root <dir> to point at another workspace):
 *   npx tsx src/workflows/fit-functional/workflows/run-from-definition/index.ts <file.yaml>
 *   npm run definition examples/fit-functional-tests.yaml
 */
import { combineArtifacts, type Artifact, type ArtifactCollection } from "../../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../../util/non-fit/cli.js";
import { FIT_PERFORMER } from "../../../../util/fit/repos.js";
import { rootDirFromArgv } from "../../../../util/fit/root.js";
import { ensureRepo } from "../../../../util/fit/ensure-repo.js";
import { ensureSdkWorkspace } from "../../../../util/sdk/ensure-sdk-workspace.js";
import { checkBuildAndRunPerformer } from "../../../performers/check-build-and-run-performer/index.js";
import { stopPerformerContainers } from "../../../performers/stop-performer/index.js";
import { generateFitConfiguration } from "../../../fit-shared/fit-configuration/generate-fit-configuration.js";
import { loadDefinition } from "../../definition/parse-definition.js";
import { resolveDefinition, type ResolvedDefinition } from "../../definition/resolve-definition.js";
import { runTestDriver } from "../../../fit-shared/run-test-driver/index.js";

/** Print what the definition resolved to, so a CI log shows the run's inputs. */
function announce(definitionPath: string, resolved: ResolvedDefinition): void {
  const { testSelection } = resolved;
  const testsLabel = testSelection.mavenTestSelector
    ? `${testSelection.selectedTests.length} test(s): ${testSelection.mavenTestSelector}`
    : "all tests";
  console.log(`\nRunning FIT functional tests from definition:\n  ${definitionPath}\n`);
  console.log(`  SDK:     ${resolved.sdk.name}`);
  console.log(`  Cluster: ${resolved.cluster.scheme}://${resolved.cluster.defaultHostname} (${resolved.cluster.flavour})`);
  console.log(`  Tests:   ${testsLabel}`);
  if (resolved.performerVersion) {
    console.log(`  Performer version: ${resolved.performerVersion}`);
  }
}

/** Run FIT functional tests as described by the definition file at `definitionPath`. */
export async function runFromDefinition(definitionPath: string, rootDir: string): Promise<ArtifactCollection> {
  const resolved = resolveDefinition(loadDefinition(definitionPath));
  announce(definitionPath, resolved);

  const artifacts: Artifact[] = [];

  if (!(await ensureRepo(FIT_PERFORMER, rootDir))) {
    console.log("\nOnce transactions-fit-performer is in place, run fit-cli again.");
    return { artifacts };
  }

  if (!(await ensureSdkWorkspace(resolved.sdk, rootDir))) {
    console.log("\nOnce the SDK workspace repos are in place, run fit-cli again.");
    return { artifacts };
  }

  const performer = await checkBuildAndRunPerformer(rootDir, resolved.sdk, resolved.performerVersion);
  if (!performer) {
    console.log("\nOnce the performer is ready to run, run fit-cli again.");
    return { artifacts };
  }
  artifacts.push(...performer.artifacts);

  try {
    const fitConfig = generateFitConfiguration(resolved.cluster, rootDir);
    artifacts.push(...fitConfig.artifacts);

    const testRun = await runTestDriver(
      rootDir,
      resolved.testSelection,
      fitConfig.path,
      resolved.extraMavenArgs,
    );
    artifacts.push(...testRun.artifacts);
    return { artifacts: combineArtifacts(artifacts) };
  } finally {
    if (performer.containerId) {
      await stopPerformerContainers([performer.containerId]);
    }
    if (performer.logFile) {
      console.log(`\nPerformer logs:\n  ${performer.logFile}`);
    }
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir, positionals } = rootDirFromArgv(process.argv.slice(2));
    const definitionPath = positionals[0];
    if (!definitionPath || positionals.length > 1) {
      console.error(
        "Usage: tsx src/workflows/fit-functional/workflows/run-from-definition/index.ts <file.yaml> [--root <dir>]",
      );
      process.exit(2);
    }
    return runFromDefinition(definitionPath, rootDir);
  });
}
