/**
 * Workflow: run FIT tests from a `fit` definition file. The cluster, SDK and
 * test selection all come from the file; the only prompts are where to execute
 * the run (local or a clean EC2 instance) and, at the end, whether to leave
 * everything up for debugging and resuming.
 *
 * Runs come in two flavours. `functional` runs test against the shared cluster
 * set up once for the execution group. `situational` runs (FIT/SIT) let
 * the test-driver build and manage their own cluster via cbdino and stream
 * timeseries results to a database, so they skip the shared cluster entirely —
 * their cbdino + database settings live under each run's situational settings
 * block (see resolve-definition.ts and build-situational-configuration.ts).
 *
 * The cluster is shared across the whole execution group; each run stands up its own
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
 *   npx tsx src/fit/functional/run-from-definition/run-from-definition.ts <file.yaml>
 *
 * Existing-cluster modes (`setup.cluster.connection` and
 * `setup.cluster.useExisting`) are resolved directly from the file; a
 * cbdinocluster plan is allocated during the cluster phase and recorded in the
 * run state so `--resume-at` can pick it back up.
 */
import { copyFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  artifactFromPath,
  combineArtifacts,
  combineDetails,
  type Artifact,
  type Detail,
  type RecordedFailure,
  type RunOutput,
} from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliError, fitCliWarn } from "../../../util/non-fit/fit-cli-log.js";
import { createLogFile } from "../../../util/non-fit/proc.js";
import {
  defaultsToNonInteractive,
  ensureRunDir,
  extractInteractiveFlag,
  clusterRunDir,
  instanceRunDir,
  type DefinitionRunPath,
} from "../../../util/non-fit/replay.js";
import { confirm } from "../../../util/non-fit/prompts.js";
import { rootDirFromArgv } from "../../util/root.js";
import { resolveGithubCredentials, resolveResultsDbCredentials } from "../../util/config.js";
import { terminateInstanceCommand } from "../../util/aws/lifecycle-warning.js";
import { resolveRegion } from "../../../util/non-fit/aws/aws-cli.js";
import { resolveAwsCredentials, type AwsCredentials } from "../../../util/non-fit/aws/identity.js";
import {
  localClusterCommandExecutor,
  type ClusterCommandExecutor,
} from "../../../cluster/cluster-create/allocate-cluster.js";
import { runClusterDiag } from "../../../cluster/cluster-diag/cluster-diag.js";
import { prepareCbdinoclusterConfig, removeCluster, setupDeclarativeCluster } from "../../../cluster/cluster-create/setup-declarative-cluster.js";
import { defaultCbdinoclusterInitConfig } from "../../../cluster/cluster-create/default-cbdinocluster-init-config.js";
import {
  checkLocalhostCngKubernetes,
  provisionRemoteK3d,
  remoteHomeFromWorkspace,
  withRemoteK8sBlock,
} from "../../../cluster/cluster-create/cng-kubernetes.js";
import {
  checkBuildAndRunPerformer,
  performerLogStem,
  stopManagedPerformer,
  type RunningPerformer,
} from "../../performers/check-build-and-run-performer/check-build-and-run-performer.js";
import { generateFitConfiguration } from "../../shared/fit-configuration/generate-fit-configuration.js";
import { generateSituationalConfiguration } from "../../situational/configuration/generate-situational-configuration.js";
import { createFitExecutionContext, uploadRemoteAwsCredentials, type FitExecutionContext } from "../../shared/util/remote-fit-run.js";
import { loadDefinition } from "../../shared/definition/parse-definition.js";
import {
  buildExecutionGroups,
  resolveDefinition,
  type ResolvedExecutionGroup,
  type ResolvedExecutionRun,
  type ResolvedFunctionalExecutionGroup,
  type ResolvedFunctionalExecutionRun,
  type ResolvedSituationalExecutionRun,
} from "../../shared/definition/resolve-definition.js";
import { runTestDriver } from "../../shared/run-test-driver/run-test-driver.js";
import {
  buildHostedDatabase,
  checkResultsDatabaseConnectivity,
  HOSTED_RESULTS_DB_HOST,
  resolveResultsDatabase,
  SITUATIONAL_RESULTS_URL,
} from "../../situational/choose-results-database/choose-results-database.js";
import {
  detectClusterDockerEnvironment,
  runPerformerClusterSanityCheck,
} from "../../shared/util/performer-cluster-sanity.js";
import { writeAgentsGuide } from "../../shared/util/write-agents-guide.js";
import {
  reconnectExecutionTarget,
  resolveExecutionGroupTarget,
  type ExecutionTargetTeardown,
} from "../select-execution-target/select-execution-target.js";
import {
  ClassifiedFailure,
  throwFatalToCycle,
  throwFatalToIteration,
} from "../../shared/failure-classification.js";
import { RunFailureTracker } from "../../shared/run-failure-tracker.js";
import {
  extractResumeAt,
  extractResumeSelector,
  parseResumePoint,
  phasesForResumePoint,
  type ResumePoint,
  type ResumeSelector,
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
  run: ResolvedFunctionalExecutionRun,
): run is ResolvedFunctionalExecutionRun & { cluster: NonNullable<ResolvedFunctionalExecutionRun["cluster"]> } {
  return run.cluster !== undefined;
}

