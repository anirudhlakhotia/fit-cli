/**
 * Build and write reusable `fit` definition files (JSON5 by default, YAML optional).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import YAML from "yaml";
import { artifactFromPath, type Artifact, type RunOutput } from "../../../util/non-fit/artifacts.js";
import { printWithoutTimestamps } from "../../../util/non-fit/fit-cli-log.js";
import { ensureRunDir } from "../../../util/non-fit/replay.js";
import type { PieceData } from "../../../util/non-fit/config-pieces.js";
import type { Sdk } from "../../../util/sdk/sdks.js";
import { buildClusterDefObject, type ClusterDef } from "../../../cluster/cluster-create/build-cluster-def.js";
import {
  defaultCbdinoclusterInitArgs,
  defaultCbdinoclusterInitConfig,
  defaultSituationalCbdinoclusterInitConfig,
} from "../../../cluster/cluster-create/default-cbdinocluster-init-config.js";
import { CNG_K3D_CONTEXT } from "../../../cluster/cluster-create/cng-kubernetes.js";
import type { ClusterExistsPolicy } from "../../../cluster/cluster-create/cluster-exists-policy.js";
import { DEFAULT_CREDENTIALS } from "../../../cluster/cluster-select/ask-credentials.js";
import type { SelectedCluster } from "../../../cluster/cluster-select/cluster-select.js";
import type { PortInUsePolicy } from "../../performers/util/performer-port.js";
import type { FitTestSelection } from "../select-fit-tests/select-fit-tests.js";
import {
  CURRENT_FIT_DEFINITION_VERSION,
  FIT_DEFINITION_TYPE,
  type CbdinoclusterInitSetup,
  type ClusterConfigRef,
  type FitConfigPiece,
  type FitConfigRef,
  type FitDefinition,
  type InstanceLifetime,
  type InstanceMode,
  type SessionLifetime,
  type SituationalDatabaseMode,
} from "./types.js";

const CLUSTER_CONFIG_ID = "cluster-0";
const FIT_CONFIG_ID = "fit-config-0";

export type DefinitionFormat = "json5" | "yaml";

export function fitDefinitionPath(runDir: string = ensureRunDir(), format: DefinitionFormat = "json5"): string {
  return join(runDir, format === "yaml" ? "fit.yaml" : "fit.json5");
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
  instance?: InstanceMode;
  /** GitHub username for the cbdinocluster github section (needed for GHCR pulls). */
  githubUser?: string;
}

