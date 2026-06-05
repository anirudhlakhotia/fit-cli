/**
 * Workflow: run FIT functional tests from a `fit` definition
 * file. This is the repeatable counterpart to the guided flow
 * (../guided/run-from-definition.ts) — same steps, but the cluster, SDK and test selection
 * all come from the file instead of being asked for. The only prompt is where
 * to execute the run: local, a clean EC2 instance, or an existing EC2 instance.
 *
 * The cluster is shared across the whole run; each iteration stands up its own
 * performer and runs its own tests. Pass an optional CSV of steps to run only
 * part of it, e.g. stand the performer up once and re-run the tests:
 *   npm run definition <file.yaml>                 # everything
 *   npm run definition <file.yaml> setup-performer # just build/run the performer
 *   npm run definition <file.yaml> run             # just run the tests
 *   npm run definition <file.yaml> setup,run       # setup (cluster+performer) then run
 *
 * Run on its own (add --root <dir> to point at another workspace):
 *   npx tsx src/workflows/fit-functional/run-from-definition/run-from-definition.ts <file.yaml> [steps]
 *
 * Note: a cbdinocluster-backed run needs the setup-cluster step to execute
 * before the run step. Existing-cluster modes (`setup.cluster.connection` and
 * `setup.cluster.useExisting`) are resolved directly from the file.
 */
import {
  combineArtifacts,
  combineDetails,
  type Artifact,
  type Detail,
  type RunOutput,
} from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliError, fitCliWarn } from "../../../util/non-fit/fit-cli-log.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import {
  localClusterCommandExecutor,
  type ClusterCommandExecutor,
} from "../../cluster/cluster-create/allocate-cluster.js";
import { runClusterDiag } from "../../cluster/cluster-diag/cluster-diag.js";
import { setupDeclarativeCluster } from "../../cluster/cluster-create/setup-declarative-cluster.js";
import {
  checkBuildAndRunPerformer,
  stopManagedPerformer,
  type RunningPerformer,
} from "../../performers/check-build-and-run-performer/check-build-and-run-performer.js";
import { generateFitConfiguration } from "../../fit-shared/fit-configuration/generate-fit-configuration.js";
import { createFitExecutionContext, type FitExecutionContext } from "../../fit-shared/util/remote-fit-run.js";
import { loadDefinition } from "../definition/parse-definition.js";
import { resolveDefinition, type ResolvedDefinition, type ResolvedIteration } from "../definition/resolve-definition.js";
import { parseSteps, type DefinitionStep } from "../definition/steps.js";
import { runTestDriver } from "../../fit-shared/run-test-driver/run-test-driver.js";
import {
  detectClusterDockerEnvironment,
  runPerformerClusterSanityCheck,
} from "../../fit-shared/util/performer-cluster-sanity.js";
import { writeAgentsGuide } from "../../fit-shared/util/write-agents-guide.js";
import { selectExecutionTarget } from "../select-execution-target/select-execution-target.js";

/** Describe the shared cluster for the run header / setup-cluster step. */
function clusterLabel(resolved: ResolvedDefinition): string {
  const cluster = resolved.iterations.find((iteration) => iteration.cluster)?.cluster;
  if (cluster) {
    return `${cluster.scheme}://${cluster.defaultHostname} (${cluster.flavour})`;
  }
  if (resolved.clusterMode === "connection") {
    return "existing cluster from setup.cluster.connection";
  }
  if (resolved.clusterMode === "useExisting") {
    return "existing cluster from iteration fitConfig.clusterAccess";
  }
  if (resolved.clusterMode === "cbdinocluster") {
    return "cbdinocluster plan (allocated during setup-cluster)";
  }
  return "none configured";
}

function applySharedCluster(
  resolved: ResolvedDefinition,
  cluster: NonNullable<ResolvedIteration["cluster"]>,
): ResolvedDefinition {
  return {
    ...resolved,
    iterations: resolved.iterations.map((iteration) => ({ ...iteration, cluster })),
  };
}

