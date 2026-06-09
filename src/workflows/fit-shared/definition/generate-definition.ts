/**
 * Build and write reusable `fit` YAML definition files.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { artifactFromPath, type Artifact, type RunOutput } from "../../../util/non-fit/artifacts.js";
import { printWithoutTimestamps } from "../../../util/non-fit/fit-cli-log.js";
import { ensureRunDir } from "../../../util/non-fit/replay.js";
import type { Sdk } from "../../../util/sdk/sdks.js";
import type { PieceData } from "../../../util/non-fit/config-pieces.js";
import { buildClusterDefObject, type ClusterDef } from "../../cluster/cluster-create/build-cluster-def.js";
import { defaultCbdinoclusterInitConfig, defaultSituationalCbdinoclusterInitConfig } from "../../cluster/cluster-create/default-cbdinocluster-init-config.js";
import type { ClusterExistsPolicy } from "../../cluster/cluster-create/cluster-exists-policy.js";
import type { PortInUsePolicy } from "../../performers/util/performer-port.js";
import type { SelectedCluster } from "../../cluster/cluster-select/cluster-select.js";
import type { FitTestSelection } from "../../fit-shared/select-fit-tests/select-fit-tests.js";
import {
  CURRENT_FIT_DEFINITION_VERSION,
  FIT_DEFINITION_TYPE,
  type CycleInstanceSetup,
  type FitCycle,
  type FitDefinition,
  type FitConfigPiece,
  type FunctionalCycle,
  type FunctionalIteration,
  type PerformerSetup,
  type SituationalCycle,
  type SituationalDatabaseMode,
  type SituationalIteration,
} from "./types.js";

export function fitDefinitionPath(runDir: string = ensureRunDir()): string {
  return join(runDir, "fit.yaml");
}

export const fitFunctionalDefinitionPath = fitDefinitionPath;

export type DefinitionCluster =
  | { kind: "connection"; cluster: SelectedCluster }
  | { kind: "cbdinocluster"; def: ClusterDef };

export interface DefinitionInputs {
  cluster: DefinitionCluster;
  sdk: Sdk;
  version?: string;
  gerritRef?: string;
  onClusterExists?: ClusterExistsPolicy;
  onPortInUse?: PortInUsePolicy;
  selection: FitTestSelection;
  /** Where the cycle runs. Omitted ⇒ no `execution` block (localhost at run time). */
  instance?: CycleInstanceSetup;
}

export interface SituationalDefinitionInputs {
  sdk: Sdk;
  version?: string;
  onPortInUse?: PortInUsePolicy;
  selection: FitTestSelection;
  databaseMode: SituationalDatabaseMode;
  /** Where the cycle runs. Omitted ⇒ no `execution` block (localhost at run time). */
  instance?: CycleInstanceSetup;
}

function buildClusterAccessFitConfig(cluster: SelectedCluster): FitConfigPiece {
  const fitConfig: PieceData = {
    clusterAccess: {
      connectionString: `${cluster.scheme}://${cluster.defaultHostname}`,
      username: cluster.credentials.username,
      password: cluster.credentials.password,
      tls: cluster.tls,
    },
  };
  return fitConfig;
}

function buildFunctionalCycleCluster(
  cluster: DefinitionCluster,
  onClusterExists?: ClusterExistsPolicy,
): FunctionalCycle["cluster"] {
  return cluster.kind === "connection"
    ? { useExisting: {} }
    : {
        cbdinocluster: {
          init: { config: defaultCbdinoclusterInitConfig() },
          config: buildClusterDefObject(cluster.def),
          ...(onClusterExists ? { onClusterExists } : {}),
        },
      };
}

function buildRuntime(selection: FitTestSelection): FunctionalIteration["runtime"] {
  return {
    tests: selection.mavenTestSelector
      ? selection.selectedTests.map((test) => test.className)
      : "all",
  };
}

export function buildFunctionalIterationFrom(inputs: DefinitionInputs): FunctionalIteration {
  const performer: PerformerSetup = {
    sdk: inputs.sdk.value,
    ...(inputs.version ? { version: inputs.version } : {}),
    ...(inputs.onPortInUse ? { onPortInUse: inputs.onPortInUse } : {}),
  };
  const fitConfig = inputs.cluster.kind === "connection"
    ? buildClusterAccessFitConfig(inputs.cluster.cluster)
    : undefined;
  return {
    ...(fitConfig !== undefined ? { fitConfig } : {}),
    setup: { performer },
    runtime: buildRuntime(inputs.selection),
  };
}