/** Describe one execution group's cluster for the run header / setup-cluster step. */
function clusterLabel(group: ResolvedExecutionGroup): string {
  if (group.type === "situational") {
    return "none — situational runs build their own cluster via FIT/SIT";
  }
  const cluster = group.runs.find(functionalWithCluster)?.cluster;
  if (cluster) {
    const cng = cluster.cng ? ` — CNG performer ${cluster.cng.performerConnectionString}` : "";
    return `${cluster.scheme}://${cluster.defaultHostname} (${cluster.flavour})${cng}`;
  }
  if (group.cng) {
    return "CNG cbdinocluster plan (couchbase2; allocated during setup-cluster)";
  }
  if (group.clusterMode === "connection") {
    return "existing cluster from cluster.connection";
  }
  if (group.clusterMode === "useExisting") {
    return "existing cluster from cluster.fitConfig.clusterAccess";
  }
  if (group.clusterMode === "cbdinocluster") {
    return "cbdinocluster plan (allocated during setup-cluster)";
  }
  return "none configured";
}

function applyGroupCluster(
  group: ResolvedFunctionalExecutionGroup,
  cluster: NonNullable<ResolvedFunctionalExecutionRun["cluster"]>,
): ResolvedFunctionalExecutionGroup {
  return {
    ...group,
    runs: group.runs.map((run) => ({ ...run, cluster })),
  };
}