function missingClusterMessage(clusterMode: ResolvedDefinition["clusterMode"]): string {
  if (clusterMode === "cbdinocluster") {
    return (
      "\nrun: no cluster available yet, so a FITConfiguration can't be generated. " +
      "Run the setup-cluster step first so fit-cli can allocate the cbdinocluster."
    );
  }
  return (
    "\nrun: no cluster available, so a FITConfiguration can't be generated. " +
    "Add setup.cluster.connection or setup.cluster.useExisting to run the tests. Skipping."
  );
}

export function cbdinoclusterSetupFailed(
  resolved: ResolvedDefinition,
  steps: readonly DefinitionStep[],
): boolean {
  return (
    resolved.clusterMode === "cbdinocluster" &&
    steps.includes("setup-cluster") &&
    resolved.iterations.some((iteration) => !iteration.cluster)
  );
}

/**
 * Combine the run's artifacts, drop an AGENTS.md guide describing them into the
 * run directory, and return the combined list including that guide.
 */
export function finalizeRunFromDefinition(
  artifacts: readonly Artifact[],
  details: readonly Detail[],
  runDir?: string,
): RunOutput {
  const combined = combineArtifacts(artifacts);
  const guide = writeAgentsGuide(combined, runDir);
  return { artifacts: combineArtifacts(combined, [guide.artifact]), details: combineDetails(details) };
}

/** Print what an iteration resolved to, so a CI log shows the run's inputs. */
function announce(
  index: number,
  total: number,
  resolved: ResolvedDefinition,
  iteration: ResolvedIteration,
  steps: readonly DefinitionStep[],
): void {
  const { testSelection } = iteration;
  const testsLabel = testSelection.mavenTestSelector
    ? `${testSelection.selectedTests.length} test(s): ${testSelection.mavenTestSelector}`
    : "all tests";
  console.log(`\n=== Iteration ${index + 1}/${total} — steps: ${steps.join(", ")} ===`);
  console.log(`  SDK:     ${iteration.sdk.name}`);
  console.log(`  Tests:   ${testsLabel}`);
  console.log(`  Performer port: ${iteration.performerPort}`);
  if (iteration.performerVersion) {
    console.log(`  Performer version: ${iteration.performerVersion}`);
  }
  if (resolved.fitPerformerGerritRef) {
    console.log(`  FIT Gerrit ref: ${resolved.fitPerformerGerritRef}`);
  }
}

/**
 * The setup-cluster step. Existing-cluster modes only report what the file
 * resolved to; a cbdinocluster plan is allocated here and then shared across
 * every iteration in the run.
 */
export async function setupCluster(
  resolved: ResolvedDefinition,
  execution: ClusterCommandExecutor = localClusterCommandExecutor(),
  setupDeclarativeClusterFn: typeof setupDeclarativeCluster = setupDeclarativeCluster,
): Promise<RunOutput & { resolved: ResolvedDefinition }> {
  if (resolved.clusterMode === "connection") {
    fitCliWarn("\nsetup-cluster: using the existing cluster from setup.cluster.connection; nothing to allocate.");
    return { resolved, artifacts: [], details: [] };
  }
  if (resolved.clusterMode === "useExisting") {
    fitCliWarn("\nsetup-cluster: using the existing cluster described by iteration fitConfig.clusterAccess; nothing to allocate.");
    return { resolved, artifacts: [], details: [] };
  }
  if (resolved.cbdinocluster) {
    const outcome = await setupDeclarativeClusterFn(resolved.cbdinocluster, execution);
    return {
      resolved: outcome.cluster ? applySharedCluster(resolved, outcome.cluster) : resolved,
      artifacts: outcome.artifacts,
      details: outcome.details,
    };
  }
  fitCliWarn("\nsetup-cluster: no cluster configured.");
  return { resolved, artifacts: [], details: [] };
}