export interface SituationalDefinitionInputs {
  sdk: Sdk;
  version?: string;
  gerritRef?: string;
  onPortInUse?: PortInUsePolicy;
  selection: FitTestSelection;
  databaseMode: SituationalDatabaseMode;
  instance?: InstanceMode;
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

/**
 * Build a fitConfig template for a cbdinocluster-based cluster.  The cluster
 * IPs are not known at definition time, so ${defaultHostname} is used as a
 * placeholder — fit-cli fills in defaultHostname and rest.hostname at runtime
 * via the runtime config piece.
 */
function buildCbdinoclusterFitConfig(cng: boolean): FitConfigPiece {
  if (cng) {
    return {
      clusterAccess: {
        driver: {
          connectionString: "couchbase://${defaultHostname}",
          tls: null,
        },
        performer: {
          connectionString: "couchbase2://${defaultHostname}",
          tls: null,
        },
        username: DEFAULT_CREDENTIALS.username,
        password: DEFAULT_CREDENTIALS.password,
        rest: {
          hostname: "${defaultHostname}",
          resolveDnsSrv: false,
        },
        proxy: null,
      },
      excludeTests: ["situational"],
    };
  }
  return {
    clusterAccess: {
      connectionString: "couchbase://${defaultHostname}",
      username: DEFAULT_CREDENTIALS.username,
      password: DEFAULT_CREDENTIALS.password,
      tls: null,
      rest: {
        hostname: "${defaultHostname}",
        resolveDnsSrv: false,
      },
      proxy: {
        hostname: "host.docker.internal",
      },
    },
    excludeTests: ["situational"],
  };
}

/**
 * Build the cbdinocluster init setup for a definition.
 *
 * The docker path carries an editable `cbdinocluster init` args string; fit-cli
 * appends the GitHub credentials at runtime, so `githubUser` isn't baked in here.
 *
 * CNG still carries a `config` object uploaded as `~/.cbdinocluster`: it includes
 * the k8s block (enabled + context — cao-tools and kubeconfig are CSP-dependent
 * and added at runtime) and optionally the github block (token added at runtime).
 */
function buildCbdinoclusterInit(cng: boolean, githubUser?: string): CbdinoclusterInitSetup {
  if (!cng) {
    return { args: defaultCbdinoclusterInitArgs() };
  }
  const base = defaultCbdinoclusterInitConfig();
  return {
    config: {
      ...base,
      // cao-tools and kubeconfig paths are added at runtime (CSP-dependent).
      k8s: { enabled: "true", context: CNG_K3D_CONTEXT },
      ...(githubUser ? { github: { enabled: "true", user: githubUser } } : {}),
    },
  };
}

function buildTests(selection: FitTestSelection) {
  return {
    run: selection.mavenTestSelector
      ? selection.selectedTests.map((test) => test.className)
      : "all",
  } as const;
}

function buildPerformerSession(
  sdk: Sdk,
  version: string | undefined,
  onPortInUse: PortInUsePolicy | undefined,
): Omit<SessionLifetime, "runs"> {
  return {
    performer: {
      sdk: sdk.value,
      ...(version ? { version } : {}),
      ...(onPortInUse ? { onPortInUse } : {}),
    },
  };
}

interface BuiltFunctionalInstance {
  instance: InstanceLifetime;
  clusterConfigRef: ClusterConfigRef;
  fitConfigRef: FitConfigRef;
}

function buildFunctionalInstance(inputs: DefinitionInputs): BuiltFunctionalInstance {
  const cng = inputs.cluster.kind === "cbdinocluster" && inputs.cluster.def.cng;
  const clusterConfigRef: ClusterConfigRef = inputs.cluster.kind === "connection"
    ? {
        id: CLUSTER_CONFIG_ID,
        connection: {
          connectionString: `${inputs.cluster.cluster.scheme}://${inputs.cluster.cluster.defaultHostname}`,
          username: inputs.cluster.cluster.credentials.username,
          password: inputs.cluster.cluster.credentials.password,
          tls: inputs.cluster.cluster.tls,
        },
      }
    : {
        id: CLUSTER_CONFIG_ID,
        cbdinocluster: {
          init: buildCbdinoclusterInit(cng, inputs.githubUser),
          config: buildClusterDefObject(inputs.cluster.def),
          ...(inputs.onClusterExists ? { onClusterExists: inputs.onClusterExists } : {}),
        },
      };
  const fitConfigRef: FitConfigRef = {
    id: FIT_CONFIG_ID,
    config: inputs.cluster.kind === "connection"
      ? buildClusterAccessFitConfig(inputs.cluster.cluster)
      : buildCbdinoclusterFitConfig(cng),
  };
  const instance: InstanceLifetime = {
    ...(inputs.instance ?? { localhost: {} }),
    clusters: [
      {
        clusterConfig: CLUSTER_CONFIG_ID,
        sessions: [
          {
            ...buildPerformerSession(inputs.sdk, inputs.version, inputs.onPortInUse),
            runs: [
              {
                type: "functional",
                fitConfig: FIT_CONFIG_ID,
                tests: buildTests(inputs.selection),
              },
            ],
          },
        ],
      },
    ],
  };
  return { instance, clusterConfigRef, fitConfigRef };
}

function buildSituationalInstance(inputs: SituationalDefinitionInputs): InstanceLifetime {
  return {
    ...(inputs.instance ?? { localhost: {} }),
    clusters: [],
    cbdinocluster: { init: { config: defaultSituationalCbdinoclusterInitConfig() } },
    clusterlessSessions: [
      {
        ...buildPerformerSession(inputs.sdk, inputs.version, inputs.onPortInUse),
        runs: [
          {
            type: "situational",
            tests: buildTests(inputs.selection),
            situational: {
              database: { mode: inputs.databaseMode },
            },
          },
        ],
      },
    ],
  };
}

export function buildFitDefinition(inputs: {
  gerritRef?: string;
  instances: InstanceLifetime[];
  clusterConfigs?: ClusterConfigRef[];
  fitConfigs?: FitConfigRef[];
}): FitDefinition {
  const setup = inputs.gerritRef
    ? { repos: { "transactions-fit-performer": { gerritRef: inputs.gerritRef } } }
    : undefined;
  return {
    version: CURRENT_FIT_DEFINITION_VERSION,
    type: FIT_DEFINITION_TYPE,
    ...(setup ? { setup } : {}),
    instances: [...inputs.instances],
    ...(inputs.clusterConfigs?.length ? { clusterConfigs: inputs.clusterConfigs } : {}),
    ...(inputs.fitConfigs?.length ? { fitConfigs: inputs.fitConfigs } : {}),
  };
}

export function buildFitFunctionalDefinitionFrom(inputs: DefinitionInputs): FitDefinition {
  const { instance, clusterConfigRef, fitConfigRef } = buildFunctionalInstance(inputs);
  return buildFitDefinition({
    ...(inputs.gerritRef ? { gerritRef: inputs.gerritRef } : {}),
    instances: [instance],
    clusterConfigs: [clusterConfigRef],
    fitConfigs: [fitConfigRef],
  });
}

export function buildFitSituationalDefinitionFrom(inputs: SituationalDefinitionInputs): FitDefinition {
  return buildFitDefinition({
    ...(inputs.gerritRef ? { gerritRef: inputs.gerritRef } : {}),
    instances: [buildSituationalInstance(inputs)],
  });
}

export function buildFitFunctionalDefinition(
  sdk: Sdk,
  cluster: SelectedCluster,
  selection: FitTestSelection,
): FitDefinition {
  return buildFitFunctionalDefinitionFrom({ cluster: { kind: "connection", cluster }, sdk, selection });
}

function formatFitDefinitionYaml(definition: FitDefinition): string {
  let text = YAML.stringify(definition);
  text = text.replace(/(^\s*init:\n)(\s*)config:$/gm, (_match, initLine: string, indent: string) =>
    `${initLine}${indent}# This file will be uploaded verbatim into clean environments as ~/.cbdinocluster\n${indent}config:`
  );
  text = text.replace(/(^\s*init:\n)(\s*)args:/gm, (_match, initLine: string, indent: string) =>
    `${initLine}${indent}# Passed to \`cbdinocluster init\` on clean environments to set up ~/.cbdinocluster.\n${indent}# Edit to taste; fit-cli appends your GitHub credentials at runtime.\n${indent}args:`
  );
  text = text.replace(
    /^fitConfigs:$/gm,
    [
      "# Each fitConfig is used as a base when generating FITConfiguration.json.  Anything here will be copied into the config (unless overwritten by fit-cli).",
      "# fit-cli will provide some fields like ${defaultHostname} at runtime when cluster details are known.",
      "fitConfigs:",
    ].join("\n"),
  );
  return text;
}

function formatFitSituationalDefinitionYaml(definition: FitDefinition): string {
  let text = formatFitDefinitionYaml(definition);
  text = text.replace(
    /^(\s*)clusters: \[\]$/gm,
    "$1# FIT/SIT creates its own clusters, so none are set up here.\n$1clusters: []",
  );
  text = text.replace(
    /^(\s*)cbdinocluster:\n(\s+)init:/gm,
    "$1# FIT/SIT creates its own clusters via cbdinocluster; this init config must be present.\n$1cbdinocluster:\n$2init:",
  );
  text = text.replace(
    /^(\s*)clusterlessSessions:$/gm,
    "$1# Sessions not tied to any particular cluster (the name distinguishes these from sessions nested under clusters:)\n$1clusterlessSessions:",
  );
  return text;
}

function formatFitDefinitionJson5(definition: FitDefinition): string {
  let text = JSON5.stringify(definition, null, 2);
  // Insert comment before `config:` inside every `init: {` block
  text = text.replace(/^(\s*)(init: \{)\n(\s*)(config:)/gm, (_, ind1: string, initBrace: string, ind2: string, configKey: string) =>
    `${ind1}${initBrace}\n${ind2}// This file will be uploaded verbatim into clean environments as ~/.cbdinocluster\n${ind2}${configKey}`,
  );
  // Insert comment before `args:` inside every `init: {` block (the docker path)
  text = text.replace(/^(\s*)(init: \{)\n(\s*)(args:)/gm, (_, ind1: string, initBrace: string, ind2: string, argsKey: string) =>
    `${ind1}${initBrace}\n${ind2}// Passed to \`cbdinocluster init\` on clean environments to set up ~/.cbdinocluster.\n${ind2}// Edit to taste; fit-cli appends your GitHub credentials at runtime.\n${ind2}${argsKey}`,
  );
  // Insert comments before `fitConfigs:`
  text = text.replace(/^(\s*)(fitConfigs: \[)/gm, (_match: string, ind: string, fitConfigsKey: string) =>
    `${ind}// Each fitConfig is used as a base when generating FITConfiguration.json.  Anything here will be copied into the config (unless overwritten by fit-cli).\n${ind}// fit-cli will provide some fields like \${defaultHostname} at runtime when cluster details are known.\n${ind}${fitConfigsKey}`,
  );
  if (!text.endsWith("\n")) text += "\n";
  return text;
}

function formatFitSituationalDefinitionJson5(definition: FitDefinition): string {
  let text = formatFitDefinitionJson5(definition);
  text = text.replace(/^(\s*)(clusters: \[\],?)$/gm, (_match: string, ind: string, clustersKey: string) =>
    `${ind}// FIT/SIT creates its own clusters, so none are set up here.\n${ind}${clustersKey}`,
  );
  text = text.replace(/^(\s*)(cbdinocluster: \{)\n(\s*)(init:)/gm, (_match: string, ind1: string, cbdBrace: string, ind2: string, initKey: string) =>
    `${ind1}// FIT/SIT creates its own clusters via cbdinocluster; this init config must be present.\n${ind1}${cbdBrace}\n${ind2}${initKey}`,
  );
  text = text.replace(/^(\s*)(clusterlessSessions: \[)/gm, (_match: string, ind: string, clKey: string) =>
    `${ind}// Sessions not tied to any particular cluster (the name distinguishes these from sessions nested under clusters:)\n${ind}${clKey}`,
  );
  return text;
}

export function formatFitDefinition(definition: FitDefinition, format: DefinitionFormat = "json5"): string {
  return format === "yaml" ? formatFitDefinitionYaml(definition) : formatFitDefinitionJson5(definition);
}

export function formatFitSituationalDefinition(definition: FitDefinition, format: DefinitionFormat = "json5"): string {
  return format === "yaml" ? formatFitSituationalDefinitionYaml(definition) : formatFitSituationalDefinitionJson5(definition);
}

export function formatFitFunctionalDefinition(definition: FitDefinition, format: DefinitionFormat = "json5"): string {
  return formatFitDefinition(definition, format);
}

export interface WriteFitFunctionalDefinitionResult {
  path: string;
  artifact: Artifact;
}

export function writeFitDefinition(
  definition: FitDefinition,
  runDir: string = ensureRunDir(),
  format: DefinitionFormat = "json5",
): WriteFitFunctionalDefinitionResult {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const path = fitDefinitionPath(runDir, format);
  writeFileSync(path, formatFitDefinition(definition, format));
  return {
    path,
    artifact: artifactFromPath(path, "Generated fit definition file for reruns", runDir),
  };
}

export const writeFitFunctionalDefinition = writeFitDefinition;

export function writeFitSituationalDefinition(
  definition: FitDefinition,
  runDir: string = ensureRunDir(),
  format: DefinitionFormat = "json5",
): WriteFitFunctionalDefinitionResult {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const path = fitDefinitionPath(runDir, format);
  writeFileSync(path, formatFitSituationalDefinition(definition, format));
  return {
    path,
    artifact: artifactFromPath(path, "Generated fit definition file for reruns", runDir),
  };
}

export function generateFitFunctionalDefinition(
  sdk: Sdk,
  cluster: SelectedCluster,
  selection: FitTestSelection,
  format: DefinitionFormat = "json5",
): RunOutput & { path: string; definition: FitDefinition } {
  const definition = buildFitFunctionalDefinition(sdk, cluster, selection);

  console.log("\nGenerating a fit definition file so you can rerun this flow non-interactively or tweak it.");
  const result = writeFitDefinition(definition, undefined, format);

  console.log(`\nWriting ${result.path}:\n`);
  printWithoutTimestamps(formatFitDefinition(definition, format));
  console.log(`\n✓ Wrote ${result.path}`);

  return { path: result.path, definition, artifacts: [result.artifact], details: [] };
}
