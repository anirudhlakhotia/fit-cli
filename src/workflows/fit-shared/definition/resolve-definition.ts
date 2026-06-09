/**
 * Turn a validated `fit` definition into concrete run inputs.
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { mergeConfigPieces, type ConfigPiece, type PieceData } from "../../../util/non-fit/config-pieces.js";
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
  ClusterLifetime,
  ConnectionClusterSetup,
  FitDefinition,
  FitRun,
  InstanceLifetime,
  SessionLifetime,
  SituationalDatabaseMode,
  TestsSection,
} from "./types.js";

export type ResolvedInstance =
  | { kind: "aws"; instanceType?: string; region?: string }
  | { kind: "localhost" };

export function resolveInstance(instance: InstanceLifetime): ResolvedInstance {
  if ("aws" in instance) {
    return {
      kind: "aws",
      ...(instance.aws.instanceType !== undefined ? { instanceType: instance.aws.instanceType } : {}),
      ...(instance.aws.region !== undefined ? { region: instance.aws.region } : {}),
    };
  }
  return { kind: "localhost" };
}

export interface ResolvedRunCommon {
  fitConfig?: PieceData;
  testSelection: FitTestSelection;
  extraMavenArgs: string[];
}

export interface ResolvedFunctionalRun extends ResolvedRunCommon {
  type: "functional";
}

export interface ResolvedSituationalRun extends ResolvedRunCommon {
  type: "situational";
  databaseMode: SituationalDatabaseMode;
}

export type ResolvedRun = ResolvedFunctionalRun | ResolvedSituationalRun;

export interface ResolvedSessionPlan {
  sdk: Sdk;
  performerPort: number;
  performerVersion?: string;
  onPortInUse: PortInUsePolicy;
  runs: ResolvedRun[];
}

export interface ResolvedCbdinocluster {
  init?: { config: PieceData };
  config: CbdinoclusterDef;
  onClusterExists: ClusterExistsPolicy;
  deployer?: string;
}

export interface ResolvedClusterPlan {
  clusterMode: "connection" | "useExisting" | "cbdinocluster";
  cng: boolean;
  cluster?: SelectedCluster;
  cbdinocluster?: ResolvedCbdinocluster;
  sessions: ResolvedSessionPlan[];
}

export interface ResolvedInstancePlan {
  instance: ResolvedInstance;
  clusters: ResolvedClusterPlan[];
  cbdinoclusterInit?: { config: PieceData };
  clusterlessSessions: ResolvedSessionPlan[];
}

export interface ResolvedDefinition {
  fitPerformerGerritRef?: string;
  instances: ResolvedInstancePlan[];
  cycles: ResolvedCycle[];
}

export interface ResolvedIterationCommon extends ResolvedRunCommon {
  sdk: Sdk;
  performerPort: number;
  performerVersion?: string;
  onPortInUse: PortInUsePolicy;
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

export interface ResolvedFunctionalCycle {
  type: "functional";
  instance: ResolvedInstance;
  clusterMode: "connection" | "useExisting" | "cbdinocluster";
  cng: boolean;
  cluster?: SelectedCluster;
  cbdinocluster?: ResolvedCbdinocluster;
  iterations: ResolvedFunctionalIteration[];
}

export interface ResolvedSituationalCycle {
  type: "situational";
  instance: ResolvedInstance;
  cbdinoclusterInit: { config: PieceData };
  iterations: ResolvedSituationalIteration[];
}

export type ResolvedCycle = ResolvedFunctionalCycle | ResolvedSituationalCycle;

function resolveTestsSelection(tests: TestsSection): FitTestSelection {
  return tests.run === "all"
    ? buildDefaultFitTestSelection()
    : buildFitTestSelectionFromClassNames(tests.run);
}

const JUNIT_DISABLED_CONDITION = "org.junit.jupiter.api.condition.DisabledCondition";

function resolveMavenSuffix(tests: TestsSection): string[] {
  const extra: string[] = [];
  if (tests.maven?.runDisabledTests) {
    extra.push(`-Djunit.jupiter.conditions.deactivate=${JUNIT_DISABLED_CONDITION}`);
  }
  if (tests.maven?.args) {
    extra.push(...tests.maven.args);
  }
  return extra;
}

export function resolveMavenArgs(tests: TestsSection): string[] {
  const base = tests.excludedGroups === undefined
    ? [...DEFAULT_MAVEN_TEST_ARGS]
    : [`-DexcludedGroups=${tests.excludedGroups.join(",")}`];
  return [...base, ...resolveMavenSuffix(tests)];
}

export function resolveSituationalMavenArgs(tests: TestsSection): string[] {
  const base = tests.excludedGroups === undefined
    ? [...SITUATIONAL_MAVEN_TEST_ARGS]
    : [SITUATIONAL_MAVEN_GROUPS_ARG, `-DexcludedGroups=${tests.excludedGroups.join(",")}`];
  return [...base, ...resolveMavenSuffix(tests)];
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

function resolveClusterConnectionRecord(clusterAccess: Record<string, unknown>, path: string): SelectedCluster {
  const connectionString = requireString(clusterAccess, "connectionString", `${path}.connectionString`);
  const classification = classifyConnectionString(connectionString);
  if (classification.kind !== "supported") {
    throw new Error(
      `${path}.connectionString "${connectionString}" is not one fit-cli can use (${classification.kind}). Use a couchbase:// or couchbases:// connection string.`,
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

export function resolveFitConfigCluster(
  fitConfig: PieceData | undefined,
  path: string = "cluster.fitConfig",
): SelectedCluster | undefined {
  if (!fitConfig) {
    return undefined;
  }
  const clusterAccess = requireRecord(fitConfig.clusterAccess, `${path}.clusterAccess`);
  return resolveClusterConnectionRecord(clusterAccess, `${path}.clusterAccess`);
}

function stripFitConfigClusterAccess(fitConfig: PieceData | undefined): PieceData | undefined {
  if (!fitConfig || !("clusterAccess" in fitConfig)) {
    return fitConfig;
  }
  const rest = { ...fitConfig };
  delete rest.clusterAccess;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function mergeFitConfig(clusterFitConfig: PieceData | undefined, runFitConfig: PieceData | undefined): PieceData | undefined {
  const pieces: ConfigPiece[] = [];
  if (clusterFitConfig) {
    pieces.push({ label: "cluster fitConfig", data: clusterFitConfig });
  }
  if (runFitConfig) {
    pieces.push({ label: "run fitConfig", data: runFitConfig });
  }
  if (pieces.length === 0) {
    return undefined;
  }
  return mergeConfigPieces(pieces) as PieceData;
}

export function resolveCbdinocluster(cluster: ClusterLifetime): ResolvedCbdinocluster | undefined {
  if (!cluster.cbdinocluster) {
    return undefined;
  }
  return {
    config: cluster.cbdinocluster.config,
    onClusterExists: cluster.cbdinocluster.onClusterExists ?? DEFAULT_CLUSTER_EXISTS_POLICY,
    ...(cluster.cbdinocluster.init !== undefined ? { init: { config: cluster.cbdinocluster.init.config } } : {}),
    ...(cluster.cbdinocluster.deployer !== undefined ? { deployer: cluster.cbdinocluster.deployer } : {}),
  };
}

function resolveRun(run: FitRun, clusterFitConfig: PieceData | undefined, stripClusterAccess: boolean): ResolvedRun {
  const mergedFitConfig = mergeFitConfig(clusterFitConfig, run.fitConfig);
  const fitConfig = stripClusterAccess ? stripFitConfigClusterAccess(mergedFitConfig) : mergedFitConfig;
  if (run.type === "situational") {
    return {
      type: "situational",
      ...(fitConfig !== undefined ? { fitConfig } : {}),
      testSelection: resolveTestsSelection(run.tests),
      extraMavenArgs: resolveSituationalMavenArgs(run.tests),
      databaseMode: run.situational.database.mode,
    };
  }
  return {
    type: "functional",
    ...(fitConfig !== undefined ? { fitConfig } : {}),
    testSelection: resolveTestsSelection(run.tests),
    extraMavenArgs: resolveMavenArgs(run.tests),
  };
}

export function resolveSession(
  session: SessionLifetime,
  clusterFitConfig: PieceData | undefined,
  stripClusterAccess: boolean,
): ResolvedSessionPlan {
  const sdk = sdkByValue(session.performer.sdk);
  if (!sdk) {
    throw new Error(`Unknown sdk "${session.performer.sdk}". Valid values: ${SDKS.map((s) => s.value).join(", ")}.`);
  }
  return {
    sdk,
    performerPort: session.performer.port ?? DEFAULT_PERFORMER_PORT,
    ...(session.performer.version !== undefined ? { performerVersion: session.performer.version } : {}),
    onPortInUse: session.performer.onPortInUse ?? DEFAULT_PORT_IN_USE_POLICY,
    runs: session.runs.map((run) => resolveRun(run, clusterFitConfig, stripClusterAccess)),
  };
}

export function resolveCluster(cluster: ClusterLifetime): ResolvedClusterPlan {
  const connection = resolveConnectionCluster(cluster.connection);
  const cbdinocluster = resolveCbdinocluster(cluster);
  const useExisting = cluster.useExisting !== undefined;
  const clusterMode = connection ? "connection" : useExisting ? "useExisting" : "cbdinocluster";
  const resolvedCluster = connection ?? (useExisting ? resolveFitConfigCluster(cluster.fitConfig) : undefined);
  if (useExisting && !resolvedCluster) {
    throw new Error("cluster.useExisting requires cluster.fitConfig.clusterAccess.");
  }
  return {
    clusterMode,
    cng: cbdinocluster?.config.cao !== undefined,
    ...(resolvedCluster ? { cluster: resolvedCluster } : {}),
    ...(cbdinocluster ? { cbdinocluster } : {}),
    sessions: cluster.sessions.map((session) => resolveSession(session, cluster.fitConfig, clusterMode === "connection")),
  };
}

export function resolveInstancePlan(instance: InstanceLifetime): ResolvedInstancePlan {
  return {
    instance: resolveInstance(instance),
    clusters: instance.clusters.map(resolveCluster),
    ...(instance.cbdinocluster !== undefined ? { cbdinoclusterInit: { config: instance.cbdinocluster.init.config } } : {}),
    clusterlessSessions: (instance.clusterlessSessions ?? []).map((session) => resolveSession(session, undefined, false)),
  };
}

export function resolveDefinition(definition: FitDefinition): ResolvedDefinition {
  const instances = definition.instances.map(resolveInstancePlan);
  return {
    ...(definition.setup?.repos?.["transactions-fit-performer"]?.gerritRef !== undefined
      ? { fitPerformerGerritRef: definition.setup.repos["transactions-fit-performer"].gerritRef }
      : {}),
    instances,
    cycles: flattenInstancesToCycles(instances),
  };
}

function flattenInstancesToCycles(instances: ResolvedInstancePlan[]): ResolvedCycle[] {
  return instances.flatMap((instance) => [
    ...instance.clusters.map<ResolvedFunctionalCycle>((cluster) => ({
      type: "functional",
      instance: instance.instance,
      clusterMode: cluster.clusterMode,
      cng: cluster.cng,
      ...(cluster.cluster ? { cluster: cluster.cluster } : {}),
      ...(cluster.cbdinocluster ? { cbdinocluster: cluster.cbdinocluster } : {}),
      iterations: cluster.sessions.flatMap((session) =>
        session.runs
          .filter((run): run is ResolvedFunctionalRun => run.type === "functional")
          .map((run) => ({
            type: "functional",
            sdk: session.sdk,
            performerPort: session.performerPort,
            ...(session.performerVersion !== undefined ? { performerVersion: session.performerVersion } : {}),
            onPortInUse: session.onPortInUse,
            ...(run.fitConfig !== undefined ? { fitConfig: run.fitConfig } : {}),
            testSelection: run.testSelection,
            extraMavenArgs: run.extraMavenArgs,
            ...(cluster.cluster ? { cluster: cluster.cluster } : {}),
          })),
      ),
    })),
    ...(instance.clusterlessSessions.length === 0 || !instance.cbdinoclusterInit
      ? []
      : [
          {
            type: "situational" as const,
            instance: instance.instance,
            cbdinoclusterInit: instance.cbdinoclusterInit,
            iterations: instance.clusterlessSessions.flatMap((session) =>
              session.runs
                .filter((run): run is ResolvedSituationalRun => run.type === "situational")
                .map((run) => ({
                  type: "situational" as const,
                  sdk: session.sdk,
                  performerPort: session.performerPort,
                  ...(session.performerVersion !== undefined ? { performerVersion: session.performerVersion } : {}),
                  onPortInUse: session.onPortInUse,
                  ...(run.fitConfig !== undefined ? { fitConfig: run.fitConfig } : {}),
                  testSelection: run.testSelection,
                  extraMavenArgs: run.extraMavenArgs,
                  databaseMode: run.databaseMode,
                })),
            ),
          },
        ]),
  ]);
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
