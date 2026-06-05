/**
 * Turn a validated `fit` definition into concrete functional run inputs.
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import type { PieceData } from "../../../util/non-fit/config-pieces.js";
import { classifyConnectionString } from "../../cluster/cluster-select/classify-connection-string.js";
import type { SelectedCluster } from "../../cluster/cluster-select/index.js";
import {
  DEFAULT_PERFORMER_PORT,
  DEFAULT_PORT_IN_USE_POLICY,
  type PortInUsePolicy,
} from "../../performers/performer-port.js";
import { SDKS, sdkByValue, type Sdk } from "../../../util/sdk/sdks.js";
import { DEFAULT_MAVEN_TEST_ARGS } from "../../fit-shared/run-test-driver/index.js";
import {
  buildDefaultFitTestSelection,
  buildFitTestSelectionFromClassNames,
  type FitTestSelection,
} from "../../fit-shared/select-fit-tests/index.js";
import {
  DEFAULT_CLUSTER_EXISTS_POLICY,
  type ClusterExistsPolicy,
} from "../../cluster/cluster-create/cluster-exists-policy.js";
import type { CbdinoclusterDef } from "../../cluster/cluster-create/build-cluster-def.js";
import { loadDefinition } from "./parse-definition.js";
import type {
  ClusterSetup,
  ConnectionClusterSetup,
  FitDefinition,
  FunctionalIteration,
  RuntimeSection,
} from "./types.js";

/** One iteration's worth of concrete inputs, ready to drive the workflow. */
export interface ResolvedIteration {
  type: "functional";
  sdk: Sdk;
  /** FITConfiguration artifact-piece supplied by the definition for this iteration. */
  fitConfig?: PieceData;
  /** The existing cluster resolved from shared setup.cluster.connection or fitConfig.clusterAccess. */
  cluster?: SelectedCluster;
  /** Port the performer should listen on (defaults to {@link DEFAULT_PERFORMER_PORT}). */
  performerPort: number;
  testSelection: FitTestSelection;
  /** Performer image version, if the iteration pinned one. */
  performerVersion?: string;
  /** What to do if the performer port is already in use (defaults to {@link DEFAULT_PORT_IN_USE_POLICY}). */
  onPortInUse: PortInUsePolicy;
  /** Extra `./mvnw` args (the excludedGroups flag). */
  extraMavenArgs: string[];
}

/** A cbdinocluster to allocate at setup-cluster time, with its defaults filled in. */
export interface ResolvedCbdinocluster {
  /** Optional full ~/.cbdinocluster file to upload before remote setup. */
  init?: {
    config: PieceData;
  };
  /** The cbdinocluster def to allocate (what gets written to the def file). */
  config: CbdinoclusterDef;
  /** What to do if cbdinocluster already has a cluster running. */
  onClusterExists: ClusterExistsPolicy;
  /** cbdinocluster deployer override, if the file set one. */
  deployer?: string;
}

/** A whole definition resolved: cluster setup mode plus the per-iteration inputs. */
export interface ResolvedDefinition {
  /** Which top-level cluster mode this definition selected, if any. */
  clusterMode?: "connection" | "useExisting" | "cbdinocluster";
  /** FIT Gerrit patch-set ref to fetch before building/running, if configured. */
  fitPerformerGerritRef?: string;
  /**
   * A cbdinocluster to allocate for the run (setup.cluster.cbdinocluster). The
   * setup-cluster step stands it up and the resulting cluster is what the
   * iterations test against.
   */
  cbdinocluster?: ResolvedCbdinocluster;
  iterations: ResolvedIteration[];
}

/** Map a runtime section's `tests` field to a {@link FitTestSelection}. */
function resolveTestSelection(runtime: RuntimeSection): FitTestSelection {
  return runtime.tests === "all"
    ? buildDefaultFitTestSelection()
    : buildFitTestSelectionFromClassNames(runtime.tests);
}

