/**
 * Workflow: run FIT tests from a `fit` definition file. This is the repeatable
 * counterpart to the guided flow (../guided/guided.ts) — same work, but the
 * cluster, SDK and test selection all come from the file instead of being asked
 * for. The only prompt is where to execute the run (local or a clean EC2
 * instance) and, at the end, whether to leave everything up for debugging and
 * resuming.
 *
 * Iterations come in two flavours. `functional` iterations test against the
 * shared cluster set up once for the run. `situational` iterations (FIT/SIT) let
 * the test-driver build and manage their own cluster via cbdino and stream
 * timeseries results to a database, so they skip the shared cluster entirely —
 * their cbdino + database settings live under each iteration's `situational`
 * block (see resolve-definition.ts and build-situational-configuration.ts).
 *
 * The cluster is shared across the whole run; each iteration stands up its own
 * performer and runs its own tests. Provisioning an instance, preparing its
 * workspace, standing up a cluster and building a performer are all slow, so a
 * run can leave them up and a later invocation can `--resume-at` a point to
 * reuse everything up to it instead of redoing the work:
 *   npm run definition <file.yaml>                                    # everything
 *   npm run definition -- --resume-at=after-instance-creation <file>  # reuse instance
 *   npm run definition -- --resume-at=after-remote-preparation <file> # reuse prepared box
 *   npm run definition -- --resume-at=after-cluster-creation <file>   # reuse cluster
 *   npm run definition -- --resume-at=after-performer <file>          # reuse cluster + performer
 *
 * Run on its own (add --root <dir> to point at another workspace):
 *   npx tsx src/workflows/fit-functional/run-from-definition/run-from-definition.ts <file.yaml>
 *
 * Existing-cluster modes (`setup.cluster.connection` and
 * `setup.cluster.useExisting`) are resolved directly from the file; a
 * cbdinocluster plan is allocated during the cluster phase and recorded in the
 * run state so `--resume-at` can pick it back up.
 */
import {
  artifactFromPath,
  combineArtifacts,
  combineDetails,
  type Artifact,
  type Detail,
  type RunOutput,
} from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliError, fitCliWarn } from "../../../util/non-fit/fit-cli-log.js";
import { createLogFile } from "../../../util/non-fit/proc.js";
import { confirm } from "../../../util/non-fit/prompts.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { resolveGithubCredentials } from "../../../util/fit/config.js";
import { terminateInstanceCommand } from "../../../util/fit/aws/lifecycle-warning.js";
import { resolveRegion } from "../../../util/non-fit/aws/aws-cli.js";
import {
  localClusterCommandExecutor,
  type ClusterCommandExecutor,
} from "../../cluster/cluster-create/allocate-cluster.js";
import { runClusterDiag } from "../../cluster/cluster-diag/cluster-diag.js";
import { removeCluster, setupDeclarativeCluster } from "../../cluster/cluster-create/setup-declarative-cluster.js";
import {
  checkBuildAndRunPerformer,
  performerLogStem,
  stopManagedPerformer,
  type RunningPerformer,
} from "../../performers/check-build-and-run-performer/check-build-and-run-performer.js";
import { generateFitConfiguration } from "../../fit-shared/fit-configuration/generate-fit-configuration.js";
import { generateSituationalConfiguration } from "../../fit-shared/fit-configuration/generate-situational-configuration.js";
import { createFitExecutionContext, type FitExecutionContext } from "../../fit-shared/util/remote-fit-run.js";
import { loadDefinition } from "../../fit-shared/definition/parse-definition.js";
import {
  resolveDefinition,
  type ResolvedDefinition,
  type ResolvedFunctionalIteration,
  type ResolvedIteration,
  type ResolvedSituationalIteration,
} from "../../fit-shared/definition/resolve-definition.js";
import { runTestDriver } from "../../fit-shared/run-test-driver/run-test-driver.js";
import {
  resolveResultsDatabase,
  SITUATIONAL_RESULTS_URL,
} from "../../fit-shared/choose-results-database/choose-results-database.js";
import {
  detectClusterDockerEnvironment,
  runPerformerClusterSanityCheck,
} from "../../fit-shared/util/performer-cluster-sanity.js";
import { writeAgentsGuide } from "../../fit-shared/util/write-agents-guide.js";
import {
  reconnectExecutionTarget,
  selectExecutionTarget,
  type ExecutionTargetTeardown,
} from "../select-execution-target/select-execution-target.js";
import {
  extractResumeAt,
  parseResumePoint,
  phasesForResumePoint,
  type ResumePoint,
} from "./resume.js";
import {
  readRunState,
  writeRunState,
  type ResumeClusterState,
  type ResumePerformerState,
  type ResumeTargetState,
  type RunState,
} from "./resume-state.js";

