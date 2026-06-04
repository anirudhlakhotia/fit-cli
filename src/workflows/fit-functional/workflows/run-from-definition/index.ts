/**
 * Workflow: run FIT functional tests from a `fit-functional-tests` definition
 * file, with no prompting. This is the repeatable counterpart to the guided
 * flow (../guided/index.ts) — same steps, but the SDK, cluster and test
 * selection all come from the file instead of being asked for. It's the
 * recommended way to run FIT on CI.
 *
 * Run on its own (add --root <dir> to point at another workspace):
 *   npx tsx src/workflows/fit-functional/workflows/run-from-definition/index.ts <file.yaml>
 *   npm run definition <file.yaml>
 */
import {
  combineArtifacts,
  combineDetails,
  type Artifact,
  type Detail,
  type RunOutput,
} from "../../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../../util/non-fit/cli.js";
import { rootDirFromArgv } from "../../../../util/fit/root.js";
import { checkBuildAndRunPerformer, stopManagedPerformer } from "../../../performers/check-build-and-run-performer/index.js";
import { generateFitConfiguration } from "../../../fit-shared/fit-configuration/generate-fit-configuration.js";
import { createLocalFitExecutionContext } from "../../../fit-shared/remote-fit-run.js";
import { loadDefinition } from "../../definition/parse-definition.js";
import { resolveDefinition, type ResolvedDefinition } from "../../definition/resolve-definition.js";
import { runTestDriver } from "../../../fit-shared/run-test-driver/index.js";
import {
  detectClusterDockerEnvironment,
  runPerformerClusterSanityCheck,
} from "../../../fit-shared/performer-cluster-sanity.js";

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
export async function runFromDefinition(definitionPath: string, rootDir: string): Promise<RunOutput> {
  const resolved = resolveDefinition(loadDefinition(definitionPath));
  announce(definitionPath, resolved);

  const artifacts: Artifact[] = [];
  const details: Detail[] = [];
  const execution = createLocalFitExecutionContext(rootDir);
  const clusterDockerEnvironment = await detectClusterDockerEnvironment(resolved.cluster);
  if (clusterDockerEnvironment) {
    console.log(
      `\n→ Cluster Docker networks: ${clusterDockerEnvironment.networkNames.join(", ")} ` +
        `(containers: ${clusterDockerEnvironment.containerNames.join(", ")})`,
    );
  }
  const performer = await checkBuildAndRunPerformer(
    execution,
    resolved.sdk,
    resolved.performerVersion,
    clusterDockerEnvironment?.networkNames[0],
  );
  if (!performer) {
    console.log("\nOnce the performer is ready to run, run fit-cli again.");
    return { artifacts, details };
  }
  artifacts.push(...performer.artifacts);

  try {
    const fitConfig = generateFitConfiguration(resolved.cluster, rootDir);
    artifacts.push(...fitConfig.artifacts);
    details.push(...fitConfig.details);
    const performerSanity = await runPerformerClusterSanityCheck(resolved.cluster, performer.containerId, {
      captureCommand: (command, args) => execution.capture(command, args),
      dockerCommand: execution.dockerCommand,
    });
    artifacts.push(...performerSanity.artifacts);
    if (!performerSanity.ok) {
      return { artifacts: combineArtifacts(artifacts), details: combineDetails(details) };
    }

    const testRun = await runTestDriver(
      execution,
      resolved.testSelection,
      fitConfig.path,
      resolved.extraMavenArgs,
    );
    artifacts.push(...testRun.artifacts);
    details.push(...testRun.details);
    return { artifacts: combineArtifacts(artifacts), details: combineDetails(details) };
  } finally {
    await stopManagedPerformer(execution, performer);
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