/** Turn a runtime section's optional excludedGroups into `./mvnw` args. */
export function resolveMavenArgs(runtime: RuntimeSection): string[] {
  if (runtime.excludedGroups === undefined) {
    return [...DEFAULT_MAVEN_TEST_ARGS];
  }
  return [`-DexcludedGroups=${runtime.excludedGroups.join(",")}`];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${path} must be a mapping.`);
  }
  return value;
}

function requireString(record: Record<string, unknown>, key: string, path: string): string {
  if (typeof record[key] !== "string") {
    throw new Error(`${path} must be a string.`);
  }
  return record[key];
}

function resolveFitConfigTls(value: unknown, path: string): SelectedCluster["tls"] {
  if (value === undefined || value === null) {
    return null;
  }
  const record = requireRecord(value, path);
  if (record.insecure === true) {
    return { insecure: true };
  }
  if (typeof record.certPath === "string") {
    return { certPath: record.certPath };
  }
  throw new Error(`${path} must be null, { insecure: true }, or { certPath: <path> }.`);
}

function resolveClusterConnectionRecord(
  clusterAccess: Record<string, unknown>,
  path: string,
): SelectedCluster {
  const connectionString = requireString(clusterAccess, "connectionString", `${path}.connectionString`);
  const classification = classifyConnectionString(connectionString);
  if (classification.kind !== "supported") {
    throw new Error(
      `${path}.connectionString "${connectionString}" is not one fit-cli can use (${classification.kind}). ` +
        "Use a couchbase:// or couchbases:// connection string.",
    );
  }
  return {
    scheme: classification.scheme,
    defaultHostname: classification.defaultHostname,
    flavour: classification.flavour,
    credentials: {
      username: requireString(clusterAccess, "username", `${path}.username`),
      password: requireString(clusterAccess, "password", `${path}.password`),
    },
    tls: resolveFitConfigTls(clusterAccess.tls, `${path}.tls`),
  };
}

/** Resolve a shared setup.cluster.connection block into a {@link SelectedCluster}. */
export function resolveConnectionCluster(connection: ConnectionClusterSetup | undefined): SelectedCluster | undefined {
  if (!connection) {
    return undefined;
  }
  return resolveClusterConnectionRecord({ ...connection }, "setup.cluster.connection");
}

/** Resolve one iteration's fitConfig clusterAccess block into a {@link SelectedCluster}. */
export function resolveFitConfigCluster(fitConfig: PieceData | undefined): SelectedCluster | undefined {
  if (!fitConfig) {
    return undefined;
  }
  const clusterAccess = requireRecord(fitConfig.clusterAccess, "iterations[].fitConfig.clusterAccess");
  return resolveClusterConnectionRecord(clusterAccess, "iterations[].fitConfig.clusterAccess");
}

function stripFitConfigClusterAccess(fitConfig: PieceData | undefined): PieceData | undefined {
  if (!fitConfig || !("clusterAccess" in fitConfig)) {
    return fitConfig;
  }
  const rest = { ...fitConfig };
  delete rest.clusterAccess;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/** Resolve the shared cluster's cbdinocluster block, filling in defaults. */
export function resolveCbdinocluster(
  clusterSetup: ClusterSetup | undefined,
): ResolvedCbdinocluster | undefined {
  const cbdinocluster = clusterSetup?.cbdinocluster;
  if (!cbdinocluster) {
    return undefined;
  }
  return {
    config: cbdinocluster.config,
    onClusterExists: cbdinocluster.onClusterExists ?? DEFAULT_CLUSTER_EXISTS_POLICY,
    ...(cbdinocluster.init !== undefined ? { init: { config: cbdinocluster.init.config } } : {}),
    ...(cbdinocluster.deployer !== undefined ? { deployer: cbdinocluster.deployer } : {}),
  };
}

/** Resolve a single iteration into its concrete run inputs. */
export function resolveIteration(iteration: FunctionalIteration): ResolvedIteration {
  const sdk = sdkByValue(iteration.setup.performer.sdk);
  if (!sdk) {
    throw new Error(
      `Unknown sdk "${iteration.setup.performer.sdk}". Valid values: ${SDKS.map((s) => s.value).join(", ")}.`,
    );
  }

  return {
    type: "functional",
    sdk,
    ...(iteration.fitConfig !== undefined ? { fitConfig: iteration.fitConfig } : {}),
    performerPort: iteration.setup.performer.port ?? DEFAULT_PERFORMER_PORT,
    testSelection: resolveTestSelection(iteration.runtime),
    ...(iteration.setup.performer.version !== undefined
      ? { performerVersion: iteration.setup.performer.version }
      : {}),
    onPortInUse: iteration.setup.performer.onPortInUse ?? DEFAULT_PORT_IN_USE_POLICY,
    extraMavenArgs: resolveMavenArgs(iteration.runtime),
  };
}

/** Resolve a whole definition: the shared cluster and every iteration. */
export function resolveDefinition(definition: FitDefinition): ResolvedDefinition {
  const clusterSetup = definition.setup?.cluster;
  const connection = resolveConnectionCluster(clusterSetup?.connection);
  const cbdinocluster = resolveCbdinocluster(clusterSetup);
  const useExisting = clusterSetup?.useExisting !== undefined;
  return {
    ...(connection ? { clusterMode: "connection" as const } : {}),
    ...(useExisting ? { clusterMode: "useExisting" as const } : {}),
    ...(cbdinocluster ? { clusterMode: "cbdinocluster" as const } : {}),
    ...(definition.setup?.repos?.["transactions-fit-performer"]?.gerritRef !== undefined
      ? { fitPerformerGerritRef: definition.setup.repos["transactions-fit-performer"].gerritRef }
      : {}),
    ...(cbdinocluster ? { cbdinocluster } : {}),
    iterations: definition.iterations.map((iteration) => {
      const resolved = resolveIteration(iteration);
      if (connection) {
        const fitConfig = stripFitConfigClusterAccess(resolved.fitConfig);
        return {
          ...resolved,
          ...(fitConfig !== undefined ? { fitConfig } : {}),
          cluster: connection,
        };
      }
      if (!useExisting) {
        return resolved;
      }
      if (!resolved.fitConfig) {
        throw new Error(
          "setup.cluster.useExisting requires each iteration to define fitConfig.clusterAccess.",
        );
      }
      return {
        ...resolved,
        cluster: resolveFitConfigCluster(resolved.fitConfig),
      };
    }),
  };
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const path = process.argv[2];
    if (!path) {
      console.error("Usage: tsx src/workflows/fit-functional/definition/resolve-definition.ts <file.yaml>");
      process.exit(2);
    }
    console.log(JSON.stringify(resolveDefinition(loadDefinition(path)), null, 2));
    return Promise.resolve();
  });
}