/** True for a functional iteration that has resolved to a concrete cluster. */
function functionalWithCluster(
  iteration: ResolvedIteration,
): iteration is ResolvedFunctionalIteration & { cluster: NonNullable<ResolvedFunctionalIteration["cluster"]> } {
  return iteration.type === "functional" && iteration.cluster !== undefined;
}

/** Describe the shared cluster for the run header / setup-cluster step. */
function clusterLabel(resolved: ResolvedDefinition): string {
  const cluster = resolved.iterations.find(functionalWithCluster)?.cluster;
  if (cluster) {
    return `${cluster.scheme}://${cluster.defaultHostname} (${cluster.flavour})`;
  }
  if (resolved.iterations.every((iteration) => iteration.type === "situational")) {
    return "none — situational iterations build their own cluster via cbdino";
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
  cluster: NonNullable<ResolvedFunctionalIteration["cluster"]>,
): ResolvedDefinition {
  return {
    ...resolved,
    // Only functional iterations test against the shared cluster; situational
    // iterations make their own via cbdino, so leave them untouched.
    iterations: resolved.iterations.map((iteration) =>
      iteration.type === "functional" ? { ...iteration, cluster } : iteration,
    ),
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
  ranSetupCluster: boolean,
): boolean {
  return (
    resolved.clusterMode === "cbdinocluster" &&
    ranSetupCluster &&
    resolved.iterations.some((iteration) => iteration.type === "functional" && !iteration.cluster)
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
): void {
  const { testSelection } = iteration;
  const testsLabel = testSelection.mavenTestSelector
    ? `${testSelection.selectedTests.length} test(s): ${testSelection.mavenTestSelector}`
    : "all tests";
  console.log(`\n=== Iteration ${index + 1}/${total} (${iteration.type}) ===`);
  console.log(`  SDK:     ${iteration.sdk.name}`);
  console.log(`  Tests:   ${testsLabel}`);
  if (iteration.type === "situational") {
    console.log(`  cbdino cluster version: ${iteration.cbdino.version}`);
    console.log(`  Results database: ${iteration.databaseMode}`);
  }
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
  githubCredentials?: { user: string; token: string },
): Promise<RunOutput & { resolved: ResolvedDefinition; clusterState?: ResumeClusterState }> {
  if (!resolved.iterations.some((iteration) => iteration.type === "functional")) {
    fitCliWarn(
      "\nsetup-cluster: only situational iterations — cbdino builds their cluster, so there's nothing to allocate.",
    );
    return { resolved, artifacts: [], details: [] };
  }
  if (resolved.clusterMode === "connection") {
    fitCliWarn("\nsetup-cluster: using the existing cluster from setup.cluster.connection; nothing to allocate.");
    return { resolved, artifacts: [], details: [] };
  }
  if (resolved.clusterMode === "useExisting") {
    fitCliWarn("\nsetup-cluster: using the existing cluster described by iteration fitConfig.clusterAccess; nothing to allocate.");
    return { resolved, artifacts: [], details: [] };
  }
  if (resolved.cbdinocluster) {
    const outcome = await setupDeclarativeClusterFn({ ...resolved.cbdinocluster, githubCredentials }, execution);
    const clusterState: ResumeClusterState | undefined = outcome.cluster
      ? {
          cluster: outcome.cluster,
          allocated: outcome.allocated,
          ...(outcome.clusterId ? { clusterId: outcome.clusterId } : {}),
          ...(outcome.cbdinocluster ? { cbdinoclusterCommand: outcome.cbdinocluster } : {}),
        }
      : undefined;
    return {
      resolved: outcome.cluster ? applySharedCluster(resolved, outcome.cluster) : resolved,
      ...(clusterState ? { clusterState } : {}),
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
  const clusterDockerEnvironment =
    iteration.type === "functional" && iteration.cluster
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
  iteration: ResolvedFunctionalIteration,
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

/**
 * The run step for a situational iteration. cbdino builds and manages the
 * cluster from inside the test-driver, so there's no cluster to diagnose or
 * sanity-check up front — instead we resolve the results database the file named,
 * generate the situational FITConfiguration, and run the test-driver with the
 * situational Maven groups.
 */
export async function runSituationalTests(
  execution: FitExecutionContext,
  iteration: ResolvedSituationalIteration,
  iterationIndex: number,
  dependencies: {
    resolveResultsDatabaseFn?: typeof resolveResultsDatabase;
    generateSituationalConfigurationFn?: typeof generateSituationalConfiguration;
    runTestDriverFn?: typeof runTestDriver;
  } = {},
): Promise<RunOutput> {
  const resolveResultsDatabaseFn = dependencies.resolveResultsDatabaseFn ?? resolveResultsDatabase;
  const generateSituationalConfigurationFn =
    dependencies.generateSituationalConfigurationFn ?? generateSituationalConfiguration;
  const runTestDriverFn = dependencies.runTestDriverFn ?? runTestDriver;

  console.log(
    "\nNote: for a full cbdino run the performer must share cbdino's Docker network " +
      "(usually `dinonet`) so it can reach the cluster cbdino creates.",
  );

  const database = await resolveResultsDatabaseFn(iteration.databaseMode, execution.rootDir);
  if (!database.ready) {
    return { artifacts: database.artifacts, details: database.details };
  }

  const artifacts: Artifact[] = [...database.artifacts];
  const details: Detail[] = [...database.details];

  const fitConfig = generateSituationalConfigurationFn(
    database.database,
    iteration.cbdino,
    execution.rootDir,
    iteration.performerPort,
    iteration.fitConfig,
    iterationIndex,
  );
  artifacts.push(...fitConfig.artifacts);
  details.push(...fitConfig.details);

  const testRun = await runTestDriverFn(
    execution,
    iteration.testSelection,
    fitConfig.path,
    iteration.extraMavenArgs,
    iterationIndex,
  );
  artifacts.push(...testRun.artifacts);
  details.push(...testRun.details);

  console.log(`\nWhen this run produces data, view it at:\n  ${SITUATIONAL_RESULTS_URL}`);
  details.push({ label: "Results UI", value: SITUATIONAL_RESULTS_URL });
  return { artifacts, details };
}

/**
 * Reconstruct the performer a previous run left running for this iteration,
 * after checking its container is still up. Returns undefined (explaining why)
 * if the run state has no performer for the iteration or the container is gone.
 */
async function resumePerformer(
  execution: FitExecutionContext,
  iteration: ResolvedIteration,
  savedState: RunState | undefined,
  iterationIndex: number,
): Promise<RunningPerformer | undefined> {
  const saved = savedState?.performers.find((performer) => performer.iterationIndex === iterationIndex);
  if (!saved?.containerId) {
    fitCliError(
      `\nresume: the run state has no performer for iteration ${iterationIndex + 1}. ` +
        "Re-run with --resume-at=after-cluster-creation to rebuild it.",
    );
    return undefined;
  }

  const running = (
    await execution
      .capture(execution.dockerCommand, ["ps", "--filter", `id=${saved.containerId}`, "--format", "{{.ID}}"])
      .catch(() => "")
  ).trim();
  if (!running) {
    fitCliError(
      `\nresume: the saved performer container ${saved.containerId} is no longer running. ` +
        "Re-run with --resume-at=after-cluster-creation to rebuild it.",
    );
    return undefined;
  }

  console.log(`\n→ resume: reusing performer container ${saved.containerId} for iteration ${iterationIndex + 1}.`);
  const logFile = createLogFile(performerLogStem(iterationIndex, iteration.sdk, iteration.performerVersion));
  return {
    containerId: saved.containerId,
    logFile,
    artifacts: [artifactFromPath(logFile, `${iteration.sdk.name} performer logs captured for this FIT run`)],
    details: [],
  };
}

 function printResumeHint(point: ResumePoint, definitionPath: string): void {
  console.log(`\n→ Resume from here: npm run definition -- --resume-at=${point} ${definitionPath}`);
}

/** Run one iteration: stand up (or reuse) its performer, then run the tests. */
async function runIteration(
  execution: FitExecutionContext,
  resolved: ResolvedDefinition,
  iteration: ResolvedIteration,
  setupPerformerPhase: boolean,
  savedState: RunState | undefined,
  iterationIndex: number,
  definitionPath: string,
): Promise<{ output: RunOutput; performer?: RunningPerformer }> {
  const artifacts: Artifact[] = [];
  const details: Detail[] = [];

  const performer = setupPerformerPhase
    ? await setupPerformer(execution, resolved, iteration, iterationIndex)
    : await resumePerformer(execution, iteration, savedState, iterationIndex);
  if (!performer) {
    if (setupPerformerPhase) {
      fitCliError("\nThe performer isn't ready to run; stopping this iteration.");
    }
    return { output: { artifacts, details } };
  }
  artifacts.push(...performer.artifacts);
  if (setupPerformerPhase && performer.containerId) {
    printResumeHint("after-performer", definitionPath);
  }

  const output =
    iteration.type === "situational"
      ? await runSituationalTests(execution, iteration, iterationIndex)
      : await runTests(execution, resolved.clusterMode, iteration, performer, iterationIndex);
  artifacts.push(...output.artifacts);
  details.push(...output.details);
  return {
    output: { artifacts: combineArtifacts(artifacts), details: combineDetails(details) },
    performer,
  };
}

/** Resolve the shared cluster when resuming: reuse the one in the run state. */
async function resumeCluster(
  resolved: ResolvedDefinition,
  savedState: RunState | undefined,
): Promise<{ resolved: ResolvedDefinition; clusterState?: ResumeClusterState }> {
  // Existing-cluster modes already carry the cluster from the file, so there's
  // nothing in the run state to reuse — the resolved iterations are ready.
  if (resolved.clusterMode !== "cbdinocluster") {
    return { resolved };
  }

  const clusterState = savedState?.cluster;
  if (!clusterState) {
    throw new Error(
      "resume: the run state has no cbdinocluster to reuse. Re-run without --resume-at to allocate one.",
    );
  }
  console.log(
    `\n→ resume: reusing cluster ${clusterState.clusterId ?? clusterState.cluster.defaultHostname} from the run state.`,
  );
  if (!(await runClusterDiag(clusterState.cluster))) {
    throw new Error(
      "resume: the saved cluster is no longer reachable. Re-run without --resume-at to allocate a fresh one.",
    );
  }
  return { resolved: applySharedCluster(resolved, clusterState.cluster), clusterState };
}

function targetStateFrom(teardown: ExecutionTargetTeardown): ResumeTargetState {
  return {
    kind: teardown.kind,
    ...(teardown.instanceId ? { instanceId: teardown.instanceId } : {}),
    ...(teardown.address ? { address: teardown.address } : {}),
    ...(teardown.region ? { region: teardown.region } : {}),
    ...(teardown.user ? { user: teardown.user } : {}),
    ...(teardown.identityFile ? { identityFile: teardown.identityFile } : {}),
  };
}

interface TeardownInputs {
  definitionPath: string;
  /** The remote/local context — absent if the run failed before it came up. */
  execution?: FitExecutionContext;
  teardown: ExecutionTargetTeardown;
  clusterState?: ResumeClusterState;
  performers: readonly RunningPerformer[];
  performerStates: readonly ResumePerformerState[];
}

/**
 * Which resume points the saved state actually supports, in run order — so the
 * leave-up message only suggests points that will work given how far the run got
 * (e.g. no `after-cluster-creation` when no cluster was stood up).
 */
function resumeSuggestions(inputs: TeardownInputs): ResumePoint[] {
  const { teardown, execution, clusterState, performerStates } = inputs;
  const points: ResumePoint[] = [];
  // A remote box we can reconnect to: reuse the instance, re-prepare the rest.
  if (teardown.kind === "remote" && teardown.address) {
    points.push("after-instance-creation");
    // The workspace is only prepared once the execution context came up.
    if (execution) {
      points.push("after-remote-preparation");
    }
  }
  if (clusterState) {
    points.push("after-cluster-creation");
  }
  if (performerStates.length > 0) {
    points.push("after-performer");
  }
  return points;
}

/**
 * Ask once whether to leave everything up for debugging and resuming. If so,
 * record the run state and leave the instance, cluster and performers running;
 * otherwise stop the performers, remove an allocated cluster, and terminate an
 * instance fit-cli provisioned. The execution context may be absent (the run
 * failed before it came up); only the instance is then up to leave or terminate.
 */
async function teardownRun(inputs: TeardownInputs): Promise<void> {
  const { definitionPath, execution, teardown, clusterState, performers, performerStates } = inputs;

  const leaveUp = await confirm({
    promptId: "run-from-definition.teardown.leave-up",
    message: "Leave everything up (instance, cluster, performer) for debugging and resuming?",
    default: false,
  });

  if (leaveUp) {
    const state: RunState = {
      version: 1,
      target: targetStateFrom(teardown),
      ...(clusterState ? { cluster: clusterState } : {}),
      performers: [...performerStates],
    };
    const path = writeRunState(definitionPath, state);
    console.log(`\n✓ Leaving everything up. Saved run state to:\n  ${path}`);
    const suggestions = resumeSuggestions(inputs);
    if (suggestions.length > 0) {
      console.log("\nResume after a manual fix with, e.g.:");
      for (const point of suggestions) {
        console.log(`  npm run definition -- --resume-at=${point} ${definitionPath}`);
      }
    }
    if (teardown.terminate && teardown.instanceId) {
      const region = teardown.region ?? resolveRegion();
      fitCliWarn(`\nInstance ${teardown.instanceId} is still running — remember to terminate it when done.`);
      if (teardown.identityFile && teardown.user && teardown.address) {
        console.log(`\nSSH in with:\n  ssh -i ${teardown.identityFile} ${teardown.user}@${teardown.address}`);
      }
      console.log(`\nTerminate it with:\n  ${terminateInstanceCommand(teardown.instanceId, region)}`);
    }
    return;
  }

  // Performer and cluster cleanup need the context; skipped if it never came up.
  if (execution) {
    for (const performer of performers) {
      await stopManagedPerformer(execution, performer);
    }
    if (clusterState?.allocated && clusterState.clusterId && clusterState.cbdinoclusterCommand) {
      await removeCluster(clusterState.cbdinoclusterCommand, clusterState.clusterId, execution);
    }
  }
  if (teardown.terminate) {
    console.log(`\nTerminating instance ${teardown.instanceId ?? ""}...`);
    await teardown.terminate();
    console.log("✓ Terminated.");
  }
}

export interface RunFromDefinitionOptions {
  resumeAt?: ResumePoint;
}

/** Run FIT functional tests as described by the definition file at `definitionPath`. */
export async function runFromDefinition(
  definitionPath: string,
  rootDir: string,
  options: RunFromDefinitionOptions = {},
): Promise<RunOutput> {
  const { resumeAt } = options;
  const phases = phasesForResumePoint(resumeAt);
  let resolved = resolveDefinition(loadDefinition(definitionPath));
  console.log(`\nRunning FIT functional tests from definition:\n  ${definitionPath}`);
  console.log(`  Cluster: ${clusterLabel(resolved)}`);

  const savedState = resumeAt ? readRunState(definitionPath) : undefined;
  if (resumeAt) {
    if (!savedState) {
      fitCliError(
        `\nresume: no saved run state found for ${definitionPath}. ` +
          "Run without --resume-at first, then choose to leave everything up.",
      );
      return { artifacts: [], details: [] };
    }
    console.log(`  Resuming at: ${resumeAt}`);
  }

  // Resolve GitHub credentials upfront so we fail before provisioning an instance.
  let githubCredentials: { user: string; token: string } | undefined;
  if (resolved.cbdinocluster && phases.setupCluster && !resumeAt) {
    const result = resolveGithubCredentials();
    if (typeof result === "string") {
      fitCliError(`\n✗ ${result}`);
      return { artifacts: [], details: [] };
    }
    githubCredentials = result;
  }

  const artifacts: Artifact[] = [];
  const details: Detail[] = [];
  const executionTarget = savedState
    ? await reconnectExecutionTarget(savedState.target)
    : await selectExecutionTarget();
  artifacts.push(...executionTarget.artifacts);
  details.push(...executionTarget.details);
  if (!executionTarget.ready) {
    return { artifacts: combineArtifacts(artifacts), details: combineDetails(details) };
  }
  if (executionTarget.teardown.kind === "remote" && executionTarget.teardown.address) {
    printResumeHint("after-instance-creation", definitionPath);
  }

  let execution: FitExecutionContext | undefined;
  let clusterState: ResumeClusterState | undefined;
  const performers: RunningPerformer[] = [];
  const performerStates: ResumePerformerState[] = [];
  try {
    execution = await createFitExecutionContext(executionTarget.target, rootDir, resolved.iterations[0].sdk, {
      skipRemotePreparation: !phases.prepareRemote,
    });
    artifacts.push(...execution.artifacts);
    details.push(...execution.details);
    if (phases.prepareRemote && executionTarget.teardown.kind === "remote" && executionTarget.teardown.address) {
      printResumeHint("after-remote-preparation", definitionPath);
    }

    // The cluster is shared across iterations, so set it up (or reuse it) once.
    if (phases.setupCluster) {
      const setup = await setupCluster(resolved, execution, setupDeclarativeCluster, githubCredentials);
      resolved = setup.resolved;
      clusterState = setup.clusterState;
      artifacts.push(...setup.artifacts);
      details.push(...setup.details);
      if (cbdinoclusterSetupFailed(resolved, true)) {
        fitCliError("\nsetup-cluster didn't produce a cluster, so this definition run can't continue.");
        throw new Error("setup-cluster failed");
      }
    } else {
      const resumed = await resumeCluster(resolved, savedState);
      resolved = resumed.resolved;
      clusterState = resumed.clusterState;
    }

    for (const [index, iteration] of resolved.iterations.entries()) {
      announce(index, resolved.iterations.length, resolved, iteration);
      const { output, performer } = await runIteration(
        execution,
        resolved,
        iteration,
        phases.setupPerformer,
        savedState,
        index,
        definitionPath,
      );
      artifacts.push(...output.artifacts);
      details.push(...output.details);
      if (performer) {
        performers.push(performer);
        if (performer.containerId) {
          performerStates.push({
            iterationIndex: index,
            containerId: performer.containerId,
            port: iteration.performerPort,
            sdk: iteration.sdk.value,
            ...(iteration.performerVersion ? { version: iteration.performerVersion } : {}),
          });
        }
      }
    }

    return finalizeRunFromDefinition(artifacts, details);
  } finally {
    // Always offer to leave things up — even if the context never came up, the
    // instance is worth keeping so a fix can be tried with --resume-at.
    await teardownRun({
      definitionPath,
      ...(execution ? { execution } : {}),
      teardown: executionTarget.teardown,
      ...(clusterState ? { clusterState } : {}),
      performers,
      performerStates,
    });
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir, positionals } = rootDirFromArgv(process.argv.slice(2));
    const { resumeAt, positionals: rest } = extractResumeAt(positionals);
    const [definitionPath, ...extra] = rest;
    if (!definitionPath || extra.length > 0) {
      console.error(
        "Usage: tsx src/workflows/fit-functional/run-from-definition/run-from-definition.ts <file.yaml> [--resume-at=<point>] [--root <dir>] [--interactive]\n" +
          "  --resume-at: after-instance-creation | after-remote-preparation | after-cluster-creation | after-performer (reuse what a previous run left up)",
      );
      process.exit(2);
    }
    let resumePoint: ResumePoint | undefined;
    try {
      resumePoint = parseResumePoint(resumeAt);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(2);
    }
    return runFromDefinition(definitionPath, rootDir, { ...(resumePoint ? { resumeAt: resumePoint } : {}) });
  });
}
