/**
 * Build and write a reusable `fit` YAML definition file from an interactive
 * functional run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { artifactFromPath, type Artifact, type RunOutput } from "../../../util/non-fit/artifacts.js";
import { ensureRunDir } from "../../../util/non-fit/replay.js";
import type { Sdk } from "../../../util/sdk/sdks.js";
import type { PieceData } from "../../../util/non-fit/config-pieces.js";
import { buildClusterDefObject, type ClusterDef } from "../../cluster/cluster-create/build-cluster-def.js";
import { defaultCbdinoclusterInitConfig } from "../../cluster/cluster-create/default-cbdinocluster-init-config.js";
import type { SelectedCluster } from "../../cluster/cluster-select/index.js";
import type { FitTestSelection } from "../../fit-shared/select-fit-tests/index.js";
import {
  CURRENT_FIT_DEFINITION_VERSION,
  FIT_DEFINITION_TYPE,
  type FitDefinition,
  type FitConfigPiece,
  type PerformerSetup,
} from "./types.js";

/** Absolute path to the generated definition file in the current run directory. */
export function fitFunctionalDefinitionPath(runDir: string = ensureRunDir()): string {
  return join(runDir, "fit.yaml");
}

/**
 * How the definition's shared cluster is described: either point at an existing
 * running cluster (stored as `useExisting` plus iteration `fitConfig.clusterAccess`),
 * or describe a cbdinocluster to allocate later (a `cbdinocluster` block). The
 * create-definition flow lets the user pick either without standing anything up;
 * the guided flow always has a live cluster in hand and so always uses
 * `useExisting`.
 */
export type DefinitionCluster =
  | { kind: "connection"; cluster: SelectedCluster }
  | { kind: "cbdinocluster"; def: ClusterDef };

/** The full set of choices that describe one fit-functional definition. */
export interface DefinitionInputs {
  cluster: DefinitionCluster;
  sdk: Sdk;
  /** Performer image version/tag; omit for the build's default (main). */
  version?: string;
  /** Optional FIT Gerrit patch-set ref to fetch before building/running. */
  gerritRef?: string;
  selection: FitTestSelection;
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

/** Build the top-level shared setup from the chosen cluster description. */
function buildSharedSetup(cluster: DefinitionCluster, gerritRef?: string): FitDefinition["setup"] {
  const setup: NonNullable<FitDefinition["setup"]> = cluster.kind === "connection"
    ? { cluster: { useExisting: {} } }
    : {
        cluster: {
          cbdinocluster: {
            init: { config: defaultCbdinoclusterInitConfig() },
            config: buildClusterDefObject(cluster.def),
          },
        },
      };
  if (gerritRef) {
    setup.repos = { "transactions-fit-performer": { gerritRef } };
  }
  return setup;
}

/**
 * Build a definition object from a full set of chosen inputs. We emit a single
 * iteration; a file can carry several on input to describe a matrix of runs, but
 * the interactive flows only ever capture the one just walked through.
 */
export function buildFitFunctionalDefinitionFrom(inputs: DefinitionInputs): FitDefinition {
  const performer: PerformerSetup = {
    sdk: inputs.sdk.value,
    ...(inputs.version ? { version: inputs.version } : {}),
  };
  const fitConfig = inputs.cluster.kind === "connection"
    ? buildClusterAccessFitConfig(inputs.cluster.cluster)
    : undefined;
  return {
    version: CURRENT_FIT_DEFINITION_VERSION,
    type: FIT_DEFINITION_TYPE,
    setup: buildSharedSetup(inputs.cluster, inputs.gerritRef),
    iterations: [
      {
        type: "functional",
        ...(fitConfig !== undefined ? { fitConfig } : {}),
        setup: { performer },
        runtime: {
          tests: inputs.selection.mavenTestSelector
            ? inputs.selection.selectedTests.map((test) => test.className)
            : "all",
        },
      },
    ],
  };
}

/**
 * Build a definition object from the inputs chosen in the guided flow, where a
 * live cluster has already been selected. A thin wrapper over
 * {@link buildFitFunctionalDefinitionFrom} for the always-existing-cluster case.
 */
export function buildFitFunctionalDefinition(
  sdk: Sdk,
  cluster: SelectedCluster,
  selection: FitTestSelection,
): FitDefinition {
  return buildFitFunctionalDefinitionFrom({ cluster: { kind: "connection", cluster }, sdk, selection });
}

/** Render a definition file as YAML text ready to save. */
export function formatFitFunctionalDefinition(definition: FitDefinition): string {
  let text = YAML.stringify(definition);
  text = text.replace(/(^\s*init:\n)(\s*)config:$/gm, (_match, initLine: string, indent: string) =>
    `${initLine}${indent}# This file will be uploaded verbatim into clean environments as ~/.cbdinocluster$\n${indent}It comes from defaultCbdinoclusterInitConfig()\n${indent}config:`
  );
  text = text.replace(
    /^(\s*)fitConfig:$/gm,
    [
      "$1# This will be used as a base when generating FITConfiguration.json.  Anything here will be copied into the config (unless overwritten by fit-cli)",
      "$1fitConfig:",
    ].join("\n"),
  );
  return text;
}

export interface WriteFitFunctionalDefinitionResult {
  path: string;
  artifact: Artifact;
}

/** Write a generated definition file into the current run directory. */
export function writeFitFunctionalDefinition(
  definition: FitDefinition,
  runDir: string = ensureRunDir(),
): WriteFitFunctionalDefinitionResult {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const path = fitFunctionalDefinitionPath(runDir);
  writeFileSync(path, formatFitFunctionalDefinition(definition));
  return {
    path,
    artifact: artifactFromPath(path, "Generated fit definition file for reruns", runDir),
  };
}

/** Build, explain, and write a reusable fit definition file. */
export function generateFitFunctionalDefinition(
  sdk: Sdk,
  cluster: SelectedCluster,
  selection: FitTestSelection,
): RunOutput & { path: string; definition: FitDefinition } {
  const definition = buildFitFunctionalDefinition(sdk, cluster, selection);

  console.log(
    "\nGenerating a fit definition file so you can rerun this flow non-interactively or tweak it.",
  );
  const result = writeFitFunctionalDefinition(definition);

  console.log(`\nWriting ${result.path}:\n`);
  console.log(formatFitFunctionalDefinition(definition));
  console.log(`\n✓ Wrote ${result.path}`);

  return { path: result.path, definition, artifacts: [result.artifact], details: [] };
}