/** The setup-performer step: build the performer image and start it in Docker. */
async function setupPerformer(
  execution: FitExecutionContext,
  resolved: ResolvedDefinition,
  iteration: ResolvedIteration,
  iterationIndex: number,
): Promise<RunningPerformer | undefined> {
  const clusterDockerEnvironment = iteration.cluster
    ? await detectClusterDockerEnvironment(iteration.cluster, {
        captureCommand: (command, args) => execution.capture(command, args),
        dockerCommand: execution.dockerCommand,
      })
    : undefined;
  if (clusterDockerEnvironment) {
    console.log(
      `\n→ Cluster Docker networks: ${clusterDockerEnvironment.networkNames.join(", ")} ` +
        `(containers: ${clusterDockerEnvironment.containerNames.join(", ")})`,
    );
  }
  return checkBuildAndRunPerformer(
    execution,
    iteration.sdk,
    iteration.performerVersion,
    clusterDockerEnvironment?.networkNames[0],
    iteration.onPortInUse,
    iteration.performerPort,
    iterationIndex,
    resolved.fitPerformerGerritRef,
  );
}

/** The run step: generate a FITConfiguration, sanity-check, and run the test driver. */
interface RunTestsDependencies {
  runClusterDiagFn?: typeof runClusterDiag;
  generateFitConfigurationFn?: typeof generateFitConfiguration;
  runPerformerClusterSanityCheckFn?: typeof runPerformerClusterSanityCheck;
  runTestDriverFn?: typeof runTestDriver;
}

export async function runTests(
  execution: FitExecutionContext,
  clusterMode: ResolvedDefinition["clusterMode"],
  iteration: ResolvedIteration,
  performer: RunningPerformer | undefined,
  iterationIndex: number,
  dependencies: RunTestsDependencies = {},
): Promise<RunOutput> {
  if (!iteration.cluster) {
    fitCliWarn(missingClusterMessage(clusterMode));
    return { artifacts: [], details: [] };
  }

  const runClusterDiagFn = dependencies.runClusterDiagFn ?? runClusterDiag;
  const generateFitConfigurationFn = dependencies.generateFitConfigurationFn ?? generateFitConfiguration;
  const runPerformerClusterSanityCheckFn =
    dependencies.runPerformerClusterSanityCheckFn ?? runPerformerClusterSanityCheck;
  const runTestDriverFn = dependencies.runTestDriverFn ?? runTestDriver;

  const artifacts: Artifact[] = [];
  const details: Detail[] = [];

  if (!(await runClusterDiagFn(iteration.cluster))) {
    return { artifacts, details };
  }

  const fitConfig = generateFitConfigurationFn(
    iteration.cluster,
    execution.rootDir,
    iteration.performerPort,
    iteration.fitConfig,
    iterationIndex,
  );
  artifacts.push(...fitConfig.artifacts);
  details.push(...fitConfig.details);

  const performerSanity = await runPerformerClusterSanityCheckFn(iteration.cluster, performer?.containerId, {
    captureCommand: (command, args) => execution.capture(command, args),
    dockerCommand: execution.dockerCommand,
  });
  artifacts.push(...performerSanity.artifacts);
  if (!performerSanity.ok) {
    return { artifacts, details };
  }

  const testRun = await runTestDriverFn(
    execution,
    iteration.testSelection,
    fitConfig.path,
    iteration.extraMavenArgs,
    iterationIndex,
  );
  artifacts.push(...testRun.artifacts);
  details.push(...testRun.details);
  return { artifacts, details };
}

