/**
 * Build a reusable `fit` definition file interactively.
 *
 * Run on its own (skipping the top-level menu; add --root <dir> to point at
 * another workspace):
 *   npx tsx src/fit/shared/create-definition/create-definition.ts
 */
import { type RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { printWithoutTimestamps } from "../../../util/non-fit/fit-cli-log.js";
import { qualifyPromptId, select, confirm, input } from "../../../util/non-fit/prompts.js";
import { rootDirFromArgv } from "../../util/root.js";
import { loadFitCliConfig, resolveOutputFormat } from "../../util/config.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import { askClusterDef } from "../../../cluster/cluster-create/ask-cluster-def.js";
import { askClusterExistsPolicy } from "../../../cluster/cluster-create/ask-cluster-exists-policy.js";
import { selectCluster } from "../../../cluster/cluster-select/cluster-select.js";
import { askPerformerTag } from "../../performers/util/ask-performer-image.js";
import { askPortInUsePolicy } from "../../performers/util/ask-port-in-use-policy.js";
import { printDefinitionRunGuidance } from "../definition/run-guidance.js";
import { extractPushGistVisibility, pushGist, type GistVisibility } from "../definition/push-gist.js";
import { chooseResultsTarget } from "../../situational/choose-results-database/choose-results-database.js";
import { loadEnvironments } from "../../util/environments.js";
import { DEFAULT_CAPELLA_ENV } from "../../util/config.js";
import {
  buildFitDefinition,
  buildFitFunctionalDefinitionFrom,
  buildFitSituationalDefinitionFrom,
  type DefinitionCluster,
  type DefinitionFormat,
  formatFitDefinition,
  formatFitSituationalDefinition,
  writeFitDefinition,
  writeFitSituationalDefinition,
} from "../definition/generate-definition.js";
import type {
  ClusterConfigRef,
  ClusterLifetime,
  FitConfigRef,
  FitDefinition,
  FitRun,
  InstanceLifetime,
  InstanceMode,
  SessionLifetime,
} from "../definition/types.js";
import {
  FUNCTIONAL_TEST_DOMAIN,
  SITUATIONAL_TEST_DOMAIN,
  selectFitTests,
} from "../select-fit-tests/select-fit-tests.js";
import { createLocalFitExecutionContext } from "../util/remote-fit-run.js";

async function chooseDefinitionCluster(): Promise<DefinitionCluster> {
  const selection = await selectCluster();
  if (selection.mode === "existing") {
    return { kind: "connection", cluster: selection.cluster };
  }
  const def = await askClusterDef();
  return { kind: "cbdinocluster", def };
}

export async function askFitGerritRef(promptIdPrefix?: string): Promise<string | undefined> {
  const shouldUseGerritRef = await confirm({
    promptId: qualifyPromptId("fit.definition.performer.gerrit-ref.enabled", promptIdPrefix),
    message: "Do you want to fetch and checkout a specific transactions-fit-performer Gerrit ref before execution?",
    default: false,
  });
  if (!shouldUseGerritRef) {
    return undefined;
  }

  const gerritRef = await input({
    promptId: qualifyPromptId("fit.definition.performer.gerrit-ref.value", promptIdPrefix),
    message: "Which transactions-fit-performer Gerrit ref should fit-cli fetch and checkout (e.g. refs/changes/29/246329/1)?",
    validate: (value) => value.trim() ? true : "Enter a Gerrit ref like refs/changes/29/246329/1.",
  });
  return gerritRef.trim();
}

type DefinitionBuilderAction = "functional" | "situational" | "performance" | "done";
type FunctionalConnectivity = "operational" | "cng";

interface DefinitionBuilderState {
  gerritRefAsked: boolean;
  gerritRef?: string;
  instances: InstanceLifetime[];
  fitConfigs: FitConfigRef[];
  clusterConfigs: ClusterConfigRef[];
}

async function chooseDefinitionBuilderAction(index: number): Promise<DefinitionBuilderAction> {
  return select<DefinitionBuilderAction>({
    promptId: qualifyPromptId(`fit.definition.builder.action.${index}`),
    message: "What would you like to add to this FIT definition file?",
    choices: [
      { name: "Add FIT functional testing", value: "functional" },
      { name: "Add FIT situational testing", value: "situational" },
      { name: "Add FIT performance testing (coming later!)", value: "performance" },
      { name: "I'm done with the FIT definition building", value: "done" },
    ],
    default: index > 1 ? "done" : undefined,
  });
}

async function chooseFunctionalConnectivity(promptIdPrefix: string): Promise<FunctionalConnectivity> {
  return select<FunctionalConnectivity>({
    promptId: qualifyPromptId("connectivity", promptIdPrefix),
    message: "What do you want to FIT functional test against?  (Only operational supported today, CNG and Analytics to come)",
    choices: [
      { name: "Operational", value: "operational" },
      // CNG (Cloud Native Gateway, couchbase2://) is commented out for now.
      // { name: "Cloud Native Gateway, couchbase2://)", value: "cng" },
    ],
  });
}

export function functionalInstanceConnectivity(instance: InstanceLifetime): FunctionalConnectivity {
  const cluster = instance.clusters[0];
  return cluster?.cbdinocluster?.config.cao !== undefined ? "cng" : "operational";
}

async function chooseFunctionalDefinitionCluster(connectivity: FunctionalConnectivity): Promise<DefinitionCluster> {
  if (connectivity === "cng") {
    return { kind: "cbdinocluster", def: await askClusterDef({ cng: true }) };
  }
  return chooseDefinitionCluster();
}

async function chooseInstanceExecution(promptIdPrefix: string): Promise<InstanceMode> {
  const choice = await select<"localhost" | "aws">({
    promptId: qualifyPromptId("execution.instance", promptIdPrefix),
    message: "Where should this instance's tests execute? (You can override this at runtime and run it on localhost)",
    choices: [
      { name: "A clean AWS EC2 instance", value: "aws" },
      { name: "This machine (localhost)", value: "localhost" },
    ],
  });
  return choice === "aws" ? { aws: {} } : { localhost: {} };
}

async function ensureSharedRepoSetup(state: DefinitionBuilderState): Promise<void> {
  if (state.gerritRefAsked) {
    return;
  }
  state.gerritRef = await askFitGerritRef("fit.definition.shared");
  state.gerritRefAsked = true;
}

function lastFunctionalInstance(state: DefinitionBuilderState): InstanceLifetime | undefined {
  const last = state.instances.at(-1);
  return last && last.clusters.length > 0 ? last : undefined;
}

function lastSituationalInstance(state: DefinitionBuilderState): InstanceLifetime | undefined {
  const last = state.instances.at(-1);
  return last?.clusterlessSessions && last.clusterlessSessions.length > 0 ? last : undefined;
}

function runCount(state: DefinitionBuilderState): number {
  return state.instances.reduce(
    (total, instance) =>
      total +
      instance.clusters.reduce(
        (clusterTotal, cluster) => clusterTotal + cluster.sessions.reduce((sessionTotal, session) => sessionTotal + session.runs.length, 0),
        0,
      ) +
      (instance.clusterlessSessions?.reduce((sessionTotal, session) => sessionTotal + session.runs.length, 0) ?? 0),
    0,
  );
}

function remapRunFitConfigRef(run: FitRun, fitMap: Map<string, string>): FitRun {
  if (typeof run.fitConfig !== "string") return run;
  const newId = fitMap.get(run.fitConfig);
  return newId !== undefined ? { ...run, fitConfig: newId } : run;
}

function remapSessionRefs(session: SessionLifetime, fitMap: Map<string, string>): SessionLifetime {
  return { ...session, runs: session.runs.map((r) => remapRunFitConfigRef(r, fitMap)) };
}

function remapClusterRefs(cluster: ClusterLifetime, fitMap: Map<string, string>, clusterMap: Map<string, string>): ClusterLifetime {
  const remapped: ClusterLifetime = {
    ...cluster,
    sessions: cluster.sessions.map((s) => remapSessionRefs(s, fitMap)),
  };
  if (typeof remapped.clusterConfig === "string") {
    const newId = clusterMap.get(remapped.clusterConfig);
    if (newId !== undefined) return { ...remapped, clusterConfig: newId };
  }
  return remapped;
}

function remapInstanceRefs(instance: InstanceLifetime, fitMap: Map<string, string>, clusterMap: Map<string, string>): InstanceLifetime {
  return {
    ...instance,
    clusters: instance.clusters.map((c) => remapClusterRefs(c, fitMap, clusterMap)),
    ...(instance.clusterlessSessions !== undefined
      ? { clusterlessSessions: instance.clusterlessSessions.map((s) => remapSessionRefs(s, fitMap)) }
      : {}),
  };
}

/**
 * Collect a sub-definition's configs into state with unique IDs and return the
 * remapped instance. Sub-definitions from buildFit*DefinitionFrom always use the
 * same constant IDs ("fit-config-0", "cluster-0"), so each new instance gets its
 * IDs offset by the current count in state to avoid collisions.
 */
function collectSubDefInstance(state: DefinitionBuilderState, subDef: FitDefinition): InstanceLifetime {
  const fitMap = new Map<string, string>();
  for (const fc of subDef.fitConfigs ?? []) {
    const newId = `fit-config-${state.fitConfigs.length}`;
    fitMap.set(fc.id, newId);
    state.fitConfigs.push({ ...fc, id: newId });
  }
  const clusterMap = new Map<string, string>();
  for (const cc of subDef.clusterConfigs ?? []) {
    const newId = `cluster-${state.clusterConfigs.length}`;
    clusterMap.set(cc.id, newId);
    state.clusterConfigs.push({ ...cc, id: newId });
  }
  const instance = subDef.instances[0];
  if (!instance) {
    throw new Error("Expected sub-definition to contain one instance.");
  }
  return remapInstanceRefs(instance, fitMap, clusterMap);
}

/**
 * Collect a session from a sub-definition, remapping its fitConfig ref to
 * `existingFitConfigId` (the ID already in state for this instance's cluster).
 * Used when adding a second SDK session to an existing cluster — the cluster and
 * fitConfig are shared; only the session (performer + tests) is new.
 */
function collectSubDefSession(existingFitConfigId: string, subDef: FitDefinition): SessionLifetime {
  const subFitConfigId = subDef.fitConfigs?.[0]?.id;
  if (!subFitConfigId) {
    throw new Error("Expected sub-definition to contain a fitConfig.");
  }
  const session = subDef.instances[0]?.clusters[0]?.sessions[0];
  if (!session) {
    throw new Error("Expected sub-definition to contain one session.");
  }
  return remapSessionRefs(session, new Map([[subFitConfigId, existingFitConfigId]]));
}

/**
 * Collect a clusterless session from a sub-definition, remapping its fitConfig
 * ref to `existingFitConfigId`. Used when adding a second SDK to an existing
 * situational instance.
 */
function collectSubDefClusterlessSession(existingFitConfigId: string, subDef: FitDefinition): SessionLifetime {
  const subFitConfigId = subDef.fitConfigs?.[0]?.id;
  if (!subFitConfigId) {
    throw new Error("Expected sub-definition to contain a fitConfig.");
  }
  const session = subDef.instances[0]?.clusterlessSessions?.[0];
  if (!session) {
    throw new Error("Expected sub-definition to contain one clusterless session.");
  }
  return remapSessionRefs(session, new Map([[subFitConfigId, existingFitConfigId]]));
}

async function addFunctionalRun(
  rootDir: string,
  state: DefinitionBuilderState,
  runIndex: number,
): Promise<void> {
  await ensureSharedRepoSetup(state);
  const promptIdPrefix = `fit.definition.run.${runIndex + 1}.functional`;
  const execution = createLocalFitExecutionContext(rootDir);
  const connectivity = await chooseFunctionalConnectivity(promptIdPrefix);
  const sdk = await chooseSdk("Which SDK do you want to test with FIT functional?", promptIdPrefix);
  const version = await askPerformerTag(sdk, promptIdPrefix);
  const onPortInUse = await askPortInUsePolicy(promptIdPrefix);
  const selection = await selectFitTests(execution, FUNCTIONAL_TEST_DOMAIN, promptIdPrefix);

  const currentInstance = lastFunctionalInstance(state);
  if (currentInstance && functionalInstanceConnectivity(currentInstance) === connectivity) {
    const existingFitConfigId = currentInstance.clusters[0]?.sessions[0]?.runs[0]?.fitConfig;
    if (typeof existingFitConfigId !== "string") {
      throw new Error("Expected existing instance's run to have a fitConfig string ref.");
    }
    const subDef = buildFitFunctionalDefinitionFrom({
      cluster: functionalDefinitionCluster(currentInstance, state.clusterConfigs),
      sdk,
      ...(version ? { version } : {}),
      onPortInUse,
      selection,
      githubUser: loadFitCliConfig().config?.github?.user,
    });
    currentInstance.clusters[0]?.sessions.push(collectSubDefSession(existingFitConfigId, subDef));
    return;
  }

  console.log(
    connectivity === "cng"
      ? "\nStarting a new FIT functional CNG instance. cbdinocluster installs the gateway via the Couchbase Kubernetes Operator, so this needs Kubernetes."
      : "\nStarting a new FIT functional instance. Runs added now will share one cluster lifetime on that instance.",
  );
  const instance = await chooseInstanceExecution(promptIdPrefix);
  const cluster = await chooseFunctionalDefinitionCluster(connectivity);
  const onClusterExists = cluster.kind === "cbdinocluster" ? await askClusterExistsPolicy() : undefined;
  const subDef = buildFitFunctionalDefinitionFrom({
    cluster,
    instance,
    ...(onClusterExists ? { onClusterExists } : {}),
    sdk,
    ...(version ? { version } : {}),
    onPortInUse,
    selection,
    githubUser: loadFitCliConfig().config?.github?.user,
  });
  const generatedInstance = collectSubDefInstance(state, subDef);
  if (!generatedInstance) {
    throw new Error("Expected a generated functional definition to contain one instance.");
  }
  state.instances.push(generatedInstance);
}

function functionalDefinitionCluster(instance: InstanceLifetime, clusterConfigs: ClusterConfigRef[]): DefinitionCluster {
  const cluster = instance.clusters[0];
  if (!cluster) {
    throw new Error("Expected a functional instance to contain one cluster.");
  }
  // Resolve a string clusterConfig ref to its stored config
  const clusterData = typeof cluster.clusterConfig === "string"
    ? clusterConfigs.find((cc) => cc.id === cluster.clusterConfig) ?? cluster
    : cluster;
  if (clusterData.cbdinocluster) {
    const firstNode = clusterData.cbdinocluster.config.nodes[0];
    if (!firstNode) {
      throw new Error("Functional cbdinocluster config must contain at least one node.");
    }
    return {
      kind: "cbdinocluster",
      def: {
        nodeCount: firstNode.count,
        version: firstNode.version,
        services: firstNode.services,
        cng: clusterData.cbdinocluster.config.cao !== undefined,
      },
    };
  }
  if (!clusterData.connection) {
    throw new Error("Functional instance connection clusters must include connection details.");
  }
  return {
    kind: "connection",
    cluster: {
      scheme: clusterData.connection.connectionString.startsWith("couchbases://") ? "couchbases" : "couchbase",
      defaultHostname: clusterData.connection.connectionString.replace(/^couchbases?:\/\//, ""),
      flavour: "self-managed",
      credentials: {
        username: clusterData.connection.username,
        password: clusterData.connection.password,
      },
      tls: clusterData.connection.tls ?? null,
    },
  };
}

/** Prompt for which Capella environment to deploy clusters in, sourced from environments.json5. */
async function chooseCapellaEnvironment(promptIdPrefix: string): Promise<string> {
  const capella = loadEnvironments().capella;
  const names = Object.keys(capella);
  if (names.length === 0) return DEFAULT_CAPELLA_ENV;
  // Always prompt (even with a single environment) so the choice is explicit and confirmed.
  return select<string>({
    promptId: qualifyPromptId("situational.capella.environment", promptIdPrefix),
    message: "Which Capella environment should clusters be created in?",
    default: names.includes(DEFAULT_CAPELLA_ENV) ? DEFAULT_CAPELLA_ENV : names[0],
    choices: names.map((name) => ({ name: `${name} — ${capella[name].endpoint ?? "(endpoint not set)"}`, value: name })),
  });
}

async function addSituationalRun(
  rootDir: string,
  state: DefinitionBuilderState,
  runIndex: number,
): Promise<void> {
  await ensureSharedRepoSetup(state);
  const promptIdPrefix = `fit.definition.run.${runIndex + 1}.situational`;
  const execution = createLocalFitExecutionContext(rootDir);
  const sdk = await chooseSdk("Which SDK do you want to test with FIT situational?", promptIdPrefix);
  const version = await askPerformerTag(sdk, promptIdPrefix);
  const onPortInUse = await askPortInUsePolicy(promptIdPrefix);
  // One prompt for where results go (hosted env, with its host, or local); then the Capella env.
  const { mode: databaseMode, resultsEnvironment } = await chooseResultsTarget(promptIdPrefix);
  const capellaEnvironment = await chooseCapellaEnvironment(promptIdPrefix);
  const selection = await selectFitTests(execution, SITUATIONAL_TEST_DOMAIN, promptIdPrefix);

  const currentInstance = lastSituationalInstance(state);
  if (currentInstance?.clusterlessSessions) {
    const existingFitConfigId = currentInstance.clusterlessSessions[0]?.runs[0]?.fitConfig;
    if (typeof existingFitConfigId !== "string") {
      throw new Error("Expected existing instance's run to have a fitConfig string ref.");
    }
    const subDef = buildFitSituationalDefinitionFrom({
      sdk,
      ...(version ? { version } : {}),
      onPortInUse,
      databaseMode,
      ...(resultsEnvironment ? { resultsEnvironment } : {}),
      capellaEnvironment,
      selection,
    });
    currentInstance.clusterlessSessions.push(collectSubDefClusterlessSession(existingFitConfigId, subDef));
    return;
  }

  console.log("\nStarting a new FIT situational instance. FIT/SIT creates its own clusters.");
  const instance = await chooseInstanceExecution(promptIdPrefix);
  const subDef = buildFitSituationalDefinitionFrom({
    sdk,
    instance,
    ...(version ? { version } : {}),
    onPortInUse,
    databaseMode,
    ...(resultsEnvironment ? { resultsEnvironment } : {}),
    capellaEnvironment,
    selection,
  });
  const generatedInstance = collectSubDefInstance(state, subDef);
  if (!generatedInstance) {
    throw new Error("Expected a generated situational definition to contain one instance.");
  }
  state.instances.push(generatedInstance);
}

export async function createFitDefinition(rootDir: string, options?: { format?: DefinitionFormat; pushGistVisibility?: GistVisibility }): Promise<RunOutput> {
  console.log(
    "\nThis builds a reusable fit definition file. Nothing is set up — no cluster is allocated, no performer built, no tests run.\n",
  );

  const state: DefinitionBuilderState = { gerritRefAsked: false, instances: [], fitConfigs: [], clusterConfigs: [] };
  let actionIndex = 1;

  while (true) {
    const action = await chooseDefinitionBuilderAction(actionIndex++);
    if (action === "done") {
      break;
    }
    if (action === "performance") {
      console.log("\nFIT performance definition building is not wired up yet. Pick another testing type for now.");
      continue;
    }
    const nextRunIndex = runCount(state);
    if (action === "functional") {
      await addFunctionalRun(rootDir, state, nextRunIndex);
    } else {
      await addSituationalRun(rootDir, state, nextRunIndex);
    }
  }

  if (state.instances.length === 0) {
    console.log("\nNo FIT testing was added, so no definition file was written.");
    return { artifacts: [], details: [] };
  }

  const definition: FitDefinition = buildFitDefinition({
    ...(state.gerritRef ? { gerritRef: state.gerritRef } : {}),
    instances: state.instances,
    fitConfigs: state.fitConfigs,
    clusterConfigs: state.clusterConfigs,
  });

  const allRuns = definition.instances.flatMap((i) =>
    [...(i.clusterlessSessions ?? []), ...i.clusters.flatMap((c) => c.sessions)].flatMap((s) => s.runs),
  );
  const hasSituational = allRuns.some((r) => r.type === "situational");
  const outputFormat = options?.format ?? resolveOutputFormat();
  const write = hasSituational ? writeFitSituationalDefinition : writeFitDefinition;
  const formatFn = hasSituational ? formatFitSituationalDefinition : formatFitDefinition;
  const result = write(definition, undefined, outputFormat);
  const formatted = formatFn(definition, outputFormat);
  console.log(`\nWriting ${result.path}:\n`);
  printWithoutTimestamps(formatted);
  console.log(`\n✓ Wrote ${result.path}`);

  if (options?.pushGistVisibility) {
    console.log(`\nPushing ${options.pushGistVisibility} gist…`);
    const gist = await pushGist(result.path, formatted, options.pushGistVisibility);
    console.log(`✓ Gist created: ${gist.url}`);
  }

  printDefinitionRunGuidance(result.path);

  return { artifacts: [result.artifact], details: [] };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir, positionals } = rootDirFromArgv(process.argv.slice(2));
    const pushGistVisibility = extractPushGistVisibility(positionals);
    return createFitDefinition(rootDir, { pushGistVisibility });
  });
}
