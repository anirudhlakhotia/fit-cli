/**
 * Build a reusable `fit` definition file interactively, letting the user build
 * one or more cycles.
 *
 * Run this flow on its own (skipping the top-level menu; add --root <dir> to
 * point at another workspace):
 *   npx tsx src/workflows/fit-shared/create-definition/create-definition.ts
 */
import { type RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { printWithoutTimestamps } from "../../../util/non-fit/fit-cli-log.js";
import { qualifyPromptId, select } from "../../../util/non-fit/prompts.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
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
  buildFunctionalCycleFrom,
  buildFunctionalIterationFrom,
  buildSituationalCycleFrom,
  buildSituationalIterationFrom,
  formatFitDefinition,
  type DefinitionCluster,
  writeFitDefinition,
} from "../definition/generate-definition.js";
import type { CycleInstanceSetup, FitCycle, FunctionalCycle } from "../definition/types.js";
import {
  FUNCTIONAL_TEST_DOMAIN,
  SITUATIONAL_TEST_DOMAIN,
  selectFitTests,
} from "../select-fit-tests/select-fit-tests.js";
import { createLocalFitExecutionContext } from "../util/remote-fit-run.js";

type DefinitionBuilderAction = "functional" | "situational" | "performance" | "done";

interface DefinitionBuilderState {
  gerritRefAsked: boolean;
  gerritRef?: string;
  cycles: FitCycle[];
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
  });
}

/**
 * Ask where a brand-new cycle's tests should execute. Only asked when a cycle is
 * first started — every iteration added to that cycle then shares the choice. At
 * run time the user can still override and force everything onto localhost.
 */
async function chooseCycleExecution(promptIdPrefix: string): Promise<CycleInstanceSetup> {
  const choice = await select<"localhost" | "aws">({
    promptId: qualifyPromptId("execution.instance", promptIdPrefix),
    message: "Where should this cycle's tests execute?",
    choices: [
      { name: "This machine (localhost)", value: "localhost" },
      { name: "A clean AWS EC2 instance", value: "aws" },
    ],
  });
  console.log(
    "  You can override this and run everything on localhost when you execute the definition.",
  );
  return choice === "aws" ? { aws: {} } : { localhost: {} };
}

async function ensureSharedRepoSetup(state: DefinitionBuilderState): Promise<void> {
  if (state.gerritRefAsked) {
    return;
  }
  state.gerritRef = await askFitGerritRef("fit.definition.shared");
  state.gerritRefAsked = true;
}

function currentCycleOfType<T extends FitCycle["type"]>(
  state: DefinitionBuilderState,
  type: T,
): Extract<FitCycle, { type: T }> | undefined {
  const last = state.cycles.at(-1);
  return last?.type === type ? (last as Extract<FitCycle, { type: T }>) : undefined;
}

async function addFunctionalIteration(
  rootDir: string,
  state: DefinitionBuilderState,
  iterationIndex: number,
): Promise<void> {
  await ensureSharedRepoSetup(state);
  const promptIdPrefix = `fit.definition.iteration.${iterationIndex + 1}.functional`;
  const execution = createLocalFitExecutionContext(rootDir);
  const sdk = await chooseSdk("Which SDK do you want to test with FIT functional?", promptIdPrefix);
  const version = await askVersion(promptIdPrefix);
  const onPortInUse = await askPortInUsePolicy(promptIdPrefix);
  const selection = await selectFitTests(execution, FUNCTIONAL_TEST_DOMAIN, promptIdPrefix);

  const currentCycle = currentCycleOfType(state, "functional");
  if (currentCycle) {
    currentCycle.iterations.push(
      buildFunctionalIterationFrom({
        cluster: functionalCycleCluster(currentCycle),
        sdk,
        ...(version ? { version } : {}),
        onPortInUse,
        selection,
      }),
    );
    return;
  }

  console.log(
    "\nStarting a new FIT functional cycle. This cycle owns one cluster lifetime, and every functional iteration you add now will share it.",
  );
  const instance = await chooseCycleExecution(promptIdPrefix);
  const cluster = await chooseDefinitionCluster();
  const onClusterExists = cluster.kind === "cbdinocluster" ? await askClusterExistsPolicy() : undefined;
  state.cycles.push(
    buildFunctionalCycleFrom({
      cluster,
      instance,
      ...(onClusterExists ? { onClusterExists } : {}),
      sdk,
      ...(version ? { version } : {}),
      onPortInUse,
      selection,
    }),
  );
}

