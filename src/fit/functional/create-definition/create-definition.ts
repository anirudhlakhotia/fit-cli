/**
 * The "Create a FIT functional definition file" flow. This asks which cluster,
 * which performer version, and which tests to capture in a reusable
 * definition, but stands *nothing* up: no cluster is allocated, no performer is
 * built, no tests are run. It just captures the answers and writes a reusable
 * `fit.yaml` you can run later with
 * `npm run definition <file.yaml>` or hand-edit into a matrix of runs.
 *
 * Because it sets nothing up, the cluster question has two outcomes that mirror
 * the definition format directly: an existing cluster becomes `useExisting`
 * plus an iteration `fitConfig.clusterAccess` block, and "create one with
 * cbdinocluster" becomes a `cbdinocluster` block.
 *
 * Run this flow on its own (skipping the top-level menu; add --root <dir> to
 * point at another workspace):
 *   npx tsx src/fit/functional/create-definition/create-definition.ts
 */
import { type RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { printWithoutTimestamps } from "../../../util/non-fit/fit-cli-log.js";
import { confirm, input, qualifyPromptId } from "../../../util/non-fit/prompts.js";
import { rootDirFromArgv } from "../../util/root.js";
import { loadFitCliConfig, resolveOutputFormat } from "../../util/config.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import { askClusterDef } from "../../../cluster/cluster-create/ask-cluster-def.js";
import { askClusterExistsPolicy } from "../../../cluster/cluster-create/ask-cluster-exists-policy.js";
import { selectCluster } from "../../../cluster/cluster-select/cluster-select.js";
import { askVersion } from "../../performers/build-performer/ask-version.js";
import { askPortInUsePolicy } from "../../performers/util/ask-port-in-use-policy.js";
import { createLocalFitExecutionContext } from "../../shared/util/remote-fit-run.js";
import { selectFitTests } from "../../shared/select-fit-tests/select-fit-tests.js";
import {
  buildFitFunctionalDefinitionFrom,
  type DefinitionCluster,
  type DefinitionFormat,
  formatFitFunctionalDefinition,
  writeFitFunctionalDefinition,
} from "../../shared/definition/generate-definition.js";

/**
 * Ask which cluster the definition should target, without standing anything up.
 * Reuses the cluster-select prompts: an existing cluster yields the connection
 * details; "create with cbdinocluster" yields the desired cluster shape, which we
 * record as a `cbdinocluster` block rather than allocating now.
 */
export async function chooseDefinitionCluster(): Promise<DefinitionCluster> {
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

/**
 * Walk through the definition questions and write the resulting fit.json5.
 * Nothing is built, allocated, or run.
 */
export async function createFitFunctionalDefinition(rootDir: string, options?: { format?: DefinitionFormat }): Promise<RunOutput> {
  console.log(
    "\nThis builds a reusable fit definition file. Nothing is set up — " +
      "no cluster is allocated, no performer built, no tests run.\n",
  );

  const cluster = await chooseDefinitionCluster();
  // The cluster-exists policy only has a place in a cbdinocluster block; for an
  // existing-cluster (useExisting) definition there's nothing to recreate.
  const onClusterExists =
    cluster.kind === "cbdinocluster" ? await askClusterExistsPolicy() : undefined;
  const sdk = await chooseSdk();
  const version = await askVersion();
  const onPortInUse = await askPortInUsePolicy();

  // Listing tests needs the test-driver checkout; selectFitTests falls back to
  // "all" (with a warning) if it isn't present, which is fine here — we're only
  // recording the choice, not running anything.
  const selection = await selectFitTests(createLocalFitExecutionContext(rootDir));
  const gerritRef = await askFitGerritRef();

  const definition = buildFitFunctionalDefinitionFrom({
    cluster,
    sdk,
    ...(version ? { version } : {}),
    ...(gerritRef ? { gerritRef } : {}),
    ...(onClusterExists ? { onClusterExists } : {}),
    onPortInUse,
    selection,
    githubUser: loadFitCliConfig().config?.github?.user,
  });

  const outputFormat = options?.format ?? resolveOutputFormat();
  const result = writeFitFunctionalDefinition(definition, undefined, outputFormat);
  console.log(`\nWriting ${result.path}:\n`);
  printWithoutTimestamps(formatFitFunctionalDefinition(definition, outputFormat));
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
    return createFitFunctionalDefinition(rootDir);
  });
}
