/**
 * Workflow: run FIT tests from a `fit` definition file. The cluster, SDK and
 * test selection all come from the file; the only prompts are where to execute
 * the run (local or a clean EC2 instance) and, at the end, whether to leave
 * everything up for debugging and resuming.
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
 *   npm run definition -- execute <file.yaml>                                          # everything
 *   npm run definition -- execute --resume-at=after-instance-creation <file>  # reuse instance
 *   npm run definition -- execute --resume-at=after-remote-preparation <file>  # reuse prepared box
 *   npm run definition -- execute --resume-at=after-cluster-creation <file>    # reuse cluster
 *   npm run definition -- execute --resume-at=after-performer <file>           # reuse cluster + performer
 *
 * Run on its own (add --root <dir> to point at another workspace):
 *   npx tsx src/workflows/fit-functional/run-from-definition/run-from-definition.ts <file.yaml>
 *
 * Existing-cluster modes (`setup.cluster.connection` and
 * `setup.cluster.useExisting`) are resolved directly from the file; a
 * cbdinocluster plan is allocated during the cluster phase and recorded in the
 * run state so `--resume-at` can pick it back up.
 */
import { copyFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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
import {
  cycleRunDir,
  defaultsToNonInteractive,
  ensureRunDir,
  extractInteractiveFlag,
} from "../../../util/non-fit/replay.js";
import { confirm } from "../../../util/non-fit/prompts.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { resolveGithubCredentials, resolveResultsDbCredentials } from "../../../util/fit/config.js";
import { terminateInstanceCommand } from "../../../util/fit/aws/lifecycle-warning.js";
import { resolveRegion } from "../../../util/non-fit/aws/aws-cli.js";
import { resolveAwsCredentials, type AwsCredentials } from "../../../util/non-fit/aws/identity.js";
import {
  localClusterCommandExecutor,
  type ClusterCommandExecutor,
} from "../../cluster/cluster-create/allocate-cluster.js";
import { runClusterDiag } from "../../cluster/cluster-diag/cluster-diag.js";
import { prepareCbdinoclusterConfig, removeCluster, setupDeclarativeCluster } from "../../cluster/cluster-create/setup-declarative-cluster.js";
import { defaultCbdinoclusterInitConfig } from "../../cluster/cluster-create/default-cbdinocluster-init-config.js";
import {
  checkLocalhostCngKubernetes,
  provisionRemoteK3d,
  remoteHomeFromWorkspace,
  withRemoteK8sBlock,
} from "../../cluster/cluster-create/cng-kubernetes.js";
import {
  checkBuildAndRunPerformer,
  performerLogStem,
  stopManagedPerformer,
  type RunningPerformer,
} from "../../performers/check-build-and-run-performer/check-build-and-run-performer.js";
import { generateFitConfiguration } from "../../fit-shared/fit-configuration/generate-fit-configuration.js";
import { generateSituationalConfiguration } from "../../fit-shared/fit-configuration/generate-situational-configuration.js";
import { createFitExecutionContext, uploadRemoteAwsCredentials, type FitExecutionContext } from "../../fit-shared/util/remote-fit-run.js";
import { loadDefinition } from "../../fit-shared/definition/parse-definition.js";
import {
  resolveDefinition,
  type ResolvedCycle,
  type ResolvedFunctionalCycle,
  type ResolvedFunctionalIteration,
  type ResolvedIteration,
  type ResolvedSituationalIteration,
} from "../../fit-shared/definition/resolve-definition.js";
import { runTestDriver } from "../../fit-shared/run-test-driver/run-test-driver.js";
import {
  buildHostedDatabase,
  checkResultsDatabaseConnectivity,
  HOSTED_RESULTS_DB_HOST,
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
  resolveCycleExecutionTarget,
  type ExecutionTargetTeardown,
} from "../select-execution-target/select-execution-target.js";
import {
  ClassifiedFailure,
  throwFatalToCycle,
  throwFatalToIteration,
} from "../../fit-shared/failure-classification.js";
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
  iteration: ResolvedFunctionalIteration,
): iteration is ResolvedFunctionalIteration & { cluster: NonNullable<ResolvedFunctionalIteration["cluster"]> } {
  return iteration.cluster !== undefined;
}

