/**
 * Build and write a reusable `fit-functional-tests` YAML definition file from
 * an interactive run's chosen inputs, so the run can be repeated later with
 * `npm run definition <file.yaml>`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { artifactFromPath, type Artifact, type RunOutput } from "../../../util/non-fit/artifacts.js";
import { ensureRunDir } from "../../../util/non-fit/replay.js";
import type { Sdk } from "../../../util/sdk/sdks.js";
import type { SelectedCluster } from "../../cluster/cluster-select/index.js";
import type { FitTestSelection } from "../../fit-shared/select-fit-tests/index.js";
import {
  CURRENT_FIT_FUNCTIONAL_VERSION,
  FIT_FUNCTIONAL_DEFINITION_TYPE,
  type FitFunctionalDefinition,
} from "./types.js";

/** Absolute path to the generated definition file in the current run directory. */
export function fitFunctionalDefinitionPath(runDir: string = ensureRunDir()): string {
  return join(runDir, "fit-functional-tests.yaml");
}

/** Build a definition object from the inputs chosen in the guided flow. */
export function buildFitFunctionalDefinition(
  sdk: Sdk,
  cluster: SelectedCluster,
  selection: FitTestSelection,
): FitFunctionalDefinition {
  return {
    version: CURRENT_FIT_FUNCTIONAL_VERSION,
    type: FIT_FUNCTIONAL_DEFINITION_TYPE,
    sdk: sdk.value,
    cluster: {
      connectionString: `${cluster.scheme}://${cluster.defaultHostname}`,
      username: cluster.credentials.username,
      password: cluster.credentials.password,
      tls: cluster.tls,
    },
    tests: selection.mavenTestSelector ? selection.selectedTests.map((test) => test.className) : "all",
  };
}

/** Render a definition file as YAML text ready to save. */
export function formatFitFunctionalDefinition(definition: FitFunctionalDefinition): string {
  return YAML.stringify(definition);
}

export interface WriteFitFunctionalDefinitionResult {
  path: string;
  artifact: Artifact;
}

/** Write a generated definition file into the current run directory. */
export function writeFitFunctionalDefinition(
  definition: FitFunctionalDefinition,
  runDir: string = ensureRunDir(),
): WriteFitFunctionalDefinitionResult {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const path = fitFunctionalDefinitionPath(runDir);
  writeFileSync(path, formatFitFunctionalDefinition(definition));
  return {
    path,
    artifact: artifactFromPath(path, "Generated fit-functional-tests definition file for reruns", runDir),
  };
}

/** Build, explain, and write a reusable fit-functional definition file. */
export function generateFitFunctionalDefinition(
  sdk: Sdk,
  cluster: SelectedCluster,
  selection: FitTestSelection,
): RunOutput & { path: string; definition: FitFunctionalDefinition } {
  const definition = buildFitFunctionalDefinition(sdk, cluster, selection);

  console.log(
    "\nGenerating a fit-functional-tests definition file so you can rerun this flow non-interactively or tweak it.",
  );
  const result = writeFitFunctionalDefinition(definition);

  console.log(`\nWriting ${result.path}:\n`);
  console.log(formatFitFunctionalDefinition(definition));
  console.log(`\n✓ Wrote ${result.path}`);

  return { path: result.path, definition, artifacts: [result.artifact], details: [] };
}
