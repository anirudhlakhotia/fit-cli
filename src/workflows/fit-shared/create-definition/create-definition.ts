/**
 * Build a reusable `fit` definition file interactively.
 *
 * Run on its own (skipping the top-level menu; add --root <dir> to point at
 * another workspace):
 *   npx tsx src/workflows/fit-shared/create-definition/create-definition.ts
 */
import { type RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { printWithoutTimestamps } from "../../../util/non-fit/fit-cli-log.js";
import { qualifyPromptId, select } from "../../../util/non-fit/prompts.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import { askClusterDef } from "../../cluster/cluster-create/ask-cluster-def.js";
import { askClusterExistsPolicy } from "../../cluster/cluster-create/ask-cluster-exists-policy.js";
import { askVersion } from "../../performers/build-performer/ask-version.js";
import { askPortInUsePolicy } from "../../performers/util/ask-port-in-use-policy.js";
import { askFitGerritRef, chooseDefinitionCluster } from "../../fit-functional/create-definition/create-definition.js";
import {
  chooseResultsDatabaseMode,
  type ResultsDatabaseMode,
} from "../choose-results-database/choose-results-database.js";
import {
  buildFitDefinition,
  buildFitFunctionalDefinitionFrom,
  buildFitSituationalDefinitionFrom,
  type DefinitionCluster,
  formatFitDefinition,
  writeFitDefinition,
} from "../definition/generate-definition.js";
import type { FitDefinition, InstanceLifetime, InstanceMode } from "../definition/types.js";
import {
  FUNCTIONAL_TEST_DOMAIN,
  SITUATIONAL_TEST_DOMAIN,
  selectFitTests,
} from "../select-fit-tests/select-fit-tests.js";
import { createLocalFitExecutionContext } from "../util/remote-fit-run.js";

type DefinitionBuilderAction = "functional" | "situational" | "performance" | "done";
type FunctionalConnectivity = "operational" | "cng";

interface DefinitionBuilderState {
  gerritRefAsked: boolean;
  gerritRef?: string;
  instances: InstanceLifetime[];
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
    default: index > 0 ? "done" : undefined,
  });
}

async function chooseFunctionalConnectivity(promptIdPrefix: string): Promise<FunctionalConnectivity> {
  return select<FunctionalConnectivity>({
    promptId: qualifyPromptId("connectivity", promptIdPrefix),
    message: "What do you want to FIT functional test against?",
    choices: [
      { name: "Operational, couchbase[s]://", value: "operational" },
      { name: "Cloud Native Gateway, couchbase2://)", value: "cng" },
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
  const version = await askVersion(promptIdPrefix);
  const onPortInUse = await askPortInUsePolicy(promptIdPrefix);
  const selection = await selectFitTests(execution, FUNCTIONAL_TEST_DOMAIN, promptIdPrefix);

  const currentInstance = lastFunctionalInstance(state);
  if (currentInstance && functionalInstanceConnectivity(currentInstance) === connectivity) {
    const generatedSession = buildFitFunctionalDefinitionFrom({
      cluster: functionalDefinitionCluster(currentInstance),
      sdk,
      ...(version ? { version } : {}),
      onPortInUse,
      selection,
    }).instances[0]?.clusters[0]?.sessions[0];
    if (!generatedSession) {
      throw new Error("Expected a generated functional definition to contain one session.");
    }
    currentInstance.clusters[0]?.sessions.push(
      generatedSession,
    );
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
  const generatedInstance = buildFitFunctionalDefinitionFrom({
    cluster,
    instance,
    ...(onClusterExists ? { onClusterExists } : {}),
    sdk,
    ...(version ? { version } : {}),
    onPortInUse,
    selection,
  }).instances[0];
  if (!generatedInstance) {
    throw new Error("Expected a generated functional definition to contain one instance.");
  }
  state.instances.push(generatedInstance);
}

function functionalDefinitionCluster(instance: InstanceLifetime): DefinitionCluster {
  const cluster = instance.clusters[0];
  if (!cluster) {
    throw new Error("Expected a functional instance to contain one cluster.");
  }
  if (cluster.cbdinocluster) {
    const firstNode = cluster.cbdinocluster.config.nodes[0];
    if (!firstNode) {
      throw new Error("Functional cbdinocluster config must contain at least one node.");
    }
    return {
      kind: "cbdinocluster",
      def: {
        nodeCount: firstNode.count,
        version: firstNode.version,
        services: firstNode.services,
        cng: cluster.cbdinocluster.config.cao !== undefined,
      },
    };
  }
  if (!cluster.connection) {
    throw new Error("Functional instance connection clusters must include connection details.");
  }
  return {
    kind: "connection",
    cluster: {
      scheme: cluster.connection.connectionString.startsWith("couchbases://") ? "couchbases" : "couchbase",
      defaultHostname: cluster.connection.connectionString.replace(/^couchbases?:\/\//, ""),
      flavour: "self-managed",
      credentials: {
        username: cluster.connection.username,
        password: cluster.connection.password,
      },
      tls: cluster.connection.tls ?? null,
    },
  };
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
  const version = await askVersion(promptIdPrefix);
  const onPortInUse = await askPortInUsePolicy(promptIdPrefix);
  const databaseMode: ResultsDatabaseMode = await chooseResultsDatabaseMode(promptIdPrefix);
  const selection = await selectFitTests(execution, SITUATIONAL_TEST_DOMAIN, promptIdPrefix);

  const currentInstance = lastSituationalInstance(state);
  if (currentInstance?.clusterlessSessions) {
    const generatedSession = buildFitSituationalDefinitionFrom({
      sdk,
      ...(version ? { version } : {}),
      onPortInUse,
      databaseMode,
      selection,
    }).instances[0]?.clusterlessSessions?.[0];
    if (!generatedSession) {
      throw new Error("Expected a generated situational definition to contain one clusterless session.");
    }
    currentInstance.clusterlessSessions.push(
      generatedSession,
    );
    return;
  }

  console.log("\nStarting a new FIT situational instance. FIT/SIT creates its own clusters.");
  const instance = await chooseInstanceExecution(promptIdPrefix);
  const generatedInstance = buildFitSituationalDefinitionFrom({
    sdk,
    instance,
    ...(version ? { version } : {}),
    onPortInUse,
    databaseMode,
    selection,
  }).instances[0];
  if (!generatedInstance) {
    throw new Error("Expected a generated situational definition to contain one instance.");
  }
  state.instances.push(generatedInstance);
}

export async function createFitDefinition(rootDir: string): Promise<RunOutput> {
  console.log(
    "\nThis builds a reusable fit definition file. Nothing is set up — no cluster is allocated, no performer built, no tests run.\n",
  );

  const state: DefinitionBuilderState = { gerritRefAsked: false, instances: [] };
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
  });

  const result = writeFitDefinition(definition);
  console.log(`\nWriting ${result.path}:\n`);
  printWithoutTimestamps(formatFitDefinition(definition));
  console.log(`\n✓ Wrote ${result.path}`);
  console.log(
    `\nRun it later with:\n` +
      `  npm run definition -- execute --interactive ${result.path}\n` +
      `\nOr non-interactively (e.g. on CI), taking the default answer to every prompt:\n` +
      `  npm run definition -- execute ${result.path}`,
  );

  return { artifacts: [result.artifact], details: [] };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    return createFitDefinition(rootDir);
  });
}