function missingClusterMessage(clusterMode: ResolvedFunctionalExecutionGroup["clusterMode"]): string {
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
  group: ResolvedFunctionalExecutionGroup,
  ranSetupCluster: boolean,
): boolean {
  return (
    group.clusterMode === "cbdinocluster" &&
    ranSetupCluster &&
    group.runs.some((run) => !run.cluster)
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
  worstFailure?: RecordedFailure,
  failureCount?: number,
): RunOutput {
  const combined = combineArtifacts(artifacts);
  const guide = writeAgentsGuide(combined, runDir);
  return {
    artifacts: combineArtifacts(combined, [guide.artifact]),
    details: combineDetails(details),
    ...(worstFailure ? { worstFailure, failureCount: failureCount ?? 1 } : {}),
  };
}

/** Print what an iteration resolved to, so a CI log shows the run's inputs. */
function announce(
  group: ResolvedExecutionGroup,
  run: ResolvedExecutionRun,
  fitPerformerGerritRef: string | undefined,
): void {
  const { testSelection } = run;
  const testsLabel = testSelection.mavenTestSelector
    ? `${testSelection.selectedTests.length} test(s): ${testSelection.mavenTestSelector}`
    : "all tests";
  console.log(`\n=== Instance ${run.path.instanceIndex + 1} (${group.instance.kind}) ===`);
  if (!run.path.clusterlessSession) {
    console.log(`=== Cluster ${((run.path.clusterIndex ?? 0) + 1)} (${run.type}) ===`);
  }
  console.log(`=== Session ${((run.path.sessionIndex ?? 0) + 1)} ===`);
  console.log(`=== Run ${((run.path.runIndex ?? 0) + 1)} (${run.type}) ===`);
  console.log(`  SDK:     ${run.sdk.name}`);
  console.log(`  Tests:   ${testsLabel}`);
  if (run.type === "situational") {
    console.log(`  Results database: ${run.databaseMode}`);
  }
  console.log(`  Performer port: ${run.performerPort}`);
  if (run.performerVersion) {
    console.log(`  Performer version: ${run.performerVersion}`);
  }
  if (fitPerformerGerritRef) {
    console.log(`  FIT Gerrit ref: ${fitPerformerGerritRef}`);
  }
}

/**
 * Augment a CNG cycle's cbdinocluster init config with the `k8s` block pointing
 * at the k3d cluster fit-cli stood up on the remote box.
 */
function withRemoteK8sInit(group: ResolvedFunctionalExecutionGroup, home: string): ResolvedFunctionalExecutionGroup {
  if (!group.cbdinocluster) {
    return group;
  }
  const initConfig = group.cbdinocluster.init?.config ?? defaultCbdinoclusterInitConfig();
  return {
    ...group,
    cbdinocluster: {
      ...group.cbdinocluster,
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
  group: ResolvedFunctionalExecutionGroup,
  execution: FitExecutionContext,
): Promise<ResolvedFunctionalExecutionGroup> {
  if (!group.cng) {
    return group;
  }
  if (execution.kind === "remote") {
    const home = remoteHomeFromWorkspace(execution.rootDir);
    await provisionRemoteK3d(execution, home);
    return withRemoteK8sInit(group, home);
  }
  const check = checkLocalhostCngKubernetes();
  if (!check.ok) {
    throwFatalToCycle(check.message);
  }
  console.log("→ setup-cluster: this machine's ~/.cbdinocluster has Kubernetes enabled — CNG-ready.");
  return group;
}

/**
 * The setup-cluster step. Existing-cluster modes only report what the file
 * resolved to; a cbdinocluster plan is allocated here and then shared across
 * every run in the execution group.
 */
export async function setupCluster(
  group: ResolvedFunctionalExecutionGroup,
  execution: ClusterCommandExecutor = localClusterCommandExecutor(),
  setupDeclarativeClusterFn: typeof setupDeclarativeCluster = setupDeclarativeCluster,
  githubCredentials?: { user: string; token: string },
): Promise<RunOutput & { group: ResolvedFunctionalExecutionGroup; clusterState?: ResumeClusterState }> {
  if (group.clusterMode === "connection") {
    fitCliWarn("\nsetup-cluster: using the existing cluster from cluster.connection; nothing to allocate.");
    return { group, artifacts: [], details: [] };
  }
  if (group.clusterMode === "useExisting") {
    fitCliWarn("\nsetup-cluster: using the existing cluster described by cluster.fitConfig.clusterAccess; nothing to allocate.");
    return { group, artifacts: [], details: [] };
  }
  if (group.cbdinocluster) {
    const outcome = await setupDeclarativeClusterFn(
      { ...group.cbdinocluster, cng: group.cng, githubCredentials },
      execution,
      clusterRunDir(group.path.instanceIndex, group.path.clusterIndex ?? 0),
    );
    const clusterState: ResumeClusterState | undefined = outcome.cluster
      ? {
          cluster: outcome.cluster,
          allocated: outcome.allocated,
          ...(outcome.clusterId ? { clusterId: outcome.clusterId } : {}),
          ...(outcome.cbdinocluster ? { cbdinoclusterCommand: outcome.cbdinocluster } : {}),
        }
      : undefined;
    return {
      group: outcome.cluster ? applyGroupCluster(group, outcome.cluster) : group,
      ...(clusterState ? { clusterState } : {}),
      artifacts: outcome.artifacts,
      details: outcome.details,
    };
  }
  fitCliWarn("\nsetup-cluster: no cluster configured.");
  return { group, artifacts: [], details: [] };
}

/** The setup-performer step: build the performer image and start it in Docker. */
async function setupPerformer(
  execution: FitExecutionContext,
  fitPerformerGerritRef: string | undefined,
  run: ResolvedExecutionRun,
): Promise<RunningPerformer | undefined> {
  const clusterDockerEnvironment =
    run.type === "functional" && run.cluster
      ? await detectClusterDockerEnvironment(run.cluster, {
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
    run.sdk,
    run.path,
    run.performerVersion,
    clusterDockerEnvironment?.networkNames[0],
    run.onPortInUse,
    run.performerPort,
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
  clusterMode: ResolvedFunctionalExecutionGroup["clusterMode"],
  run: ResolvedFunctionalExecutionRun,
  performer: RunningPerformer | undefined,
  dependencies: RunTestsDependencies = {},
): Promise<RunOutput> {
  if (!run.cluster) {
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

  if (!(await runClusterDiagFn(run.cluster, { captureCommand: (cmd, args, cwd, runOpts) => execution.capture(cmd, args, cwd, runOpts) }))) {
    throwFatalToCycle("Cluster sanity test failed; this execution group cannot continue.");
  }

  const fitConfig = generateFitConfigurationFn(
    run.cluster,
    execution.rootDir,
    run.path,
    run.performerPort,
    run.fitConfig,
  );
  artifacts.push(...fitConfig.artifacts);
  details.push(...fitConfig.details);

  const performerSanity = await runPerformerClusterSanityCheckFn(run.cluster, performer?.containerId, {
    captureCommand: (command, args) => execution.capture(command, args),
    dockerCommand: execution.dockerCommand,
  });
  artifacts.push(...performerSanity.artifacts);
  if (!performerSanity.ok) {
    throwFatalToIteration("Performer cluster sanity check failed; stopping this iteration.");
  }

  const testRun = await runTestDriverFn(
    execution,
    run.testSelection,
    run.path,
    fitConfig.path,
    run.extraMavenArgs,
  );
  artifacts.push(...testRun.artifacts);
  const iterationLabel = (label: string) => `Run ${run.path.runIndex ?? 0} ${label}`;
  details.push(
    { label: iterationLabel("Details"), value: iterationPathSummary(run.path) },
    { label: iterationLabel("SDK"), value: run.sdk.name },
    { label: iterationLabel("Cluster"), value: `${run.cluster.scheme}://${run.cluster.defaultHostname}` },
    ...testRun.details,
  );
  if (!testRun.ok) {
    throwFatalToIteration("FIT tests failed — check the test-driver log for details.");
  }
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
  run: ResolvedSituationalExecutionRun,
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

  const database = await resolveResultsDatabaseFn(run.databaseMode, execution.rootDir);
  if (!database.ready) {
    return { artifacts: database.artifacts, details: database.details };
  }

  const artifacts: Artifact[] = [...database.artifacts];
  const details: Detail[] = [...database.details];

  const fitConfig = generateSituationalConfigurationFn(
    database.database,
    undefined,
    execution.rootDir,
    run.path,
    run.performerPort,
    run.fitConfig,
  );
  artifacts.push(...fitConfig.artifacts);
  details.push(...fitConfig.details);

  const testRun = await runTestDriverFn(
    execution,
    run.testSelection,
    run.path,
    fitConfig.path,
    run.extraMavenArgs,
  );
  artifacts.push(...testRun.artifacts);
  const iterationLabel = (label: string) => `Run ${run.path.runIndex ?? 0} ${label}`;
  details.push(
    { label: iterationLabel("Details"), value: iterationPathSummary(run.path) },
    { label: iterationLabel("SDK"), value: run.sdk.name },
    ...testRun.details,
  );

  console.log(`\nWhen this run produces data, view it at:\n  ${SITUATIONAL_RESULTS_URL}`);
  details.push({ label: "Results UI", value: SITUATIONAL_RESULTS_URL });
  if (!testRun.ok) {
    throwFatalToIteration("FIT tests failed — check the test-driver log for details.");
  }
  return { artifacts, details };
}

/**
 * Reconstruct the performer a previous run left running for this iteration,
 * after checking its container is still up. Returns undefined (explaining why)
 * if the run state has no performer for the run or the container is gone.
 */
async function resumePerformer(
  execution: FitExecutionContext,
  run: ResolvedExecutionRun,
  savedState: RunState | undefined,
  globalIterationIndex: number,
): Promise<RunningPerformer | undefined> {
  const saved = savedState?.performers.find((performer) => performer.globalRunIndex === globalIterationIndex);
  if (!saved?.containerId) {
    fitCliError(
      `\nresume: the run state has no performer for run ${globalIterationIndex + 1}. ` +
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

  console.log(`\n→ resume: reusing performer container ${saved.containerId} for run ${globalIterationIndex + 1}.`);
  const logFile = createLogFile(performerLogStem(run.path, run.sdk, run.performerVersion));
  return {
    containerId: saved.containerId,
    logFile,
    artifacts: [artifactFromPath(logFile, `${run.sdk.name} performer logs captured for this FIT run`)],
    details: [],
  };
}

 function printResumeHint(point: ResumePoint, definitionPath: string, path: DefinitionRunPath, includeRun: boolean): void {
  console.log(`\n→ Resume from here: ${formatResumeCommand(point, definitionPath, resumeSelectorFromPath(path, includeRun))}`);
}

/** Run one iteration: stand up (or reuse) its performer, then run the tests. */
async function runIteration(
  execution: FitExecutionContext,
  functionalClusterMode: ResolvedFunctionalExecutionGroup["clusterMode"] | undefined,
  fitPerformerGerritRef: string | undefined,
  run: ResolvedExecutionRun,
  setupPerformerPhase: boolean,
  savedState: RunState | undefined,
  globalIterationIndex: number,
  definitionPath: string,
): Promise<{ output: RunOutput; performer?: RunningPerformer }> {
  const artifacts: Artifact[] = [];
  const details: Detail[] = [];

  const performer = setupPerformerPhase
    ? await setupPerformer(execution, fitPerformerGerritRef, run)
    : await resumePerformer(execution, run, savedState, globalIterationIndex);
  if (!performer) {
    throwFatalToIteration("The performer isn't ready to run; stopping this iteration.");
  }
  artifacts.push(...performer.artifacts);
  if (setupPerformerPhase && performer.containerId) {
    printResumeHint("after-performer", definitionPath, run.path, true);
  }

  let output: RunOutput;
  if (run.type === "situational") {
    output = await runSituationalTests(execution, run);
  } else {
    const clusterMode: ResolvedFunctionalExecutionGroup["clusterMode"] = functionalClusterMode ?? "useExisting";
    output = await runTests(execution, clusterMode, run, performer);
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
  group: ResolvedFunctionalExecutionGroup,
  savedState: RunState | undefined,
  execution: FitExecutionContext,
): Promise<{ group: ResolvedFunctionalExecutionGroup; clusterState?: ResumeClusterState }> {
  // Existing-cluster modes already carry the cluster from the file, so there's
  // nothing in the run state to reuse — the resolved iterations are ready.
  if (group.clusterMode !== "cbdinocluster") {
    return { group };
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
  if (!(await runClusterDiag(clusterState.cluster, { captureCommand: (cmd, args, cwd, runOpts) => execution.capture(cmd, args, cwd, runOpts) }))) {
    throw new Error(
      "resume: the saved cluster is no longer reachable. Re-run without --resume-at to allocate a fresh one.",
    );
  }
  return { group: applyGroupCluster(group, clusterState.cluster), clusterState };
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

function hasResumeSelector(selector: ResumeSelector): boolean {
  return Object.values(selector).some((value) => value !== undefined);
}

function resumeSelectorFromPath(path: DefinitionRunPath, includeRun: boolean): ResumeSelector {
  return {
    instance: path.instanceIndex + 1,
    ...(!path.clusterlessSession && path.clusterIndex !== undefined ? { cluster: path.clusterIndex + 1 } : {}),
    ...(path.clusterlessSession && includeRun && path.sessionIndex !== undefined
      ? { clusterlessSession: path.sessionIndex + 1 }
      : {}),
    ...(!path.clusterlessSession && includeRun && path.sessionIndex !== undefined ? { session: path.sessionIndex + 1 } : {}),
    ...(includeRun && path.runIndex !== undefined ? { run: path.runIndex + 1 } : {}),
  };
}

function resumeSelectorFlags(selector: ResumeSelector): string[] {
  return [
    ...(selector.instance !== undefined ? [`--resume-instance=${selector.instance}`] : []),
    ...(selector.cluster !== undefined ? [`--resume-cluster=${selector.cluster}`] : []),
    ...(selector.clusterlessSession !== undefined ? [`--resume-clusterless-session=${selector.clusterlessSession}`] : []),
    ...(selector.session !== undefined ? [`--resume-session=${selector.session}`] : []),
    ...(selector.run !== undefined ? [`--resume-run=${selector.run}`] : []),
  ];
}

function formatResumeCommand(point: ResumePoint, definitionPath: string, selector: ResumeSelector): string {
  return `npm run definition -- execute --resume-at=${point} ${resumeSelectorFlags(selector).join(" ")} ${definitionPath}`.replace(/\s+/g, " ").trim();
}

function resumeSelectorMatchesPath(selector: ResumeSelector, path: DefinitionRunPath): boolean {
  const clusterlessSession = path.clusterlessSession === true;
  return (
    (selector.instance === undefined || selector.instance === path.instanceIndex + 1) &&
    (selector.cluster === undefined || (!clusterlessSession && selector.cluster === (path.clusterIndex ?? 0) + 1)) &&
    (selector.clusterlessSession === undefined || (clusterlessSession && selector.clusterlessSession === (path.sessionIndex ?? 0) + 1)) &&
    (selector.session === undefined || (!clusterlessSession && selector.session === (path.sessionIndex ?? 0) + 1)) &&
    (selector.run === undefined || selector.run === (path.runIndex ?? 0) + 1)
  );
}

function describeRunPath(path: DefinitionRunPath): string {
  return path.clusterlessSession
    ? `instance ${path.instanceIndex + 1} / clusterless session ${(path.sessionIndex ?? 0) + 1} / run ${(path.runIndex ?? 0) + 1}`
    : `instance ${path.instanceIndex + 1} / cluster ${(path.clusterIndex ?? 0) + 1} / session ${(path.sessionIndex ?? 0) + 1} / run ${(path.runIndex ?? 0) + 1}`;
}

/** One-line summary of the instance/cluster/session for the detail table. */
function iterationPathSummary(path: DefinitionRunPath): string {
  return path.clusterlessSession
    ? `Instance ${path.instanceIndex + 1}, Session ${(path.sessionIndex ?? 0) + 1}`
    : `Instance ${path.instanceIndex + 1}, Cluster ${(path.clusterIndex ?? 0) + 1}, Session ${(path.sessionIndex ?? 0) + 1}`;
}

interface TeardownInputs {
  definitionPath: string;
  /** Artifact directory for this run; undefined if the run failed before it was created. */
  runDir?: string;
  executionGroupIndex: number;
  /** Within the active execution group, the run that was active at teardown. */
  runIndex: number;
  resumePath?: DefinitionRunPath;
  /** The remote/local context — absent if the run failed before it came up. */
  execution?: FitExecutionContext;
  teardown: ExecutionTargetTeardown;
  /** Whether the run forced every execution group onto localhost; persisted so resume matches. */
  forceLocalhost: boolean;
  clusterState?: ResumeClusterState;
  performers: readonly RunningPerformer[];
  performerStates: readonly ResumePerformerState[];
}

/**
 * Tear down a single execution group's resources without prompting: stop its performers,
 * remove a cluster it allocated, and terminate an instance fit-cli provisioned for
 * it. Used at the end of an execution group that completed (or was abandoned) and isn't the
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
  const { definitionPath, runDir, executionGroupIndex, runIndex, resumePath, execution, teardown, forceLocalhost, clusterState, performers, performerStates } = inputs;

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
      executionGroupIndex,
      startRunIndex: runIndex,
      ...(forceLocalhost ? { forceLocalhost } : {}),
      target: targetStateFrom(teardown),
      ...(clusterState ? { cluster: clusterState } : {}),
      performers: [...performerStates],
    };
    const path = runDir ? writeRunState(runDir, state) : undefined;
    console.log(`\n✓ Leaving everything up.${path ? ` Saved run state to:\n  ${path}` : ""}`);

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
    const resumeDefinitionPath = runDir ? join(runDir, basename(resolve(definitionPath))) : definitionPath;
    if (lastSuggestion && resumePath) {
      console.log(
        `\nResume after a manual fix with:\n  ${formatResumeCommand(lastSuggestion, resumeDefinitionPath, resumeSelectorFromPath(resumePath, true))}`,
      );
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
 * Decide whether to force every execution group onto localhost, ignoring each group's
 * `instance:` setting. Resuming reuses the earlier run's choice. Otherwise: if no
 * execution group wants AWS there's nothing to override; interactively we prompt (defaulting
 * to honoring the file); non-interactively we default to honoring the definition file so a
 * CI run provisions whatever the file asks for.
 */
async function resolveForceLocalhost(
  groups: readonly ResolvedExecutionGroup[],
  savedState: RunState | undefined,
): Promise<boolean> {
  if (savedState) {
    return savedState.forceLocalhost ?? false;
  }
  if (!groups.some((group) => group.instance.kind === "aws")) {
    return false;
  }
  if (!isInteractiveRun()) {
    return false;
  }
  return confirm({
    promptId: "run-from-definition.force-localhost",
    message: "Run everything directly on localhost overriding where the definition says?  (Good for testing and local development)",
    default: false,
  });
}

export interface RunFromDefinitionOptions {
  resumeAt?: ResumePoint;
  resumeSelector?: ResumeSelector;
}

/** Run FIT functional tests as described by the definition file at `definitionPath`. */
export async function runFromDefinition(
  definitionPath: string,
  rootDir: string,
  options: RunFromDefinitionOptions = {},
): Promise<RunOutput> {
  const tracker = new RunFailureTracker();
  const { resumeAt, resumeSelector = {} } = options;
  const phases = phasesForResumePoint(resumeAt);
  const resolved = resolveDefinition(loadDefinition(definitionPath));
  const executionGroups = buildExecutionGroups(resolved.instances);
  console.log(`\nRunning FIT tests from definition:\n  ${definitionPath}`);

  const preconditionCtx = { instanceIndex: 0, cycleIndex: 0 };
  const savedState = resumeAt ? readRunState(dirname(resolve(definitionPath))) : undefined;
  if (resumeAt) {
    if (!savedState) {
      fitCliError(
        `\nresume: no saved run state found for ${definitionPath}. ` +
          "Run without --resume-at first, then choose to leave everything up.",
      );
      tracker.record("FatalToAll", "No saved run state found for resume", preconditionCtx);
      return finalizeRunFromDefinition([], [], undefined, tracker.worst, tracker.failureCount);
    }
    console.log(`  Resuming at: ${resumeAt}`);
  }
  const startCycleIndex = savedState?.executionGroupIndex ?? 0;
  const startIterationIndex = savedState?.startRunIndex ?? 0;
  const expectedResumePath = executionGroups[startCycleIndex]?.runs[startIterationIndex]?.path;
  if (resumeAt && hasResumeSelector(resumeSelector)) {
    if (!expectedResumePath) {
      fitCliError("\nresume: the saved run state points at a run that no longer exists in this definition.");
      tracker.record("FatalToAll", "Saved run state points at a run that no longer exists", preconditionCtx);
      return finalizeRunFromDefinition([], [], undefined, tracker.worst, tracker.failureCount);
    }
    if (!resumeSelectorMatchesPath(resumeSelector, expectedResumePath)) {
      fitCliError(
        `\nresume: the requested path does not match the saved run state.\n` +
          `  Requested: ${resumeSelectorFlags(resumeSelector).join(" ")}\n` +
          `  Saved:     ${describeRunPath(expectedResumePath)}`,
      );
      tracker.record("FatalToAll", "Requested resume path does not match saved run state", preconditionCtx);
      return finalizeRunFromDefinition([], [], undefined, tracker.worst, tracker.failureCount);
    }
  }

  // Resolve GitHub credentials upfront so we fail before provisioning an instance.
  let githubCredentials: { user: string; token: string } | undefined;
  if (
    phases.setupCluster &&
    executionGroups
      .slice(startCycleIndex)
      .some((group) => group.type === "functional" && group.clusterMode === "cbdinocluster")
  ) {
    const result = resolveGithubCredentials();
    if (typeof result === "string") {
      fitCliError(`\n✗ ${result}`);
      tracker.record("FatalToAll", result, preconditionCtx);
      return finalizeRunFromDefinition([], [], undefined, tracker.worst, tracker.failureCount);
    }
    githubCredentials = result;
  }

  // Resolve AWS credentials upfront for situational cycles — the test-driver's
  // cbdinocluster call uses the cloud (AWS) deployer.
  let awsCredentials: AwsCredentials | undefined;
  if (executionGroups.slice(startCycleIndex).some((group) => group.type === "situational")) {
    const result = await resolveAwsCredentials();
    if (typeof result === "string") {
      fitCliError(`\n✗ ${result}`);
      tracker.record("FatalToAll", result, preconditionCtx);
      return finalizeRunFromDefinition([], [], undefined, tracker.worst, tracker.failureCount);
    }
    awsCredentials = result;
  }

  // Check hosted results-database config and connectivity upfront — fail before
  // provisioning an instance when the run can't reach the database.
  const needsHostedDatabase = executionGroups
    .slice(startCycleIndex)
    .some(
      (group) =>
        group.type === "situational" &&
        group.runs.some((run) => run.databaseMode === "hosted"),
    );
  if (needsHostedDatabase) {
    const database = buildHostedDatabase(resolveResultsDbCredentials({ env: {} }));
    if (!database) {
      fitCliError(
        `\n✗ The hosted results database needs a readonly password in your fit-cli config.\n` +
          `  Ask on #the-fit-stop for it, then set it as resultsDb.password in your fit-cli config\n` +
          `  (~/.fit-cli/config.json5 — run \`npm run init\`).`,
      );
      tracker.record("FatalToAll", "Missing results database password in fit-cli config", preconditionCtx);
      return finalizeRunFromDefinition([], [], undefined, tracker.worst, tracker.failureCount);
    }
    console.log(`\nChecking connectivity to results database at ${HOSTED_RESULTS_DB_HOST}...`);
    if (!(await checkResultsDatabaseConnectivity())) {
      fitCliError(
        `\n✗ Cannot reach the results database at ${HOSTED_RESULTS_DB_HOST}:5432.\n` +
          `  Make sure you are connected to the vpn-public VPN.`,
      );
      tracker.record("FatalToAll", `Cannot reach results database at ${HOSTED_RESULTS_DB_HOST}:5432`, preconditionCtx);
      return finalizeRunFromDefinition([], [], undefined, tracker.worst, tracker.failureCount);
    }
    console.log(`  ✓ Reached ${HOSTED_RESULTS_DB_HOST}.`);
  }

  const artifacts: Artifact[] = [];
  const details: Detail[] = [];

  const runDir = ensureRunDir();
  const definitionCopyPath = join(runDir, basename(resolve(definitionPath)));
  copyFileSync(definitionPath, definitionCopyPath);
  artifacts.push(artifactFromPath(definitionCopyPath, "Definition file used for this run", runDir));

  // One run-wide choice: force every execution group onto localhost, ignoring each group's
  // declared instance. Each execution group then provisions (or reconnects) its own target.
  const forceLocalhost = await resolveForceLocalhost(executionGroups.slice(startCycleIndex), savedState);

  // The "active" set tracks the cycle currently up so the outer finally tears down
  // (or offers to leave up) the right instance/cluster/performers. Completed,
  // non-final cycles dispose of their own resources inside the loop.
  let activeExecution: FitExecutionContext | undefined;
  let activeTeardown: ExecutionTargetTeardown = { kind: "local" };
  let activeCycleIndex = startCycleIndex;
  let activeIterationIndex = startIterationIndex;
  let activeResumePath: DefinitionRunPath | undefined = expectedResumePath;
  let activeClusterState: ResumeClusterState | undefined;
  let activePerformers: RunningPerformer[] = [];
  let activePerformerStates: ResumePerformerState[] = [];
  try {
    let globalIterationIndex = executionGroups
      .slice(0, startCycleIndex)
      .reduce((total, group) => total + group.runs.length, 0);

    try {
    for (let cycleIndex = startCycleIndex; cycleIndex < executionGroups.length; cycleIndex++) {
      activeCycleIndex = cycleIndex;
      if (cycleIndex !== startCycleIndex) {
        activeIterationIndex = 0;
      }
      const group = executionGroups[cycleIndex];
      if (!group) {
        break;
      }
      activeResumePath = group.path;
      console.log(`\nExecution group ${cycleIndex + 1}/${executionGroups.length}: ${group.type}`);
      console.log(`  Execution: ${forceLocalhost ? "localhost (forced)" : group.instance.kind}`);
      console.log(`  Cluster: ${clusterLabel(group)}`);

      // Acquire this cycle's execution target: reconnect the resumed instance for
      // the start cycle, otherwise provision (or run locally) per the definition.
      const isResumeStartCycle = savedState !== undefined && cycleIndex === startCycleIndex;
      const targetOutcome = isResumeStartCycle
        ? await reconnectExecutionTarget(savedState.target)
        : await resolveExecutionGroupTarget(group.instance, forceLocalhost, cycleIndex);
      artifacts.push(...targetOutcome.artifacts);
      details.push(...targetOutcome.details);
      if (!targetOutcome.ready) {
        fitCliError(`\n✗ Could not acquire an execution target for execution group ${cycleIndex + 1}; skipping it.`);
        tracker.record("FatalToCycle", `Could not acquire an execution target for execution group ${cycleIndex + 1}`, { instanceIndex: group.path.instanceIndex, cycleIndex });
        globalIterationIndex += group.runs.length;
        continue;
      }
      const cycleTeardown = targetOutcome.teardown;
      activeTeardown = cycleTeardown;
      if (cycleTeardown.kind === "remote" && cycleTeardown.address) {
        printResumeHint("after-instance-creation", definitionCopyPath, group.path, false);
      }

      const execution = await createFitExecutionContext(targetOutcome.target, rootDir, group.runs[0].sdk, {
        skipRemotePreparation: isResumeStartCycle && !phases.prepareRemote,
        instanceIndex: group.path.instanceIndex,
      });
      activeExecution = execution;
      artifacts.push(...execution.artifacts);
      details.push(...execution.details);
      if (phases.prepareRemote && cycleTeardown.kind === "remote" && cycleTeardown.address) {
        printResumeHint("after-remote-preparation", definitionCopyPath, group.path, false);
      }

      // This cycle's situational iterations may stream to the hosted DB; if it runs
      // on a remote box, confirm the box can reach the DB before doing real work.
      const cycleNeedsHostedDatabase =
        group.type === "situational" && group.runs.some((run) => run.databaseMode === "hosted");

      let activeCycle = group;
      let clusterState: ResumeClusterState | undefined;
      const cyclePerformers: RunningPerformer[] = [];
      const cyclePerformerStates: ResumePerformerState[] = [];

      try {
        if (cycleNeedsHostedDatabase && execution.kind === "remote") {
          console.log(`\nChecking results database connectivity from the remote instance...`);
          if (!(await checkResultsDatabaseConnectivity((cmd, args) => execution.capture(cmd, args)))) {
            throwFatalToCycle(
              `The remote instance cannot reach the results database at ${HOSTED_RESULTS_DB_HOST}:5432. ` +
                `Make sure the instance has network access to reach the database (VPN / security-group rules).`,
            );
          }
          console.log(`  ✓ Reached ${HOSTED_RESULTS_DB_HOST} from the remote instance.`);
        }

        if (group.type === "functional") {
          // CNG cycles need Kubernetes where cbdinocluster runs: check it on
          // localhost, or stand up k3d (and point the uploaded ~/.cbdinocluster at
          // it) on a clean instance, before allocating anything.
          const functionalCycle = await prepareFunctionalCngCycle(group, execution);
          if (cycleIndex === startCycleIndex && !phases.setupCluster) {
            const resumed = await resumeCluster(functionalCycle, savedState, execution);
            activeCycle = resumed.group;
            clusterState = resumed.clusterState;
          } else {
            const setup = await setupCluster(functionalCycle, execution, setupDeclarativeCluster, githubCredentials);
            activeCycle = setup.group;
            clusterState = setup.clusterState;
            artifacts.push(...setup.artifacts);
            details.push(...setup.details);
            if (cbdinoclusterSetupFailed(activeCycle, true)) {
              throwFatalToCycle("setup-cluster didn't produce a cluster, so this execution group can't continue.");
            }
            if (clusterState) {
              printResumeHint("after-cluster-creation", definitionCopyPath, activeCycle.path, false);
            }
          }
        } else {
          await prepareCbdinoclusterConfig(
            execution,
            group.cbdinoclusterInit.config,
            undefined,
            instanceRunDir(group.path.instanceIndex),
          );
          if (execution.kind === "remote" && awsCredentials) {
            await uploadRemoteAwsCredentials(execution.target, execution.rootDir, awsCredentials);
          }
        }

        for (const [cycleIterationIndex, iteration] of activeCycle.runs.entries()) {
          if (cycleIndex === startCycleIndex && cycleIterationIndex < startIterationIndex) {
            globalIterationIndex++;
            continue;
          }
          activeIterationIndex = cycleIterationIndex;
          activeResumePath = iteration.path;
          const isLastIteration = cycleIterationIndex === activeCycle.runs.length - 1;
          announce(activeCycle, iteration, resolved.fitPerformerGerritRef);
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
                    globalRunIndex: globalIterationIndex,
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
              tracker.record("FatalToIteration", err.message, { instanceIndex: group.path.instanceIndex, cycleIndex, iterationIndex: cycleIterationIndex });
            } else {
              throw err;
            }
          }
          globalIterationIndex++;
        }
      } catch (err) {
        if (err instanceof ClassifiedFailure && err.classification === "FatalToCycle") {
          fitCliError(`\n✗ ${err.message} (FatalToCycle)`);
          tracker.record("FatalToCycle", err.message, { instanceIndex: group.path.instanceIndex, cycleIndex });
          globalIterationIndex += activeCycle.runs.length;

          // Promote this cycle as the active set so that stopping here lets
          // teardownRun offer to leave its instance/cluster/performers up.
          activeClusterState = clusterState;
          activePerformers = cyclePerformers;
          activePerformerStates = cyclePerformerStates;

          const isLastCycle = cycleIndex === executionGroups.length - 1;
          if (isLastCycle) {
            break;
          }

          const continueToNextCycle = await confirm({
            promptId: "run-from-definition.fatal-to-cycle.continue",
            message: "Continue to the next execution group? (this instance and its resources are cleaned up first)",
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

      const isLastCycle = cycleIndex === executionGroups.length - 1;
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
    } catch (err) {
      if (err instanceof ClassifiedFailure && err.classification === "FatalToAll") {
        fitCliError(`\n✗ ${err.message} (FatalToAll — aborting run)`);
        tracker.record("FatalToAll", err.message, { instanceIndex: activeCycleIndex, cycleIndex: activeCycleIndex });
      } else {
        throw err;
      }
    }

    return finalizeRunFromDefinition(artifacts, details, runDir, tracker.worst, tracker.failureCount);
  } finally {
    await teardownRun({
      definitionPath,
      runDir,
      executionGroupIndex: activeCycleIndex,
      runIndex: activeIterationIndex,
      ...(activeResumePath ? { resumePath: activeResumePath } : {}),
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
    const { resumeAt, positionals: resumeRest } = extractResumeAt(positionals);
    const { selector: resumeSelector, positionals: rest } = extractResumeSelector(resumeRest);
    const [definitionPath, ...extra] = rest;
    if (!definitionPath || extra.length > 0) {
      console.error(
        "Primary usage: npm run definition -- execute <file.yaml> [--resume-at=<point>] [--resume-instance=<n>] [--resume-cluster=<n>] [--resume-session=<n>] [--resume-clusterless-session=<n>] [--resume-run=<n>] [--root <dir>]\n" +
          "Direct:        tsx src/workflows/fit-functional/run-from-definition/run-from-definition.ts <file.yaml> [--resume-at=<point>] [resume selectors]\n" +
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
    return runFromDefinition(definitionPath, rootDir, {
      ...(resumePoint ? { resumeAt: resumePoint } : {}),
      ...(hasResumeSelector(resumeSelector) ? { resumeSelector } : {}),
    });
  });
}