export function buildSituationalIterationFrom(inputs: SituationalDefinitionInputs): SituationalIteration {
  return {
    setup: {
      performer: {
        sdk: inputs.sdk.value,
        ...(inputs.version ? { version: inputs.version } : {}),
        ...(inputs.onPortInUse ? { onPortInUse: inputs.onPortInUse } : {}),
      },
    },
    situational: {
      database: { mode: inputs.databaseMode },
    },
    runtime: buildRuntime(inputs.selection),
  };
}

export function buildFunctionalCycleFrom(inputs: DefinitionInputs & { iterations?: FunctionalIteration[] }): FunctionalCycle {
  return {
    type: "functional",
    ...(inputs.instance ? { execution: { instance: inputs.instance } } : {}),
    cluster: buildFunctionalCycleCluster(inputs.cluster, inputs.onClusterExists),
    iterations: inputs.iterations ?? [buildFunctionalIterationFrom(inputs)],
  };
}

export function buildSituationalCycleFrom(inputs: SituationalDefinitionInputs & { iterations?: SituationalIteration[] }): SituationalCycle {
  return {
    type: "situational",
    ...(inputs.instance ? { execution: { instance: inputs.instance } } : {}),
    cbdinocluster: { init: { config: defaultSituationalCbdinoclusterInitConfig() } },
    iterations: inputs.iterations ?? [buildSituationalIterationFrom(inputs)],
  };
}

export function buildFitDefinition(inputs: {
  gerritRef?: string;
  cycles: FitCycle[];
}): FitDefinition {
  const setup = inputs.gerritRef
    ? { repos: { "transactions-fit-performer": { gerritRef: inputs.gerritRef } } }
    : undefined;
  return {
    version: CURRENT_FIT_DEFINITION_VERSION,
    type: FIT_DEFINITION_TYPE,
    ...(setup ? { setup } : {}),
    cycles: [...inputs.cycles],
  };
}

export function buildFitFunctionalDefinitionFrom(inputs: DefinitionInputs): FitDefinition {
  return buildFitDefinition({
    ...(inputs.gerritRef ? { gerritRef: inputs.gerritRef } : {}),
    cycles: [buildFunctionalCycleFrom(inputs)],
  });
}

export function buildFitFunctionalDefinition(
  sdk: Sdk,
  cluster: SelectedCluster,
  selection: FitTestSelection,
): FitDefinition {
  return buildFitFunctionalDefinitionFrom({ cluster: { kind: "connection", cluster }, sdk, selection });
}

export function formatFitDefinition(definition: FitDefinition): string {
  let text = YAML.stringify(definition);
  text = text.replace(/(^\s*init:\n)(\s*)config:$/gm, (_match, initLine: string, indent: string) =>
    `${initLine}${indent}# This file will be uploaded verbatim into clean environments as ~/.cbdinocluster\n${indent}config:`
  );
  text = text.replace(
    /^(\s*)(-\s+)?fitConfig:$/gm,
    [
      "$1# This will be used as a base when generating FITConfiguration.json.  Anything here will be copied into the config (unless overwritten by fit-cli)",
      "$1$2fitConfig:",
    ].join("\n"),
  );
  return text;
}

export const formatFitFunctionalDefinition = formatFitDefinition;

export interface WriteFitFunctionalDefinitionResult {
  path: string;
  artifact: Artifact;
}

export function writeFitDefinition(
  definition: FitDefinition,
  runDir: string = ensureRunDir(),
): WriteFitFunctionalDefinitionResult {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const path = fitDefinitionPath(runDir);
  writeFileSync(path, formatFitDefinition(definition));
  return {
    path,
    artifact: artifactFromPath(path, "Generated fit definition file for reruns", runDir),
  };
}

export const writeFitFunctionalDefinition = writeFitDefinition;

export function generateFitFunctionalDefinition(
  sdk: Sdk,
  cluster: SelectedCluster,
  selection: FitTestSelection,
): RunOutput & { path: string; definition: FitDefinition } {
  const definition = buildFitFunctionalDefinition(sdk, cluster, selection);

  console.log(
    "\nGenerating a fit definition file so you can rerun this flow non-interactively or tweak it.",
  );
  const result = writeFitDefinition(definition);

  console.log(`\nWriting ${result.path}:\n`);
  printWithoutTimestamps(formatFitDefinition(definition));
  console.log(`\n✓ Wrote ${result.path}`);

  return { path: result.path, definition, artifacts: [result.artifact], details: [] };
}
