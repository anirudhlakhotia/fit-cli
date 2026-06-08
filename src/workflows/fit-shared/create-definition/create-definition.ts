/**
 * Build a reusable `fit` definition file interactively, letting the user mix
 * functional and situational iterations into one YAML file.
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
import type { ClusterExistsPolicy } from "../../cluster/cluster-create/cluster-exists-policy.js";
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
  buildFunctionalIterationFrom,
  buildSituationalIterationFrom,
  formatFitDefinition,
  type DefinitionCluster,
  writeFitDefinition,
} from "../definition/generate-definition.js";
import type { FitIteration } from "../definition/types.js";
import {
  FUNCTIONAL_TEST_DOMAIN,
  SITUATIONAL_TEST_DOMAIN,
  selectFitTests,
} from "../select-fit-tests/select-fit-tests.js";
import { createLocalFitExecutionContext } from "../util/remote-fit-run.js";

type DefinitionBuilderAction = "functional" | "situational" | "performance" | "done";

interface SharedDefinitionState {
  gerritRefAsked: boolean;
  gerritRef?: string;
  functionalCluster?: DefinitionCluster;
  onClusterExists?: ClusterExistsPolicy;
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

async function ensureSharedRepoSetup(state: SharedDefinitionState): Promise<void> {
  if (state.gerritRefAsked) {
    return;
  }
  state.gerritRef = await askFitGerritRef("fit.definition.shared");
  state.gerritRefAsked = true;
}

async function ensureFunctionalSharedSetup(state: SharedDefinitionState): Promise<void> {
  await ensureSharedRepoSetup(state);
  if (state.functionalCluster) {
    return;
  }

  console.log(
    "\nFIT functional iterations share one top-level cluster setup in the definition, so fit-cli will ask for it once and reuse it.",
  );
  state.functionalCluster = await chooseDefinitionCluster();
  state.onClusterExists =
    state.functionalCluster.kind === "cbdinocluster" ? await askClusterExistsPolicy() : undefined;
}

async function addFunctionalIteration(
  rootDir: string,
  state: SharedDefinitionState,
  iterationIndex: number,
) {
  await ensureFunctionalSharedSetup(state);
  const promptIdPrefix = `fit.definition.iteration.${iterationIndex + 1}.functional`;
  const execution = createLocalFitExecutionContext(rootDir);
  const sdk = await chooseSdk("Which SDK do you want to test with FIT functional?", promptIdPrefix);
  const version = await askVersion(promptIdPrefix);
  const onPortInUse = await askPortInUsePolicy(promptIdPrefix);
  const selection = await selectFitTests(execution, FUNCTIONAL_TEST_DOMAIN, promptIdPrefix);

  return buildFunctionalIterationFrom({
    cluster: state.functionalCluster!,
    sdk,
    ...(version ? { version } : {}),
    onPortInUse,
    selection,
  });
}

async function addSituationalIteration(
  rootDir: string,
  state: SharedDefinitionState,
  iterationIndex: number,
) {
  await ensureSharedRepoSetup(state);
  const promptIdPrefix = `fit.definition.iteration.${iterationIndex + 1}.situational`;
  const execution = createLocalFitExecutionContext(rootDir);
  const sdk = await chooseSdk("Which SDK do you want to test with FIT situational?", promptIdPrefix);
  const version = await askVersion(promptIdPrefix);
  const onPortInUse = await askPortInUsePolicy(promptIdPrefix);
  const databaseMode: ResultsDatabaseMode = await chooseResultsDatabaseMode(promptIdPrefix);
  const selection = await selectFitTests(execution, SITUATIONAL_TEST_DOMAIN, promptIdPrefix);

  console.log(
    "\nUsing the default cbdino settings for this situational iteration. You can edit fit.yaml later if you need specific cbdino overrides.",
  );

  return buildSituationalIterationFrom({
    sdk,
    ...(version ? { version } : {}),
    onPortInUse,
    databaseMode,
    selection,
  });
}

export async function createFitDefinition(rootDir: string): Promise<RunOutput> {
  console.log(
    "\nThis builds a reusable fit definition file. Nothing is set up — " +
      "no cluster is allocated, no performer built, no tests run.\n",
  );

  const iterations: FitIteration[] = [];
  const state: SharedDefinitionState = { gerritRefAsked: false };
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

    const iterationIndex = iterations.length;
    const iteration =
      action === "functional"
        ? await addFunctionalIteration(rootDir, state, iterationIndex)
        : await addSituationalIteration(rootDir, state, iterationIndex);
    iterations.push(iteration);
  }

  if (iterations.length === 0) {
    console.log("\nNo FIT testing was added, so no definition file was written.");
    return { artifacts: [], details: [] };
  }

  const definition = buildFitDefinition({
    ...(state.functionalCluster ? { cluster: state.functionalCluster } : {}),
    ...(state.gerritRef ? { gerritRef: state.gerritRef } : {}),
    ...(state.onClusterExists ? { onClusterExists: state.onClusterExists } : {}),
    iterations,
  });

  const result = writeFitDefinition(definition);
  console.log(`\nWriting ${result.path}:\n`);
  printWithoutTimestamps(formatFitDefinition(definition));
  console.log(`\n✓ Wrote ${result.path}`);
  console.log(`\nRun it later with:\n  
  npm run definition -- --interactive ${result.path}\n
  Or if on CI choose default options with:\n
  npm run definition ${result.path}`);

  return { artifacts: [result.artifact], details: [] };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    return createFitDefinition(rootDir);
  });
}