/** Describe one cycle's cluster for the run header / setup-cluster step. */
function clusterLabel(cycle: ResolvedCycle): string {
  if (cycle.type === "situational") {
    return "none — situational cycles build their own cluster via FIT/SIT";
  }
  const cluster = cycle.iterations.find(functionalWithCluster)?.cluster;
  if (cluster) {
    const cng = cluster.cng ? ` — CNG performer ${cluster.cng.performerConnectionString}` : "";
    return `${cluster.scheme}://${cluster.defaultHostname} (${cluster.flavour})${cng}`;
  }
  if (cycle.cng) {
    return "CNG cbdinocluster plan (couchbase2; allocated during setup-cluster)";
  }
  if (cycle.clusterMode === "connection") {
    return "existing cluster from cycle.cluster.connection";
  }
  if (cycle.clusterMode === "useExisting") {
    return "existing cluster from iteration fitConfig.clusterAccess";
  }
  if (cycle.clusterMode === "cbdinocluster") {
    return "cbdinocluster plan (allocated during setup-cluster)";
  }
  return "none configured";
}

function applyCycleCluster(
  cycle: ResolvedFunctionalCycle,
  cluster: NonNullable<ResolvedFunctionalIteration["cluster"]>,
): ResolvedFunctionalCycle {
  return {
    ...cycle,
    iterations: cycle.iterations.map((iteration) => ({ ...iteration, cluster })),
  };
}

