/**
 * Turn a validated `fit` definition into concrete run inputs.
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import type { PieceData } from "../../../util/non-fit/config-pieces.js";
import { classifyConnectionString } from "../../cluster/cluster-select/classify-connection-string.js";
import type { SelectedCluster } from "../../cluster/cluster-select/cluster-select.js";
import {
  DEFAULT_PERFORMER_PORT,
  DEFAULT_PORT_IN_USE_POLICY,
  type PortInUsePolicy,
} from "../../performers/util/performer-port.js";
import { SDKS, sdkByValue, type Sdk } from "../../../util/sdk/sdks.js";
import {
  DEFAULT_MAVEN_TEST_ARGS,
  SITUATIONAL_MAVEN_GROUPS_ARG,
  SITUATIONAL_MAVEN_TEST_ARGS,
} from "../../fit-shared/run-test-driver/run-test-driver.js";
import {
  buildDefaultFitTestSelection,
  buildFitTestSelectionFromClassNames,
  type FitTestSelection,
} from "../../fit-shared/select-fit-tests/select-fit-tests.js";
import {
  DEFAULT_CLUSTER_EXISTS_POLICY,
  type ClusterExistsPolicy,
} from "../../cluster/cluster-create/cluster-exists-policy.js";
import type { CbdinoclusterDef } from "../../cluster/cluster-create/build-cluster-def.js";
import { loadDefinition } from "./parse-definition.js";
import type {
  ClusterSetup,
  ConnectionClusterSetup,
  FitCycle,
  FitDefinition,
  FunctionalIteration,
  RuntimeSection,
  SituationalDatabaseMode,
  SituationalIteration,
} from "./types.js";

export interface ResolvedIterationCommon {
  sdk: Sdk;
  fitConfig?: PieceData;
  performerPort: number;
  testSelection: FitTestSelection;
  performerVersion?: string;
  onPortInUse: PortInUsePolicy;
  extraMavenArgs: string[];
}

export interface ResolvedFunctionalIteration extends ResolvedIterationCommon {
  type: "functional";
  cluster?: SelectedCluster;
}

export interface ResolvedSituationalIteration extends ResolvedIterationCommon {
  type: "situational";
  databaseMode: SituationalDatabaseMode;
}

export type ResolvedIteration = ResolvedFunctionalIteration | ResolvedSituationalIteration;

export interface ResolvedCbdinocluster {
  init?: {
    config: PieceData;
  };
  config: CbdinoclusterDef;
  onClusterExists: ClusterExistsPolicy;
  deployer?: string;
}

export interface ResolvedFunctionalCycle {
  type: "functional";
  clusterMode: "connection" | "useExisting" | "cbdinocluster";
  cbdinocluster?: ResolvedCbdinocluster;
  iterations: ResolvedFunctionalIteration[];
}

export interface ResolvedSituationalCycle {
  type: "situational";
  iterations: ResolvedSituationalIteration[];
}

export type ResolvedCycle = ResolvedFunctionalCycle | ResolvedSituationalCycle;

export interface ResolvedDefinition {
  fitPerformerGerritRef?: string;
  cycles: ResolvedCycle[];
}

function resolveTestSelection(runtime: RuntimeSection): FitTestSelection {
  return runtime.tests === "all"
    ? buildDefaultFitTestSelection()
    : buildFitTestSelectionFromClassNames(runtime.tests);
}

export function resolveMavenArgs(runtime: RuntimeSection): string[] {
  if (runtime.excludedGroups === undefined) {
    return [...DEFAULT_MAVEN_TEST_ARGS];
  }
  return [`-DexcludedGroups=${runtime.excludedGroups.join(",")}`];
}

export function resolveSituationalMavenArgs(runtime: RuntimeSection): string[] {
  if (runtime.excludedGroups === undefined) {
    return [...SITUATIONAL_MAVEN_TEST_ARGS];
  }
  return [SITUATIONAL_MAVEN_GROUPS_ARG, `-DexcludedGroups=${runtime.excludedGroups.join(",")}`];
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

export function resolveConnectionCluster(connection: ConnectionClusterSetup | undefined): SelectedCluster | undefined {
  if (!connection) {
    return undefined;
  }
  return resolveClusterConnectionRecord({ ...connection }, "cluster.connection");
}

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

export function resolveFunctionalIteration(iteration: FunctionalIteration): ResolvedFunctionalIteration {
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

export function resolveSituationalIteration(iteration: SituationalIteration): ResolvedSituationalIteration {
  const sdk = sdkByValue(iteration.setup.performer.sdk);
  if (!sdk) {
    throw new Error(
      `Unknown sdk "${iteration.setup.performer.sdk}". Valid values: ${SDKS.map((s) => s.value).join(", ")}.`,
    );
  }

  return {
    type: "situational",
    sdk,
    ...(iteration.fitConfig !== undefined ? { fitConfig: iteration.fitConfig } : {}),
    performerPort: iteration.setup.performer.port ?? DEFAULT_PERFORMER_PORT,
    testSelection: resolveTestSelection(iteration.runtime),
    ...(iteration.setup.performer.version !== undefined
      ? { performerVersion: iteration.setup.performer.version }
      : {}),
    onPortInUse: iteration.setup.performer.onPortInUse ?? DEFAULT_PORT_IN_USE_POLICY,
    extraMavenArgs: resolveSituationalMavenArgs(iteration.runtime),
    databaseMode: iteration.situational.database.mode,
  };
}

export function resolveCycle(cycle: FitCycle): ResolvedCycle {
  if (cycle.type === "situational") {
    return {
      type: "situational",
      iterations: cycle.iterations.map(resolveSituationalIteration),
    };
  }

  const connection = resolveConnectionCluster(cycle.cluster.connection);
  const cbdinocluster = resolveCbdinocluster(cycle.cluster);
  const useExisting = cycle.cluster.useExisting !== undefined;
  const clusterMode = connection ? "connection" : useExisting ? "useExisting" : "cbdinocluster";

  return {
    type: "functional",
    clusterMode,
    ...(cbdinocluster ? { cbdinocluster } : {}),
    iterations: cycle.iterations.map((iteration) => {
      const resolved = resolveFunctionalIteration(iteration);
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
          "cycle.cluster.useExisting requires each functional iteration to define fitConfig.clusterAccess.",
        );
      }
      return {
        ...resolved,
        cluster: resolveFitConfigCluster(resolved.fitConfig),
      };
    }),
  };
}

export function resolveDefinition(definition: FitDefinition): ResolvedDefinition {
  return {
    ...(definition.setup?.repos?.["transactions-fit-performer"]?.gerritRef !== undefined
      ? { fitPerformerGerritRef: definition.setup.repos["transactions-fit-performer"].gerritRef }
      : {}),
    cycles: definition.cycles.map(resolveCycle),
  };
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const path = process.argv[2];
    if (!path) {
      console.error("Usage: tsx src/workflows/fit-shared/definition/resolve-definition.ts <file.yaml>");
      process.exit(2);
    }
    console.log(JSON.stringify(resolveDefinition(loadDefinition(path)), null, 2));
    return Promise.resolve();
  });
}