/** Run the per-iteration steps (setup-performer, run) for one iteration. */
async function runIteration(
  execution: FitExecutionContext,
  resolved: ResolvedDefinition,
  iteration: ResolvedIteration,
  steps: readonly DefinitionStep[],
  iterationIndex: number,
): Promise<RunOutput> {
  const artifacts: Artifact[] = [];
  const details: Detail[] = [];
  let performer: RunningPerformer | undefined;

  // Only tear the performer down when this invocation both started it and ran
  // tests against it. A bare `setup-performer` leaves it up for a later `run`.
  const stopPerformerAfter = steps.includes("setup-performer") && steps.includes("run");

  try {
    for (const step of steps) {
      if (step === "setup-performer") {
        performer = await setupPerformer(execution, resolved, iteration, iterationIndex);
        if (!performer) {
          fitCliError("\nThe performer isn't ready to run; stopping this iteration.");
          break;
        }
        artifacts.push(...performer.artifacts);
      } else if (step === "run") {
        const output = await runTests(execution, resolved.clusterMode, iteration, performer, iterationIndex);
        artifacts.push(...output.artifacts);
        details.push(...output.details);
      }
    }
    return { artifacts: combineArtifacts(artifacts), details: combineDetails(details) };
  } finally {
    if (stopPerformerAfter) {
      await stopManagedPerformer(execution, performer);
    } else if (performer?.logFile) {
      console.log(`\nPerformer left running. Logs:\n  ${performer.logFile}`);
    }
  }
}

/** Run FIT functional tests as described by the definition file at `definitionPath`. */
export async function runFromDefinition(
  definitionPath: string,
  rootDir: string,
  steps: DefinitionStep[] = parseSteps(),
): Promise<RunOutput> {
  let resolved = resolveDefinition(loadDefinition(definitionPath));
  console.log(`\nRunning FIT functional tests from definition:\n  ${definitionPath}`);
  console.log(`  Cluster: ${clusterLabel(resolved)}`);

  const artifacts: Artifact[] = [];
  const details: Detail[] = [];
  const executionTarget = await selectExecutionTarget();
  artifacts.push(...executionTarget.artifacts);
  details.push(...executionTarget.details);
  if (!executionTarget.ready) {
    return { artifacts: combineArtifacts(artifacts), details: combineDetails(details) };
  }

  try {
    const execution = await createFitExecutionContext(executionTarget.target, rootDir, resolved.iterations[0].sdk);
    artifacts.push(...execution.artifacts);
    details.push(...execution.details);

    // The cluster is shared across iterations, so set it up once up front.
    if (steps.includes("setup-cluster")) {
      const setup = await setupCluster(resolved, execution);
      resolved = setup.resolved;
      artifacts.push(...setup.artifacts);
      details.push(...setup.details);
      if (cbdinoclusterSetupFailed(resolved, steps)) {
        fitCliError("\nsetup-cluster didn't produce a cluster, so this definition run can't continue.");
        throw new Error("setup-cluster failed");
      }
    }

    const iterationSteps = steps.filter((step) => step !== "setup-cluster");
    for (const [index, iteration] of resolved.iterations.entries()) {
      announce(index, resolved.iterations.length, resolved, iteration, steps);
      if (iterationSteps.length === 0) {
        continue;
      }
      const output = await runIteration(execution, resolved, iteration, iterationSteps, index);
      artifacts.push(...output.artifacts);
      details.push(...output.details);
    }

    return finalizeRunFromDefinition(artifacts, details);
  } finally {
    await executionTarget.cleanup();
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir, positionals } = rootDirFromArgv(process.argv.slice(2));
    const [definitionPath, stepsCsv, ...rest] = positionals;
    if (!definitionPath || rest.length > 0) {
      console.error(
        "Usage: tsx src/workflows/fit-functional/run-from-definition/run-from-definition.ts <file.yaml> [steps] [--root <dir>] [--interactive]\n" +
          "  steps: CSV of setup, setup-cluster, setup-performer, run (default: all)",
      );
      process.exit(2);
    }
    return runFromDefinition(definitionPath, rootDir, parseSteps(stepsCsv));
  });
}