function functionalCycleCluster(cycle: FunctionalCycle): DefinitionCluster {
  if (cycle.cluster.cbdinocluster) {
    const firstNode = cycle.cluster.cbdinocluster.config.nodes[0];
    if (!firstNode) {
      throw new Error("Functional cycle cbdinocluster config must contain at least one node.");
    }
    return {
      kind: "cbdinocluster",
      def: {
        nodeCount: firstNode.count,
        version: firstNode.version,
        services: firstNode.services,
        cng: cycle.cluster.cbdinocluster.config.cao !== undefined,
      },
    };
  }
  const access = cycleClusterAccess(cycle);
  return {
    kind: "connection",
    cluster: {
      ...access,
      flavour: "self-managed",
    },
  };
}

function cycleClusterAccess(cycle: FunctionalCycle) {
  const first = cycle.iterations.find((iteration) => iteration.fitConfig?.clusterAccess !== undefined);
  const clusterAccess = first?.fitConfig?.clusterAccess;
  if (!clusterAccess || typeof clusterAccess !== "object" || Array.isArray(clusterAccess)) {
    throw new Error("Functional useExisting cycles need clusterAccess in at least one iteration.");
  }
  const record = clusterAccess as {
    connectionString?: string;
    username?: string;
    password?: string;
    tls?: unknown;
  };
  const connectionString = String(record.connectionString ?? "couchbase://localhost");
  const [scheme, defaultHostname] = connectionString.split("://");
  const resolvedScheme: "couchbase" | "couchbases" = scheme === "couchbases" ? "couchbases" : "couchbase";
  return {
    scheme: resolvedScheme,
    defaultHostname: defaultHostname ?? "localhost",
    credentials: {
      username: String(record.username ?? "Administrator"),
      password: String(record.password ?? "password"),
    },
    tls: record.tls === undefined ? null : (record.tls as null | { insecure: true } | { certPath: string }),
  };
}

async function addSituationalIteration(
  rootDir: string,
  state: DefinitionBuilderState,
  iterationIndex: number,
): Promise<void> {
  await ensureSharedRepoSetup(state);
  const promptIdPrefix = `fit.definition.iteration.${iterationIndex + 1}.situational`;
  const execution = createLocalFitExecutionContext(rootDir);
  const sdk = await chooseSdk("Which SDK do you want to test with FIT situational?", promptIdPrefix);
  const version = await askVersion(promptIdPrefix);
  const onPortInUse = await askPortInUsePolicy(promptIdPrefix);
  const databaseMode: ResultsDatabaseMode = await chooseResultsDatabaseMode(promptIdPrefix);
  const selection = await selectFitTests(execution, SITUATIONAL_TEST_DOMAIN, promptIdPrefix);

  const currentCycle = currentCycleOfType(state, "situational");
  if (currentCycle) {
    currentCycle.iterations.push(
      buildSituationalIterationFrom({
        sdk,
        ...(version ? { version } : {}),
        onPortInUse,
        databaseMode,
        selection,
      }),
    );
    return;
  }

  console.log(
    "\nStarting a new FIT situational cycle. Situational cycles do not carry a shared cluster because FIT/SIT creates its own.",
  );
  const instance = await chooseCycleExecution(promptIdPrefix);
  state.cycles.push(
    buildSituationalCycleFrom({
      sdk,
      instance,
      ...(version ? { version } : {}),
      onPortInUse,
      databaseMode,
      selection,
    }),
  );
}

function iterationCount(state: DefinitionBuilderState): number {
  return state.cycles.reduce((total, cycle) => total + cycle.iterations.length, 0);
}

export async function createFitDefinition(rootDir: string): Promise<RunOutput> {
  console.log(
    "\nThis builds a reusable fit definition file. Nothing is set up — " +
      "no cluster is allocated, no performer built, no tests run.\n",
  );

  const state: DefinitionBuilderState = { gerritRefAsked: false, cycles: [] };
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

    const nextIterationIndex = iterationCount(state);
    if (action === "functional") {
      await addFunctionalIteration(rootDir, state, nextIterationIndex);
    } else {
      await addSituationalIteration(rootDir, state, nextIterationIndex);
    }
  }

  if (state.cycles.length === 0) {
    console.log("\nNo FIT testing was added, so no definition file was written.");
    return { artifacts: [], details: [] };
  }

  const definition = buildFitDefinition({
    ...(state.gerritRef ? { gerritRef: state.gerritRef } : {}),
    cycles: state.cycles,
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
