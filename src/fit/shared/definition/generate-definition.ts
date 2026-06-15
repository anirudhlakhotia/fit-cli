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
  situationalCbdinoclusterConfigPatch,
  situationalCbdinoclusterInitArgs,
} from "../../../cluster/cluster-create/default-cbdinocluster-init-config.js";
import { CNG_K3D_CONTEXT } from "../../../cluster/cluster-create/cng-kubernetes.js";
import type { ClusterExistsPolicy } from "../../../cluster/cluster-create/cluster-exists-policy.js";
import { DEFAULT_CREDENTIALS } from "../../../cluster/cluster-select/ask-credentials.js";
import type { SelectedCluster } from "../../../cluster/cluster-select/cluster-select.js";
import { DEFAULT_CBDINO_SETTINGS } from "../../situational/configuration/build-situational-configuration.js";
import { localDatabaseConnection } from "../../situational/setup-local-database/setup-local-database.js";
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
  type TestsSection,
} from "./types.js";
import { describeDefinition } from "./generate-desc.js";

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
    bucketConfig: {
      numReplicas: 1,
      bucketType: "couchbase",
      storage: "couchstore",
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

function buildTests(selection: FitTestSelection): TestsSection {
  if (selection.presets?.length) {
    return {
      presets: selection.presets,
      ...(selection.extraClasses?.length ? { classes: selection.extraClasses } : {}),
    };
  }
  if (selection.selectedPackages?.length) {
    return { packages: selection.selectedPackages };
  }
  if (selection.mavenTestSelector) {
    return { classes: selection.selectedTests.map((test) => test.className) };
  }
  return { presets: ["all"] };
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
    // cbdinocluster init is set up once per instance — see InstanceSetup. Only
    // cbdinocluster-backed clusters need it; connection clusters bring their own.
    ...(inputs.cluster.kind === "cbdinocluster"
      ? { setup: { cbdinocluster: { init: buildCbdinoclusterInit(cng, inputs.githubUser) } } }
      : {}),
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

function buildSituationalFitConfig(databaseMode: SituationalDatabaseMode): FitConfigPiece {
  return {
    clusterAccess: {
      defaultHostname: "localhost",
      username: DEFAULT_CREDENTIALS.username,
      password: DEFAULT_CREDENTIALS.password,
    },
    excludeTests: [],
    situational: {
      cbdino: {
        version: DEFAULT_CBDINO_SETTINGS.version,
        cbDinoClusterAppPath: DEFAULT_CBDINO_SETTINGS.cbDinoClusterAppPath,
        enablePrivateEndpoint: DEFAULT_CBDINO_SETTINGS.enablePrivateEndpoint,
      },
      ...(databaseMode === "local"
        ? (({ jdbc, username, password }) => ({ database: { jdbc, username, password } }))(localDatabaseConnection())
        : {}),
    },
  };
}

function buildSituationalInstance(inputs: SituationalDefinitionInputs): InstanceLifetime {
  return {
    ...(inputs.instance ?? { localhost: {} }),
    // Situational runs `cbdinocluster init` for the docker/github base (like the
    // functional path), then merges the capella/aws blocks init can't express.
    // It's per-instance setup, applied once on the box (see InstanceSetup).
    setup: {
      cbdinocluster: {
        init: { args: situationalCbdinoclusterInitArgs(), configPatch: situationalCbdinoclusterConfigPatch() },
      },
    },
    clusters: [],
    clusterlessSessions: [
      {
        ...buildPerformerSession(inputs.sdk, inputs.version, inputs.onPortInUse),
        runs: [
          {
            type: "situational",
            fitConfig: FIT_CONFIG_ID,
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
  const base: FitDefinition = {
    version: CURRENT_FIT_DEFINITION_VERSION,
    type: FIT_DEFINITION_TYPE,
    ...(setup ? { setup } : {}),
    instances: [...inputs.instances],
    ...(inputs.clusterConfigs?.length ? { clusterConfigs: inputs.clusterConfigs } : {}),
    ...(inputs.fitConfigs?.length ? { fitConfigs: inputs.fitConfigs } : {}),
  };
  return {
    version: base.version,
    type: base.type,
    description: describeDefinition(base),
    ...(base.setup ? { setup: base.setup } : {}),
    instances: base.instances,
    ...(base.clusterConfigs ? { clusterConfigs: base.clusterConfigs } : {}),
    ...(base.fitConfigs ? { fitConfigs: base.fitConfigs } : {}),
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
  const fitConfigRef: FitConfigRef = {
    id: FIT_CONFIG_ID,
    config: buildSituationalFitConfig(inputs.databaseMode),
  };
  return buildFitDefinition({
    ...(inputs.gerritRef ? { gerritRef: inputs.gerritRef } : {}),
    instances: [buildSituationalInstance(inputs)],
    fitConfigs: [fitConfigRef],
  });
}

export function buildFitFunctionalDefinition(
  sdk: Sdk,
  cluster: SelectedCluster,
  selection: FitTestSelection,
): FitDefinition {
  return buildFitFunctionalDefinitionFrom({ cluster: { kind: "connection", cluster }, sdk, selection });
}

// ── Comment injection ────────────────────────────────────────────────────────
// Rather than splice comments into the rendered text with line-anchored regexes
// (brittle, and blind to shape changes), we decorate a copy of the definition
// with marker keys — "//<6 chars>": "comment text" — placed immediately before
// the field they annotate, render it, then turn each marker line into a real
// comment. Keying off field names instead of line patterns keeps the comments
// attached to the right fields no matter how the serializer lays them out.

let commentMarkerSeq = 0;

/** A unique six-character marker key; renders just before its sibling field. */
function commentMarkerKey(): string {
  const id = (commentMarkerSeq++).toString(36).padStart(6, "0").slice(-6);
  return `//${id}`;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The short comment line(s) to splice in immediately before `key`, given its
 * value and the key of the object it sits in. As a general rule, anything fit-cli
 * fills in at runtime gets a one-line note so a reader knows it'll be provided
 * later rather than being missing.
 */
function commentLinesFor(key: string, value: unknown, parentKey: string | undefined): string[] {
  switch (key) {
    case "config":
      return parentKey === "init"
        ? ["This file will be uploaded verbatim into clean environments as ~/.cbdinocluster"]
        : [];
    case "args":
      return parentKey === "init"
        ? [
            "Passed to `cbdinocluster init` on clean environments to set up ~/.cbdinocluster.  Added at runtime: GitHub creds",
          ]
        : [];
    case "configPatch":
      return parentKey === "init"
        ? ["Merged onto ~/.cbdinocluster after `cbdinocluster init` runs — for config init can't set via flags (e.g. capella/aws)."]
        : [];
    case "bucketConfig":
      return ["numReplicas >= 1 is required for FTS tests to pass."];
    case "fitConfigs":
      return [
        "Each fitConfig is used as a base when generating FITConfiguration.json.  Anything here will be copied into the config (unless overwritten by fit-cli).",
        "fit-cli will provide some fields like ${defaultHostname} at runtime when cluster details are known.",
      ];
    case "setup":
      return [];
    case "clusters":
      return parentKey === "instances" && Array.isArray(value) && value.length === 0
        ? ["FIT/SIT creates its own clusters, so none are set up here."]
        : [];
    case "clusterlessSessions":
      return ["Sessions not tied to any particular cluster (the name distinguishes these from sessions nested under clusters:)"];
    case "clusterAccess":
      if (isJsonObject(value) && JSON.stringify(value).includes("${defaultHostname}")) {
        return ["fit-cli fills ${defaultHostname} (and rest.hostname) in at runtime once the cluster is up."];
      }
      if (isJsonObject(value) && "defaultHostname" in value) {
        return ["Ignored for situational-only runs — cbdino creates and manages the cluster."];
      }
      return [];
    case "excludeTests":
      return Array.isArray(value) && value.length === 0
        ? ["fit-cli will inject performerPorts at runtime."]
        : [];
    default:
      return [];
  }
}

/** Deep-copy a definition, inserting comment markers before annotated fields. */
function decorateWithCommentMarkers(node: unknown, parentKey?: string): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => decorateWithCommentMarkers(item, parentKey));
  }
  if (!isJsonObject(node)) {
    return node;
  }
  const result: JsonObject = {};
  for (const [key, rawValue] of Object.entries(node)) {
    for (const line of commentLinesFor(key, rawValue, parentKey)) {
      result[commentMarkerKey()] = line;
    }
    result[key] = decorateWithCommentMarkers(rawValue, key);
  }
  return result;
}

// A marker key, single- or double-quoted (JSON5 may use either).
const MARKER_KEY = `(?:"\\/\\/[0-9a-z]{6}"|'\\/\\/[0-9a-z]{6}')`;
// A single- or double-quoted string value.
const QUOTED_VALUE = `(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`;

/** Turn `'//xxxxxx': 'text'` marker lines into `// text` comments (JSON5). */
function renderCommentMarkersJson5(text: string): string {
  const pattern = new RegExp(`^([ \\t]*)${MARKER_KEY}:[ \\t]*(${QUOTED_VALUE}),?[ \\t]*$`, "gm");
  return text.replace(pattern, (_match, indent: string, quoted: string) => `${indent}// ${String(JSON5.parse(quoted))}`);
}

/** Turn `//xxxxxx: text` marker lines into `# text` comments (YAML). */
function renderCommentMarkersYaml(text: string): string {
  const pattern = new RegExp(`^([ \\t]*)(?:${MARKER_KEY}|\\/\\/[0-9a-z]{6}):[ \\t]*(.*)$`, "gm");
  return text.replace(pattern, (_match, indent: string, rawValue: string) => {
    let comment = rawValue;
    try {
      const parsed = YAML.parse(rawValue) as unknown;
      if (typeof parsed === "string") comment = parsed;
    } catch {
      // Keep the raw value if it doesn't parse as a scalar.
    }
    return `${indent}# ${comment}`;
  });
}

export function formatFitDefinition(definition: FitDefinition, format: DefinitionFormat = "json5"): string {
  const decorated = decorateWithCommentMarkers(definition);
  if (format === "yaml") {
    // lineWidth: 0 disables scalar wrapping so each comment marker stays on one line.
    return renderCommentMarkersYaml(YAML.stringify(decorated, { lineWidth: 0 }));
  }
  let text = renderCommentMarkersJson5(JSON5.stringify(decorated, null, 2));
  if (!text.endsWith("\n")) text += "\n";
  return text;
}

/** Situational definitions render through the same key-driven comment logic. */
export function formatFitSituationalDefinition(definition: FitDefinition, format: DefinitionFormat = "json5"): string {
  return formatFitDefinition(definition, format);
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
