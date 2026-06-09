/**
 * Build and write reusable `fit` YAML definition files.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { artifactFromPath, type Artifact, type RunOutput } from "../../../util/non-fit/artifacts.js";
import { printWithoutTimestamps } from "../../../util/non-fit/fit-cli-log.js";
import { ensureRunDir } from "../../../util/non-fit/replay.js";
import type { PieceData } from "../../../util/non-fit/config-pieces.js";
import type { Sdk } from "../../../util/sdk/sdks.js";
import { buildClusterDefObject, type ClusterDef } from "../../../cluster/cluster-create/build-cluster-def.js";
import {
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
  type FitConfigPiece,
  type FitDefinition,
  type InstanceLifetime,
  type InstanceMode,
  type SessionLifetime,
  type SituationalDatabaseMode,
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
 * Build the cbdinocluster init config for a definition. For CNG, includes the
 * k8s block (enabled + context — cao-tools and kubeconfig are CSP-dependent and
 * added at runtime) and optionally the github block (token added at runtime).
 */
function buildCbdinoclusterInitConfig(cng: boolean, githubUser?: string): PieceData {
  const base = defaultCbdinoclusterInitConfig();
  if (!cng) {
    return githubUser ? { ...base, github: { enabled: "true", user: githubUser } } : base;
  }
  return {
    ...base,
    // cao-tools and kubeconfig paths are added at runtime (CSP-dependent).
    k8s: { enabled: "true", context: CNG_K3D_CONTEXT },
    ...(githubUser ? { github: { enabled: "true", user: githubUser } } : {}),
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

function buildFunctionalInstance(inputs: DefinitionInputs): InstanceLifetime {
  const cng = inputs.cluster.kind === "cbdinocluster" && inputs.cluster.def.cng;
  return {
    ...(inputs.instance ?? { localhost: {} }),
    clusters: [
      {
        ...(inputs.cluster.kind === "connection"
          ? {
              connection: {
                connectionString: `${inputs.cluster.cluster.scheme}://${inputs.cluster.cluster.defaultHostname}`,
                username: inputs.cluster.cluster.credentials.username,
                password: inputs.cluster.cluster.credentials.password,
                tls: inputs.cluster.cluster.tls,
              },
            }
          : {
              cbdinocluster: {
                init: { config: buildCbdinoclusterInitConfig(cng, inputs.githubUser) },
                config: buildClusterDefObject(inputs.cluster.def),
                ...(inputs.onClusterExists ? { onClusterExists: inputs.onClusterExists } : {}),
              },
            }),
        sessions: [
          {
            ...buildPerformerSession(inputs.sdk, inputs.version, inputs.onPortInUse),
            runs: [
              {
                type: "functional",
                fitConfig: inputs.cluster.kind === "connection"
                  ? buildClusterAccessFitConfig(inputs.cluster.cluster)
                  : buildCbdinoclusterFitConfig(cng),
                tests: buildTests(inputs.selection),
              },
            ],
          },
        ],
      },
    ],
  };
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
}): FitDefinition {
  const setup = inputs.gerritRef
    ? { repos: { "transactions-fit-performer": { gerritRef: inputs.gerritRef } } }
    : undefined;
  return {
    version: CURRENT_FIT_DEFINITION_VERSION,
    type: FIT_DEFINITION_TYPE,
    ...(setup ? { setup } : {}),
    instances: [...inputs.instances],
  };
}

export function buildFitFunctionalDefinitionFrom(inputs: DefinitionInputs): FitDefinition {
  return buildFitDefinition({
    ...(inputs.gerritRef ? { gerritRef: inputs.gerritRef } : {}),
    instances: [buildFunctionalInstance(inputs)],
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

export function formatFitDefinition(definition: FitDefinition): string {
  let text = YAML.stringify(definition);
  text = text.replace(/(^\s*init:\n)(\s*)config:$/gm, (_match, initLine: string, indent: string) =>
    `${initLine}${indent}# This file will be uploaded verbatim into clean environments as ~/.cbdinocluster\n${indent}config:`
  );
  text = text.replace(
    /^(\s*)(-\s+)?fitConfig:$/gm,
    [
      "$1# This will be used as a base when generating FITConfiguration.json.  Anything here will be copied into the config (unless overwritten by fit-cli).",
      "$1# fit-cli will provide some fields like \\${defaultHostname} at runtime when cluster details are known.",
      "$1$2fitConfig:",
    ].join("\n"),
  );
  return text;
}

export function formatFitSituationalDefinition(definition: FitDefinition): string {
  let text = formatFitDefinition(definition);
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

export function writeFitSituationalDefinition(
  definition: FitDefinition,
  runDir: string = ensureRunDir(),
): WriteFitFunctionalDefinitionResult {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const path = fitDefinitionPath(runDir);
  writeFileSync(path, formatFitSituationalDefinition(definition));
  return {
    path,
    artifact: artifactFromPath(path, "Generated fit definition file for reruns", runDir),
  };
}

export function generateFitFunctionalDefinition(
  sdk: Sdk,
  cluster: SelectedCluster,
  selection: FitTestSelection,
): RunOutput & { path: string; definition: FitDefinition } {
  const definition = buildFitFunctionalDefinition(sdk, cluster, selection);

  console.log("\nGenerating a fit definition file so you can rerun this flow non-interactively or tweak it.");
  const result = writeFitDefinition(definition);

  console.log(`\nWriting ${result.path}:\n`);
  printWithoutTimestamps(formatFitDefinition(definition));
  console.log(`\n✓ Wrote ${result.path}`);

  return { path: result.path, definition, artifacts: [result.artifact], details: [] };
}