function missingClusterMessage(clusterMode: ResolvedFunctionalCycle["clusterMode"]): string {
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
  cycle: ResolvedFunctionalCycle,
  ranSetupCluster: boolean,
): boolean {
  return (
    cycle.clusterMode === "cbdinocluster" &&
    ranSetupCluster &&
    cycle.iterations.some((iteration) => !iteration.cluster)
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
  cycleIndex: number,
  cycleCount: number,
  index: number,
  total: number,
  fitPerformerGerritRef: string | undefined,
  iteration: ResolvedIteration,
): void {
  const { testSelection } = iteration;
  const testsLabel = testSelection.mavenTestSelector
    ? `${testSelection.selectedTests.length} test(s): ${testSelection.mavenTestSelector}`
    : "all tests";
  console.log(`\n=== Cycle ${cycleIndex + 1}/${cycleCount} (${iteration.type}) ===`);
  console.log(`\n=== Iteration ${index + 1}/${total} (${iteration.type}) ===`);
  console.log(`  SDK:     ${iteration.sdk.name}`);
  console.log(`  Tests:   ${testsLabel}`);
  if (iteration.type === "situational") {
    console.log(`  Results database: ${iteration.databaseMode}`);
  }
  console.log(`  Performer port: ${iteration.performerPort}`);
  if (iteration.performerVersion) {
    console.log(`  Performer version: ${iteration.performerVersion}`);
  }
  if (fitPerformerGerritRef) {
    console.log(`  FIT Gerrit ref: ${fitPerformerGerritRef}`);
  }
}

/**
 * Augment a CNG cycle's cbdinocluster init config with the `k8s` block pointing
 * at the k3d cluster fit-cli stood up on the remote box.
 */
function withRemoteK8sInit(cycle: ResolvedFunctionalCycle, home: string): ResolvedFunctionalCycle {
  if (!cycle.cbdinocluster) {
    return cycle;
  }
  const initConfig = cycle.cbdinocluster.init?.config ?? defaultCbdinoclusterInitConfig();
  return {
    ...cycle,
    cbdinocluster: {
      ...cycle.cbdinocluster,
      init: { config: withRemoteK8sBlock(initConfig, home) },
    },
  };
}

/**
 * Make a functional cycle's execution target CNG-ready. Non-CNG cycles pass
 * through untouched. For CNG: on localhost, verify ~/.cbdinocluster has
 * Kubernetes enabled (FatalToCycle with guidance if not); on a clean instance,
 * install k3d and point the uploaded cbdinocluster config at it.
 */
async function prepareFunctionalCngCycle(
  cycle: ResolvedFunctionalCycle,
  execution: FitExecutionContext,
): Promise<ResolvedFunctionalCycle> {
  if (!cycle.cng) {
    return cycle;
  }
  if (execution.kind === "remote") {
    const home = remoteHomeFromWorkspace(execution.rootDir);
    await provisionRemoteK3d(execution, home);
    return withRemoteK8sInit(cycle, home);
  }
  const check = checkLocalhostCngKubernetes();
  if (!check.ok) {
    throwFatalToCycle(check.message);
  }
  console.log("→ setup-cluster: this machine's ~/.cbdinocluster has Kubernetes enabled — CNG-ready.");
  return cycle;
}

/**
 * The setup-cluster step. Existing-cluster modes only report what the file
 * resolved to; a cbdinocluster plan is allocated here and then shared across
 * every iteration in the run.
 */
export async function setupCluster(
  cycle: ResolvedFunctionalCycle,
  execution: ClusterCommandExecutor = localClusterCommandExecutor(),
  setupDeclarativeClusterFn: typeof setupDeclarativeCluster = setupDeclarativeCluster,
  githubCredentials?: { user: string; token: string },
  cycleIndex: number = 0,
): Promise<RunOutput & { cycle: ResolvedFunctionalCycle; clusterState?: ResumeClusterState }> {
  if (cycle.clusterMode === "connection") {
    fitCliWarn("\nsetup-cluster: using the existing cluster from cycle.cluster.connection; nothing to allocate.");
    return { cycle, artifacts: [], details: [] };
  }
  if (cycle.clusterMode === "useExisting") {
    fitCliWarn("\nsetup-cluster: using the existing cluster described by iteration fitConfig.clusterAccess; nothing to allocate.");
    return { cycle, artifacts: [], details: [] };
  }
  if (cycle.cbdinocluster) {
    const outcome = await setupDeclarativeClusterFn({ ...cycle.cbdinocluster, cng: cycle.cng, githubCredentials }, execution, cycleRunDir(cycleIndex));
    const clusterState: ResumeClusterState | undefined = outcome.cluster
      ? {
          cluster: outcome.cluster,
          allocated: outcome.allocated,
          ...(outcome.clusterId ? { clusterId: outcome.clusterId } : {}),
          ...(outcome.cbdinocluster ? { cbdinoclusterCommand: outcome.cbdinocluster } : {}),
        }
      : undefined;
    return {
      cycle: outcome.cluster ? applyCycleCluster(cycle, outcome.cluster) : cycle,
      ...(clusterState ? { clusterState } : {}),
      artifacts: outcome.artifacts,
      details: outcome.details,
    };
  }
  fitCliWarn("\nsetup-cluster: no cluster configured.");
  return { cycle, artifacts: [], details: [] };
}

/** The setup-performer step: build the performer image and start it in Docker. */
async function setupPerformer(
  execution: FitExecutionContext,
  fitPerformerGerritRef: string | undefined,
  iteration: ResolvedIteration,
  cycleIndex: number,
  localIterationIndex: number,
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
    cycleIndex,
    localIterationIndex,
    fitPerformerGerritRef,
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
  clusterMode: ResolvedFunctionalCycle["clusterMode"],
  iteration: ResolvedFunctionalIteration,
  performer: RunningPerformer | undefined,
  cycleIndex: number,
  localIterationIndex: number,
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
    throwFatalToCycle("Cluster sanity test failed; this cycle cannot continue.");
  }

  const fitConfig = generateFitConfigurationFn(
    iteration.cluster,
    execution.rootDir,
    iteration.performerPort,
    iteration.fitConfig,
    cycleIndex,
    localIterationIndex,
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
    cycleIndex,
    localIterationIndex,
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
  cycleIndex: number,
  localIterationIndex: number,
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
    undefined,
    execution.rootDir,
    iteration.performerPort,
    iteration.fitConfig,
    cycleIndex,
    localIterationIndex,
  );
  artifacts.push(...fitConfig.artifacts);
  details.push(...fitConfig.details);

  const testRun = await runTestDriverFn(
    execution,
    iteration.testSelection,
    fitConfig.path,
    iteration.extraMavenArgs,
    cycleIndex,
    localIterationIndex,
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
  globalIterationIndex: number,
  cycleIndex: number,
  localIterationIndex: number,
): Promise<RunningPerformer | undefined> {
  const saved = savedState?.performers.find((performer) => performer.iterationIndex === globalIterationIndex);
  if (!saved?.containerId) {
    fitCliError(
      `\nresume: the run state has no performer for iteration ${globalIterationIndex + 1}. ` +
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

  console.log(`\n→ resume: reusing performer container ${saved.containerId} for iteration ${globalIterationIndex + 1}.`);
  const logFile = createLogFile(performerLogStem(cycleIndex, localIterationIndex, iteration.sdk, iteration.performerVersion));
  return {
    containerId: saved.containerId,
    logFile,
    artifacts: [artifactFromPath(logFile, `${iteration.sdk.name} performer logs captured for this FIT run`)],
    details: [],
  };
}

 function printResumeHint(point: ResumePoint, definitionPath: string): void {
  console.log(`\n→ Resume from here: npm run definition -- execute --resume-at=${point} ${definitionPath}`);
}

/** Run one iteration: stand up (or reuse) its performer, then run the tests. */
async function runIteration(
  execution: FitExecutionContext,
  functionalClusterMode: ResolvedFunctionalCycle["clusterMode"] | undefined,
  fitPerformerGerritRef: string | undefined,
  iteration: ResolvedIteration,
  setupPerformerPhase: boolean,
  savedState: RunState | undefined,
  cycleIndex: number,
  localIterationIndex: number,
  globalIterationIndex: number,
  definitionPath: string,
): Promise<{ output: RunOutput; performer?: RunningPerformer }> {
  const artifacts: Artifact[] = [];
  const details: Detail[] = [];

  const performer = setupPerformerPhase
    ? await setupPerformer(execution, fitPerformerGerritRef, iteration, cycleIndex, localIterationIndex)
    : await resumePerformer(execution, iteration, savedState, globalIterationIndex, cycleIndex, localIterationIndex);
  if (!performer) {
    throwFatalToIteration("The performer isn't ready to run; stopping this iteration.");
  }
  artifacts.push(...performer.artifacts);
  if (setupPerformerPhase && performer.containerId) {
    printResumeHint("after-performer", definitionPath);
  }

  let output: RunOutput;
  if (iteration.type === "situational") {
    output = await runSituationalTests(execution, iteration, cycleIndex, localIterationIndex);
  } else {
    const clusterMode: ResolvedFunctionalCycle["clusterMode"] = functionalClusterMode ?? "useExisting";
    output = await runTests(execution, clusterMode, iteration, performer, cycleIndex, localIterationIndex);
  }
  artifacts.push(...output.artifacts);
  details.push(...output.details);
  return {
    output: { artifacts: combineArtifacts(artifacts), details: combineDetails(details) },
    performer,
  };
}

/** Resolve the shared cluster when resuming: reuse the one in the run state. */
async function resumeCluster(
  cycle: ResolvedFunctionalCycle,
  savedState: RunState | undefined,
): Promise<{ cycle: ResolvedFunctionalCycle; clusterState?: ResumeClusterState }> {
  // Existing-cluster modes already carry the cluster from the file, so there's
  // nothing in the run state to reuse — the resolved iterations are ready.
  if (cycle.clusterMode !== "cbdinocluster") {
    return { cycle };
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
  return { cycle: applyCycleCluster(cycle, clusterState.cluster), clusterState };
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
  cycleIndex: number;
  /** Within the active cycle, the iteration that was running at teardown. */
  iterationIndex: number;
  /** The remote/local context — absent if the run failed before it came up. */
  execution?: FitExecutionContext;
  teardown: ExecutionTargetTeardown;
  /** Whether the run forced every cycle onto localhost; persisted so resume matches. */
  forceLocalhost: boolean;
  clusterState?: ResumeClusterState;
  performers: readonly RunningPerformer[];
  performerStates: readonly ResumePerformerState[];
}

/**
 * Tear down a single cycle's resources without prompting: stop its performers,
 * remove a cluster it allocated, and terminate an instance fit-cli provisioned for
 * it. Used at the end of a cycle that completed (or was abandoned) and isn't the
 * one we might leave up for debugging.
 */
async function disposeCycleResources(
  execution: FitExecutionContext | undefined,
  teardown: ExecutionTargetTeardown,
  clusterState: ResumeClusterState | undefined,
  performers: readonly RunningPerformer[],
): Promise<void> {
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
  const { definitionPath, cycleIndex, iterationIndex, execution, teardown, forceLocalhost, clusterState, performers, performerStates } = inputs;

  const nothingToLeaveUp = !teardown.terminate && !clusterState && performerStates.length === 0;
  if (nothingToLeaveUp) {
    return;
  }

  const leaveUp = await confirm({
    promptId: "run-from-definition.teardown.leave-up",
    message: "Leave everything up (instance, cluster, performer) for debugging and resuming?",
    default: false,
  });

  if (leaveUp) {
    const state: RunState = {
      version: 1,
      cycleIndex,
      startIterationIndex: iterationIndex,
      ...(forceLocalhost ? { forceLocalhost } : {}),
      target: targetStateFrom(teardown),
      ...(clusterState ? { cluster: clusterState } : {}),
      performers: [...performerStates],
    };
    const path = writeRunState(definitionPath, state);
    console.log(`\n✓ Leaving everything up. Saved run state to:\n  ${path}`);

    // List exactly what's been left running so it's clear what is still costing
    // money / holding resources and needs cleaning up later.
    const leftRunning: string[] = [];
    if (teardown.terminate && teardown.instanceId) {
      leftRunning.push(`Instance: ${teardown.instanceId}${teardown.address ? ` (${teardown.address})` : ""}`);
    }
    if (clusterState) {
      const clusterId = clusterState.clusterId ?? clusterState.cluster.defaultHostname;
      leftRunning.push(`Cluster:  ${clusterId}${clusterState.allocated ? " (allocated by this run)" : ""}`);
    }
    for (const performer of performerStates) {
      const version = performer.version ? `@${performer.version}` : "";
      leftRunning.push(`Performer: ${performer.sdk}${version} — container ${performer.containerId} on port ${performer.port}`);
    }
    if (leftRunning.length > 0) {
      console.log(`\nLeft running:\n${leftRunning.map((line) => `  - ${line}`).join("\n")}`);
    }

    const suggestions = resumeSuggestions(inputs);
    const lastSuggestion = suggestions[suggestions.length - 1];
    if (lastSuggestion) {
      console.log(`\nResume after a manual fix with:\n  npm run definition -- execute --resume-at=${lastSuggestion} ${definitionPath}`);
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

/**
 * Whether this run is interactive (so we can prompt) or running with default
 * answers (CI). Mirrors how PromptSession decides its mode: the `definition` npm
 * script and the run-from-definition entrypoint default to non-interactive unless
 * `--interactive` is passed.
 */
function isInteractiveRun(): boolean {
  const { interactive } = extractInteractiveFlag(process.argv.slice(2));
  return interactive || !defaultsToNonInteractive();
}

/**
 * Decide whether to force every cycle onto localhost, ignoring each cycle's
 * `instance:` setting. Resuming reuses the earlier run's choice. Otherwise: if no
 * cycle wants AWS there's nothing to override; interactively we default to honoring
 * the file (opt in to localhost); non-interactively (CI) we default to localhost so
 * a CI run never provisions AWS by surprise.
 */
async function resolveForceLocalhost(
  cycles: readonly ResolvedCycle[],
  savedState: RunState | undefined,
): Promise<boolean> {
  if (savedState) {
    return savedState.forceLocalhost ?? false;
  }
  if (!cycles.some((cycle) => cycle.instance.kind === "aws")) {
    return false;
  }
  if (!isInteractiveRun()) {
    console.log(
      "\nNon-interactive run: running every cycle on localhost (ignoring AWS instance settings). " +
        "Use --interactive to provision the instances each cycle asks for.",
    );
    return true;
  }
  return confirm({
    promptId: "run-from-definition.force-localhost",
    message: "Run everything on localhost, ignoring each cycle's instance setting?",
    default: false,
  });
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
  const resolved = resolveDefinition(loadDefinition(definitionPath));
  console.log(`\nRunning FIT tests from definition:\n  ${definitionPath}`);

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
  const startCycleIndex = savedState?.cycleIndex ?? 0;
  const startIterationIndex = savedState?.startIterationIndex ?? 0;

  // Resolve GitHub credentials upfront so we fail before provisioning an instance.
  let githubCredentials: { user: string; token: string } | undefined;
  if (
    phases.setupCluster &&
    resolved.cycles
      .slice(startCycleIndex)
      .some((cycle) => cycle.type === "functional" && cycle.clusterMode === "cbdinocluster")
  ) {
    const result = resolveGithubCredentials();
    if (typeof result === "string") {
      fitCliError(`\n✗ ${result}`);
      return { artifacts: [], details: [] };
    }
    githubCredentials = result;
  }

  // Resolve AWS credentials upfront for situational cycles — the test-driver's
  // cbdinocluster call uses the cloud (AWS) deployer.
  let awsCredentials: AwsCredentials | undefined;
  if (resolved.cycles.slice(startCycleIndex).some((cycle) => cycle.type === "situational")) {
    const result = await resolveAwsCredentials();
    if (typeof result === "string") {
      fitCliError(`\n✗ ${result}`);
      return { artifacts: [], details: [] };
    }
    awsCredentials = result;
  }

  // Check hosted results-database config and connectivity upfront — fail before
  // provisioning an instance when the run can't reach the database.
  const needsHostedDatabase = resolved.cycles
    .slice(startCycleIndex)
    .some(
      (cycle) =>
        cycle.type === "situational" &&
        cycle.iterations.some((it) => it.databaseMode === "hosted"),
    );
  if (needsHostedDatabase) {
    const database = buildHostedDatabase(resolveResultsDbCredentials({ env: {} }));
    if (!database) {
      fitCliError(
        `\n✗ The hosted results database needs a readonly password in your fit-cli config.\n` +
          `  Ask on #the-fit-stop for it, then set it as resultsDb.password in your fit-cli config\n` +
          `  (~/.fit-cli/config.yaml — run \`npm run init\`).`,
      );
      return { artifacts: [], details: [] };
    }
    console.log(`\nChecking connectivity to results database at ${HOSTED_RESULTS_DB_HOST}...`);
    if (!(await checkResultsDatabaseConnectivity())) {
      fitCliError(
        `\n✗ Cannot reach the results database at ${HOSTED_RESULTS_DB_HOST}:5432.\n` +
          `  Make sure you are connected to the vpn-public VPN.`,
      );
      return { artifacts: [], details: [] };
    }
    console.log(`  ✓ Reached ${HOSTED_RESULTS_DB_HOST}.`);
  }

  const artifacts: Artifact[] = [];
  const details: Detail[] = [];

  const runDir = ensureRunDir();
  const definitionCopyPath = join(runDir, basename(resolve(definitionPath)));
  copyFileSync(definitionPath, definitionCopyPath);
  artifacts.push(artifactFromPath(definitionCopyPath, "Definition file used for this run", runDir));

  // One run-wide choice: force every cycle onto localhost, ignoring each cycle's
  // declared instance. Each cycle then provisions (or reconnects) its own target.
  const forceLocalhost = await resolveForceLocalhost(resolved.cycles.slice(startCycleIndex), savedState);

  // The "active" set tracks the cycle currently up so the outer finally tears down
  // (or offers to leave up) the right instance/cluster/performers. Completed,
  // non-final cycles dispose of their own resources inside the loop.
  let activeExecution: FitExecutionContext | undefined;
  let activeTeardown: ExecutionTargetTeardown = { kind: "local" };
  let activeCycleIndex = startCycleIndex;
  let activeIterationIndex = startIterationIndex;
  let activeClusterState: ResumeClusterState | undefined;
  let activePerformers: RunningPerformer[] = [];
  let activePerformerStates: ResumePerformerState[] = [];
  try {
    let globalIterationIndex = resolved.cycles
      .slice(0, startCycleIndex)
      .reduce((total, cycle) => total + cycle.iterations.length, 0);

    for (let cycleIndex = startCycleIndex; cycleIndex < resolved.cycles.length; cycleIndex++) {
      activeCycleIndex = cycleIndex;
      if (cycleIndex !== startCycleIndex) {
        activeIterationIndex = 0;
      }
      const cycle = resolved.cycles[cycleIndex];
      if (!cycle) {
        break;
      }
      console.log(`\nCycle ${cycleIndex + 1}/${resolved.cycles.length}: ${cycle.type}`);
      console.log(`  Execution: ${forceLocalhost ? "localhost (forced)" : cycle.instance.kind}`);
      console.log(`  Cluster: ${clusterLabel(cycle)}`);

      // Acquire this cycle's execution target: reconnect the resumed instance for
      // the start cycle, otherwise provision (or run locally) per the definition.
      const isResumeStartCycle = savedState !== undefined && cycleIndex === startCycleIndex;
      const targetOutcome = isResumeStartCycle
        ? await reconnectExecutionTarget(savedState.target)
        : await resolveCycleExecutionTarget(cycle.instance, forceLocalhost, cycleIndex);
      artifacts.push(...targetOutcome.artifacts);
      details.push(...targetOutcome.details);
      if (!targetOutcome.ready) {
        fitCliError(`\n✗ Could not acquire an execution target for cycle ${cycleIndex + 1}; skipping it.`);
        globalIterationIndex += cycle.iterations.length;
        continue;
      }
      const cycleTeardown = targetOutcome.teardown;
      activeTeardown = cycleTeardown;
      if (cycleTeardown.kind === "remote" && cycleTeardown.address) {
        printResumeHint("after-instance-creation", definitionPath);
      }

      const execution = await createFitExecutionContext(targetOutcome.target, rootDir, cycle.iterations[0].sdk, {
        skipRemotePreparation: isResumeStartCycle && !phases.prepareRemote,
        cycleIndex,
      });
      activeExecution = execution;
      artifacts.push(...execution.artifacts);
      details.push(...execution.details);
      if (phases.prepareRemote && cycleTeardown.kind === "remote" && cycleTeardown.address) {
        printResumeHint("after-remote-preparation", definitionPath);
      }

      // This cycle's situational iterations may stream to the hosted DB; if it runs
      // on a remote box, confirm the box can reach the DB before doing real work.
      const cycleNeedsHostedDatabase =
        cycle.type === "situational" && cycle.iterations.some((it) => it.databaseMode === "hosted");
      if (cycleNeedsHostedDatabase && execution.kind === "remote") {
        console.log(`\nChecking results database connectivity from the remote instance...`);
        if (!(await checkResultsDatabaseConnectivity((cmd, args) => execution.capture(cmd, args)))) {
          fitCliError(
            `\n✗ The remote instance cannot reach the results database at ${HOSTED_RESULTS_DB_HOST}:5432.\n` +
              `  Make sure the instance has network access to reach the database (VPN / security-group rules).`,
          );
          return finalizeRunFromDefinition(artifacts, details);
        }
        console.log(`  ✓ Reached ${HOSTED_RESULTS_DB_HOST} from the remote instance.`);
      }

      let activeCycle = cycle;
      let clusterState: ResumeClusterState | undefined;
      const cyclePerformers: RunningPerformer[] = [];
      const cyclePerformerStates: ResumePerformerState[] = [];

      try {
        if (cycle.type === "functional") {
          // CNG cycles need Kubernetes where cbdinocluster runs: check it on
          // localhost, or stand up k3d (and point the uploaded ~/.cbdinocluster at
          // it) on a clean instance, before allocating anything.
          const functionalCycle = await prepareFunctionalCngCycle(cycle, execution);
          if (cycleIndex === startCycleIndex && !phases.setupCluster) {
            const resumed = await resumeCluster(functionalCycle, savedState);
            activeCycle = resumed.cycle;
            clusterState = resumed.clusterState;
          } else {
            const setup = await setupCluster(functionalCycle, execution, setupDeclarativeCluster, githubCredentials, cycleIndex);
            activeCycle = setup.cycle;
            clusterState = setup.clusterState;
            artifacts.push(...setup.artifacts);
            details.push(...setup.details);
            if (cbdinoclusterSetupFailed(activeCycle, true)) {
              throwFatalToCycle("setup-cluster didn't produce a cluster, so this cycle can't continue.");
            }
            if (clusterState) {
              printResumeHint("after-cluster-creation", definitionPath);
            }
          }
        } else {
          await prepareCbdinoclusterConfig(execution, cycle.cbdinoclusterInit.config, undefined, cycleRunDir(cycleIndex));
          if (execution.kind === "remote" && awsCredentials) {
            await uploadRemoteAwsCredentials(execution.target, execution.rootDir, awsCredentials);
          }
        }

        for (const [cycleIterationIndex, iteration] of activeCycle.iterations.entries()) {
          if (cycleIndex === startCycleIndex && cycleIterationIndex < startIterationIndex) {
            globalIterationIndex++;
            continue;
          }
          activeIterationIndex = cycleIterationIndex;
          const isLastIteration = cycleIterationIndex === activeCycle.iterations.length - 1;
          announce(
            cycleIndex,
            resolved.cycles.length,
            cycleIterationIndex,
            activeCycle.iterations.length,
            resolved.fitPerformerGerritRef,
            iteration,
          );
          const isStartIteration = cycleIndex === startCycleIndex && cycleIterationIndex === startIterationIndex;
          const setupPerformerPhase = isStartIteration ? phases.setupPerformer : true;
          try {
            const { output, performer } = await runIteration(
              execution,
              activeCycle.type === "functional" ? activeCycle.clusterMode : undefined,
              resolved.fitPerformerGerritRef,
              iteration,
              setupPerformerPhase,
              savedState,
              cycleIndex,
              cycleIterationIndex,
              globalIterationIndex,
              definitionPath,
            );
            artifacts.push(...output.artifacts);
            details.push(...output.details);
            if (performer) {
              if (isLastIteration) {
                cyclePerformers.push(performer);
                if (performer.containerId) {
                  cyclePerformerStates.push({
                    iterationIndex: globalIterationIndex,
                    containerId: performer.containerId,
                    port: iteration.performerPort,
                    sdk: iteration.sdk.value,
                    ...(iteration.performerVersion ? { version: iteration.performerVersion } : {}),
                  });
                }
              } else {
                await stopManagedPerformer(execution, performer);
              }
            }
          } catch (err) {
            if (err instanceof ClassifiedFailure && err.classification === "FatalToIteration") {
              fitCliError(`\n✗ ${err.message} (FatalToIteration — moving to next iteration)`);
            } else {
              throw err;
            }
          }
          globalIterationIndex++;
        }
      } catch (err) {
        if (err instanceof ClassifiedFailure && err.classification === "FatalToCycle") {
          fitCliError(`\n✗ ${err.message} (FatalToCycle)`);
          globalIterationIndex += activeCycle.iterations.length;

          // Promote this cycle as the active set so that stopping here lets
          // teardownRun offer to leave its instance/cluster/performers up.
          activeClusterState = clusterState;
          activePerformers = cyclePerformers;
          activePerformerStates = cyclePerformerStates;

          const isLastCycle = cycleIndex === resolved.cycles.length - 1;
          if (isLastCycle) {
            break;
          }

          const continueToNextCycle = await confirm({
            promptId: "run-from-definition.fatal-to-cycle.continue",
            message: "Continue to the next cycle? (this cycle's instance and resources are cleaned up first)",
            default: true,
          });

          if (!continueToNextCycle) {
            break;
          }

          // Continuing: this cycle owns its own instance, so clean it (and the
          // cluster/performers) up before the next cycle stands up its own.
          await disposeCycleResources(execution, cycleTeardown, clusterState, cyclePerformers);
          activeExecution = undefined;
          activeTeardown = { kind: "local" };
          activeClusterState = undefined;
          activePerformers = [];
          activePerformerStates = [];
          continue;
        }
        throw err;
      }

      const isLastCycle = cycleIndex === resolved.cycles.length - 1;
      if (isLastCycle) {
        activeClusterState = clusterState;
        activePerformers = cyclePerformers;
        activePerformerStates = cyclePerformerStates;
      } else {
        // A completed, non-final cycle: clean up its own instance/cluster/performers.
        await disposeCycleResources(execution, cycleTeardown, clusterState, cyclePerformers);
        activeExecution = undefined;
        activeTeardown = { kind: "local" };
        activeClusterState = undefined;
        activePerformers = [];
        activePerformerStates = [];
      }
    }

    return finalizeRunFromDefinition(artifacts, details);
  } finally {
    await teardownRun({
      definitionPath,
      cycleIndex: activeCycleIndex,
      iterationIndex: activeIterationIndex,
      ...(activeExecution ? { execution: activeExecution } : {}),
      teardown: activeTeardown,
      forceLocalhost,
      ...(activeClusterState ? { clusterState: activeClusterState } : {}),
      performers: activePerformers,
      performerStates: activePerformerStates,
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
        "Primary usage: npm run definition -- execute <file.yaml> [--resume-at=<point>] [--root <dir>]\n" +
          "Direct:        tsx src/workflows/fit-functional/run-from-definition/run-from-definition.ts <file.yaml> [--resume-at=<point>]\n" +
          "  --resume-at: after-instance-creation | after-remote-preparation | after-cluster-creation | after-performer",
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
