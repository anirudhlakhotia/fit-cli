/**
 * Parse and validate a `fit` definition file.
 */
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { PORT_IN_USE_POLICIES, type PortInUsePolicy } from "../../performers/util/performer-port.js";
import {
  CLUSTER_EXISTS_POLICIES,
  type ClusterExistsPolicy,
} from "../../../cluster/cluster-create/cluster-exists-policy.js";
import type { CbdinoclusterDef } from "../../../cluster/cluster-create/build-cluster-def.js";
import { SDKS, type SdkValue } from "../../../util/sdk/sdks.js";
import {
  CURRENT_FIT_DEFINITION_VERSION,
  FIT_DEFINITION_TYPE,
  FIT_RUN_TYPES,
  SITUATIONAL_DATABASE_MODES,
  type AwsInstanceSetup,
  type CbdinoclusterInitSetup,
  type CbdinoclusterSetup,
  type ClusterConfigRef,
  type ClusterLifetime,
  type ClusterTls,
  type ConnectionClusterSetup,
  type DefinitionTests,
  type FitConfigPiece,
  type FitConfigRef,
  type FitDefinition,
  type FitRun,
  type InstanceLifetime,
  type MavenOptions,
  type PerformerSetup,
  type SessionLifetime,
  type SharedSetup,
  type SituationalDatabaseMode,
  type SituationalDatabaseSetup,
  type SituationalSection,
  type TestsSection,
  type UseExistingClusterSetup,
} from "./types.js";

export class UnsupportedDefinitionVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedDefinitionVersionError";
  }
}

export class InvalidDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDefinitionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === "string";
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new InvalidDefinitionError(`"${path}" must be a mapping; got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireString(record: Record<string, unknown>, key: string, path: string): string {
  if (!(key in record)) {
    throw new InvalidDefinitionError(`Missing required field: ${path}`);
  }
  if (!isString(record[key])) {
    throw new InvalidDefinitionError(`"${path}" must be a string; got ${JSON.stringify(record[key])}`);
  }
  return record[key];
}

function validateJsonLike(value: unknown, path: string): JsonLike {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => validateJsonLike(entry, `${path}[${index}]`));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, validateJsonLike(entry, `${path}.${key}`)]),
    );
  }
  throw new InvalidDefinitionError(
    `"${path}" must contain only JSON-compatible values; got ${JSON.stringify(value)}`,
  );
}

function validateFitConfig(value: unknown, path: string): FitConfigPiece {
  return validateJsonLike(requireRecord(value, path), path) as FitConfigPiece;
}

function validateTls(value: unknown, path: string): ClusterTls {
  if (value === null || value === undefined) {
    return null;
  }
  const record = requireRecord(value, path);
  if (record.insecure === true) {
    return { insecure: true };
  }
  if (isString(record.certPath)) {
    return { certPath: record.certPath };
  }
  throw new InvalidDefinitionError(
    `"${path}" must be null, { insecure: true }, or { certPath: <path> }; got ${JSON.stringify(value)}`,
  );
}

function validateConnection(value: unknown, path: string): ConnectionClusterSetup {
  const record = requireRecord(value, path);
  return {
    connectionString: requireString(record, "connectionString", `${path}.connectionString`),
    username: requireString(record, "username", `${path}.username`),
    password: requireString(record, "password", `${path}.password`),
    ...(record.tls !== undefined ? { tls: validateTls(record.tls, `${path}.tls`) } : {}),
  };
}

function validateUseExisting(value: unknown, path: string): UseExistingClusterSetup {
  if (value === null || value === undefined) {
    return {};
  }
  const record = requireRecord(value, path);
  if (Object.keys(record).length > 0) {
    throw new InvalidDefinitionError(`"${path}" must be empty.`);
  }
  return {};
}

function requirePositiveInteger(record: Record<string, unknown>, key: string, path: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new InvalidDefinitionError(`"${path}" must be a positive integer; got ${JSON.stringify(value)}`);
  }
  return value;
}

function isClusterExistsPolicy(value: unknown): value is ClusterExistsPolicy {
  return isString(value) && (CLUSTER_EXISTS_POLICIES as readonly string[]).includes(value);
}

function validateClusterNode(value: unknown, path: string): CbdinoclusterDef["nodes"][number] {
  const record = requireRecord(value, path);
  const services = record.services;
  if (!isStringArray(services) || services.length === 0) {
    throw new InvalidDefinitionError(`"${path}.services" must be a non-empty list; got ${JSON.stringify(services)}`);
  }
  return {
    count: requirePositiveInteger(record, "count", `${path}.count`),
    version: requireString(record, "version", `${path}.version`),
    services,
  };
}

function validateCbdinoclusterDef(value: unknown, path: string): CbdinoclusterDef {
  const record = requireRecord(value, path);
  if (!Array.isArray(record.nodes) || record.nodes.length === 0) {
    throw new InvalidDefinitionError(`"${path}.nodes" must be a non-empty list; got ${JSON.stringify(record.nodes)}`);
  }
  const def: CbdinoclusterDef = {
    nodes: record.nodes.map((node, index) => validateClusterNode(node, `${path}.nodes[${index}]`)),
  };
  if (record.cao !== undefined) {
    const cao = requireRecord(record.cao, `${path}.cao`);
    def.cao = {
      "operator-version": requireString(cao, "operator-version", `${path}.cao.operator-version`),
      "gateway-version": requireString(cao, "gateway-version", `${path}.cao.gateway-version`),
    };
  }
  return def;
}

function validateCbdinoclusterInit(value: unknown, path: string): CbdinoclusterInitSetup {
  const record = requireRecord(value, path);
  if (record.config === undefined) {
    throw new InvalidDefinitionError(`Missing required field: ${path}.config`);
  }
  return { config: validateFitConfig(record.config, `${path}.config`) };
}

function validateCbdinocluster(value: unknown, path: string): CbdinoclusterSetup {
  const record = requireRecord(value, path);
  if (record.config === undefined) {
    throw new InvalidDefinitionError(`Missing required field: ${path}.config`);
  }
  const cbdinocluster: CbdinoclusterSetup = { config: validateCbdinoclusterDef(record.config, `${path}.config`) };
  if (record.init !== undefined) {
    cbdinocluster.init = validateCbdinoclusterInit(record.init, `${path}.init`);
  }
  if (record.onClusterExists !== undefined) {
    if (!isClusterExistsPolicy(record.onClusterExists)) {
      throw new InvalidDefinitionError(
        `"${path}.onClusterExists" must be one of ${CLUSTER_EXISTS_POLICIES.join(", ")} when present; got ${JSON.stringify(record.onClusterExists)}`,
      );
    }
    cbdinocluster.onClusterExists = record.onClusterExists;
  }
  if (record.deployer !== undefined) {
    cbdinocluster.deployer = requireString(record, "deployer", `${path}.deployer`);
  }
  return cbdinocluster;
}

function validateOptionalString(record: Record<string, unknown>, key: string, path: string): string | undefined {
  return record[key] === undefined ? undefined : requireString(record, key, path);
}

function validateAwsInstance(value: unknown, path: string): AwsInstanceSetup {
  const record = value === null ? {} : requireRecord(value, path);
  const aws: AwsInstanceSetup = {};
  const instanceType = validateOptionalString(record, "instanceType", `${path}.instanceType`);
  if (instanceType !== undefined) {
    aws.instanceType = instanceType;
  }
  const region = validateOptionalString(record, "region", `${path}.region`);
  if (region !== undefined) {
    aws.region = region;
  }
  return aws;
}

function validateLocalhostInstance(value: unknown, path: string): Record<string, never> {
  if (value === null || value === undefined) {
    return {};
  }
  const record = requireRecord(value, path);
  if (Object.keys(record).length > 0) {
    throw new InvalidDefinitionError(`"${path}" must be empty; localhost takes no options.`);
  }
  return {};
}

function validateRepos(value: unknown): SharedSetup["repos"] {
  if (value === null) {
    return {};
  }
  const record = requireRecord(value, "setup.repos");
  const repos: NonNullable<SharedSetup["repos"]> = {};
  if (record["transactions-fit-performer"] !== undefined) {
    const fitPerformer = requireRecord(record["transactions-fit-performer"], "setup.repos.transactions-fit-performer");
    repos["transactions-fit-performer"] = {
      ...(fitPerformer.gerritRef !== undefined
        ? { gerritRef: requireString(fitPerformer, "gerritRef", "setup.repos.transactions-fit-performer.gerritRef") }
        : {}),
    };
  }
  return repos;
}

function validateSharedSetup(value: unknown): SharedSetup {
  const record = requireRecord(value, "setup");
  const setup: SharedSetup = {};
  if (record.cluster !== undefined) {
    throw new InvalidDefinitionError(`"setup.cluster" is no longer supported.`);
  }
  if (record.repos !== undefined) {
    setup.repos = validateRepos(record.repos);
  }
  return setup;
}

function isPortInUsePolicy(value: unknown): value is PortInUsePolicy {
  return isString(value) && (PORT_IN_USE_POLICIES as readonly string[]).includes(value);
}

const SDK_VALUES = SDKS.map((sdk) => sdk.value);

function isSdkValue(value: unknown): value is SdkValue {
  return isString(value) && (SDK_VALUES as readonly string[]).includes(value);
}

function validatePerformer(value: unknown, path: string): PerformerSetup {
  const record = requireRecord(value, path);
  const sdk = requireString(record, "sdk", `${path}.sdk`);
  if (!isSdkValue(sdk)) {
    throw new InvalidDefinitionError(
      `"${path}.sdk" must be one of ${SDK_VALUES.join(", ")}; got ${JSON.stringify(sdk)}`,
    );
  }
  const performer: PerformerSetup = { sdk };
  if (record.port !== undefined) {
    performer.port = requirePositiveInteger(record, "port", `${path}.port`);
  }
  if (record.version !== undefined) {
    performer.version = requireString(record, "version", `${path}.version`);
  }
  if (record.onPortInUse !== undefined) {
    if (!isPortInUsePolicy(record.onPortInUse)) {
      throw new InvalidDefinitionError(
        `"${path}.onPortInUse" must be one of ${PORT_IN_USE_POLICIES.join(", ")} when present; got ${JSON.stringify(record.onPortInUse)}`,
      );
    }
    performer.onPortInUse = record.onPortInUse;
  }
  return performer;
}

function validateDefinitionTests(value: unknown, path: string): DefinitionTests {
  if (value === undefined || value === "all") {
    return "all";
  }
  if (isStringArray(value) && value.length > 0) {
    return value;
  }
  throw new InvalidDefinitionError(`"${path}" must be "all" or a non-empty list of test class names; got ${JSON.stringify(value)}`);
}

function validateMaven(value: unknown, path: string): MavenOptions {
  const record = requireRecord(value, path);
  const maven: MavenOptions = {};
  if (record.args !== undefined) {
    if (!isStringArray(record.args)) {
      throw new InvalidDefinitionError(`"${path}.args" must be a list of strings when present; got ${JSON.stringify(record.args)}`);
    }
    maven.args = record.args;
  }
  if (record.runDisabledTests !== undefined) {
    if (typeof record.runDisabledTests !== "boolean") {
      throw new InvalidDefinitionError(`"${path}.runDisabledTests" must be a boolean when present; got ${JSON.stringify(record.runDisabledTests)}`);
    }
    maven.runDisabledTests = record.runDisabledTests;
  }
  return maven;
}

function validateTestsSection(value: unknown, path: string): TestsSection {
  const record = requireRecord(value, path);
  const tests: TestsSection = { run: validateDefinitionTests(record.run, `${path}.run`) };
  if (record.excludedGroups !== undefined) {
    if (!isStringArray(record.excludedGroups)) {
      throw new InvalidDefinitionError(`"${path}.excludedGroups" must be a list of strings when present; got ${JSON.stringify(record.excludedGroups)}`);
    }
    tests.excludedGroups = record.excludedGroups;
  }
  if (record.maven !== undefined) {
    tests.maven = validateMaven(record.maven, `${path}.maven`);
  }
  return tests;
}

function isSituationalDatabaseMode(value: unknown): value is SituationalDatabaseMode {
  return isString(value) && (SITUATIONAL_DATABASE_MODES as readonly string[]).includes(value);
}

function validateSituationalDatabase(value: unknown, path: string): SituationalDatabaseSetup {
  const record = requireRecord(value, path);
  if (!isSituationalDatabaseMode(record.mode)) {
    throw new InvalidDefinitionError(`"${path}.mode" must be one of ${SITUATIONAL_DATABASE_MODES.join(", ")}; got ${JSON.stringify(record.mode)}`);
  }
  return { mode: record.mode };
}

function validateSituationalSection(value: unknown, path: string): SituationalSection {
  const record = requireRecord(value, path);
  if (record.database === undefined) {
    throw new InvalidDefinitionError(`Missing required field: ${path}.database`);
  }
  return { database: validateSituationalDatabase(record.database, `${path}.database`) };
}

function validateRunFitConfig(value: unknown, path: string): FitConfigPiece | string {
  if (isString(value)) {
    return value;
  }
  return validateFitConfig(value, path);
}

function validateRun(value: unknown, path: string, clusterless: boolean): FitRun {
  const record = requireRecord(value, path);
  const type = record.type;
  if (!isString(type) || !FIT_RUN_TYPES.includes(type as FitRun["type"])) {
    throw new InvalidDefinitionError(`"${path}.type" must be one of ${FIT_RUN_TYPES.join(", ")}; got ${JSON.stringify(type)}`);
  }
  if (record.tests === undefined) {
    throw new InvalidDefinitionError(`Missing required field: ${path}.tests`);
  }
  if (type === "functional") {
    if (clusterless) {
      throw new InvalidDefinitionError(`"${path}.type" cannot be "functional" under clusterlessSessions.`);
    }
    return {
      type: "functional",
      tests: validateTestsSection(record.tests, `${path}.tests`),
      ...(record.fitConfig !== undefined ? { fitConfig: validateRunFitConfig(record.fitConfig, `${path}.fitConfig`) } : {}),
    };
  }
  if (record.situational === undefined) {
    throw new InvalidDefinitionError(`Missing required field: ${path}.situational`);
  }
  return {
    type: "situational",
    tests: validateTestsSection(record.tests, `${path}.tests`),
    situational: validateSituationalSection(record.situational, `${path}.situational`),
    ...(record.fitConfig !== undefined ? { fitConfig: validateRunFitConfig(record.fitConfig, `${path}.fitConfig`) } : {}),
  };
}

function validateSession(value: unknown, path: string, clusterless: boolean): SessionLifetime {
  const record = requireRecord(value, path);
  if (record.performer === undefined) {
    throw new InvalidDefinitionError(`Missing required field: ${path}.performer`);
  }
  if (!Array.isArray(record.runs) || record.runs.length === 0) {
    throw new InvalidDefinitionError(`"${path}.runs" must contain at least one run.`);
  }
  return {
    performer: validatePerformer(record.performer, `${path}.performer`),
    runs: record.runs.map((run, index) => validateRun(run, `${path}.runs[${index}]`, clusterless)),
  };
}

function validateCluster(value: unknown, path: string): ClusterLifetime {
  const record = requireRecord(value, path);
  if (!Array.isArray(record.sessions) || record.sessions.length === 0) {
    throw new InvalidDefinitionError(`"${path}.sessions" must contain at least one session.`);
  }
  const cluster: ClusterLifetime = {
    sessions: record.sessions.map((session, index) => validateSession(session, `${path}.sessions[${index}]`, false)),
  };
  if (record.clusterConfig !== undefined) {
    if (!isString(record.clusterConfig)) {
      throw new InvalidDefinitionError(`"${path}.clusterConfig" must be a string id; got ${JSON.stringify(record.clusterConfig)}`);
    }
    if (record.connection !== undefined || record.useExisting !== undefined || record.cbdinocluster !== undefined) {
      throw new InvalidDefinitionError(`"${path}" cannot mix "clusterConfig" (ref) with inline cluster fields.`);
    }
    cluster.clusterConfig = record.clusterConfig;
  } else {
    if (record.connection !== undefined) {
      cluster.connection = validateConnection(record.connection, `${path}.connection`);
    }
    if (record.useExisting !== undefined) {
      cluster.useExisting = validateUseExisting(record.useExisting, `${path}.useExisting`);
    }
    if (record.cbdinocluster !== undefined) {
      cluster.cbdinocluster = validateCbdinocluster(record.cbdinocluster, `${path}.cbdinocluster`);
    }
    const modes = [cluster.connection, cluster.useExisting, cluster.cbdinocluster].filter(Boolean);
    if (modes.length !== 1) {
      throw new InvalidDefinitionError(`"${path}" must have exactly one of "connection", "useExisting", or "cbdinocluster".`);
    }
  }
  return cluster;
}

function validateClusterConfigs(value: unknown): ClusterConfigRef[] {
  if (!Array.isArray(value)) {
    throw new InvalidDefinitionError(`"clusterConfigs" must be a list; got ${JSON.stringify(value)}`);
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const path = `clusterConfigs[${index}]`;
    const record = requireRecord(entry, path);
    const id = requireString(record, "id", `${path}.id`);
    if (ids.has(id)) {
      throw new InvalidDefinitionError(`Duplicate clusterConfigs id: "${id}"`);
    }
    ids.add(id);
    const ref: ClusterConfigRef = { id };
    if (record.connection !== undefined) {
      ref.connection = validateConnection(record.connection, `${path}.connection`);
    }
    if (record.useExisting !== undefined) {
      ref.useExisting = validateUseExisting(record.useExisting, `${path}.useExisting`);
    }
    if (record.cbdinocluster !== undefined) {
      ref.cbdinocluster = validateCbdinocluster(record.cbdinocluster, `${path}.cbdinocluster`);
    }
    const modes = [ref.connection, ref.useExisting, ref.cbdinocluster].filter(Boolean);
    if (modes.length !== 1) {
      throw new InvalidDefinitionError(`"${path}" must have exactly one of "connection", "useExisting", or "cbdinocluster".`);
    }
    return ref;
  });
}

function validateFitConfigs(value: unknown): FitConfigRef[] {
  if (!Array.isArray(value)) {
    throw new InvalidDefinitionError(`"fitConfigs" must be a list; got ${JSON.stringify(value)}`);
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const path = `fitConfigs[${index}]`;
    const record = requireRecord(entry, path);
    const id = requireString(record, "id", `${path}.id`);
    if (ids.has(id)) {
      throw new InvalidDefinitionError(`Duplicate fitConfigs id: "${id}"`);
    }
    ids.add(id);
    if (record.config === undefined) {
      throw new InvalidDefinitionError(`Missing required field: ${path}.config`);
    }
    return { id, config: validateFitConfig(record.config, `${path}.config`) };
  });
}

function validateInstance(value: unknown, index: number): InstanceLifetime {
  const path = `instances[${index}]`;
  const record = requireRecord(value, path);
  const hasAws = record.aws !== undefined;
  const hasLocalhost = record.localhost !== undefined;
  if (hasAws === hasLocalhost) {
    throw new InvalidDefinitionError(`"${path}" must have exactly one of "aws" or "localhost".`);
  }
  const clusters = Array.isArray(record.clusters)
    ? record.clusters.map((cluster, clusterIndex) => validateCluster(cluster, `${path}.clusters[${clusterIndex}]`))
    : (() => {
        throw new InvalidDefinitionError(`"${path}.clusters" must be a list; got ${JSON.stringify(record.clusters)}`);
      })();
  const clusterlessSessions = record.clusterlessSessions === undefined
    ? undefined
    : Array.isArray(record.clusterlessSessions)
      ? record.clusterlessSessions.map((session, sessionIndex) =>
          validateSession(session, `${path}.clusterlessSessions[${sessionIndex}]`, true),
        )
      : (() => {
          throw new InvalidDefinitionError(`"${path}.clusterlessSessions" must be a list when present.`);
        })();
  const instance: InstanceLifetime = {
    ...(hasAws
      ? { aws: validateAwsInstance(record.aws, `${path}.aws`) }
      : { localhost: validateLocalhostInstance(record.localhost, `${path}.localhost`) }),
    clusters,
  };
  if (record.cbdinocluster !== undefined) {
    const cbdinocluster = requireRecord(record.cbdinocluster, `${path}.cbdinocluster`);
    if (cbdinocluster.init === undefined) {
      throw new InvalidDefinitionError(`Missing required field: ${path}.cbdinocluster.init`);
    }
    instance.cbdinocluster = { init: validateCbdinoclusterInit(cbdinocluster.init, `${path}.cbdinocluster.init`) };
  }
  if (clusterlessSessions !== undefined) {
    if (clusterlessSessions.length === 0) {
      throw new InvalidDefinitionError(`"${path}.clusterlessSessions" must contain at least one session when present.`);
    }
    if (instance.cbdinocluster === undefined) {
      throw new InvalidDefinitionError(`"${path}.cbdinocluster.init" is required when using clusterlessSessions.`);
    }
    instance.clusterlessSessions = clusterlessSessions;
  }
  if (clusters.length === 0 && (instance.clusterlessSessions?.length ?? 0) === 0) {
    throw new InvalidDefinitionError(`"${path}" must contain at least one cluster or clusterless session.`);
  }
  return instance;
}

function validateVersion(version: unknown): number {
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new InvalidDefinitionError(`Missing or invalid "version" (expected an integer); got ${JSON.stringify(version)}`);
  }
  if (version > CURRENT_FIT_DEFINITION_VERSION) {
    throw new UnsupportedDefinitionVersionError(
      `This definition file is version ${version}, but this fit-cli only understands up to version ${CURRENT_FIT_DEFINITION_VERSION}. Update fit-cli (git pull) to run it.`,
    );
  }
  if (version < CURRENT_FIT_DEFINITION_VERSION) {
    throw new UnsupportedDefinitionVersionError(
      `Definition file version ${version} is no longer supported. Recreate it as version ${CURRENT_FIT_DEFINITION_VERSION}.`,
    );
  }
  return version;
}

export function validateDefinition(raw: unknown): FitDefinition {
  if (!isRecord(raw)) {
    throw new InvalidDefinitionError("Definition file must be a YAML mapping at the top level.");
  }
  validateVersion(raw.version);
  if (raw.type !== FIT_DEFINITION_TYPE) {
    throw new InvalidDefinitionError(`Expected "type: ${FIT_DEFINITION_TYPE}"; got ${JSON.stringify(raw.type)}`);
  }
  if (raw.cycles !== undefined) {
    throw new InvalidDefinitionError(`"cycles" is no longer supported; rewrite the file to use top-level "instances".`);
  }
  if (raw.iterations !== undefined) {
    throw new InvalidDefinitionError(`"iterations" is no longer supported; rewrite the file to use "sessions[].runs".`);
  }
  if (!Array.isArray(raw.instances)) {
    throw new InvalidDefinitionError(`"instances" must be a list; got ${JSON.stringify(raw.instances)}`);
  }
  if (raw.instances.length === 0) {
    throw new InvalidDefinitionError(`"instances" must contain at least one instance.`);
  }
  return {
    version: CURRENT_FIT_DEFINITION_VERSION,
    type: FIT_DEFINITION_TYPE,
    ...(raw.setup !== undefined ? { setup: validateSharedSetup(raw.setup) } : {}),
    instances: raw.instances.map(validateInstance),
    ...(raw.clusterConfigs !== undefined ? { clusterConfigs: validateClusterConfigs(raw.clusterConfigs) } : {}),
    ...(raw.fitConfigs !== undefined ? { fitConfigs: validateFitConfigs(raw.fitConfigs) } : {}),
  };
}

export function parseDefinition(text: string): FitDefinition {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    throw new InvalidDefinitionError(`Could not parse YAML: ${(err as Error).message}`);
  }
  return validateDefinition(raw);
}

export function loadDefinition(path: string): FitDefinition {
  return parseDefinition(readFileSync(path, "utf8"));
}

function countRuns(definition: FitDefinition): number {
  return definition.instances.reduce(
    (total, instance) =>
      total +
      instance.clusters.reduce(
        (clusterTotal, cluster) => clusterTotal + cluster.sessions.reduce((sessionTotal, session) => sessionTotal + session.runs.length, 0),
        0,
      ) +
      (instance.clusterlessSessions?.reduce((sessionTotal, session) => sessionTotal + session.runs.length, 0) ?? 0),
    0,
  );
}

const HELP = `Validate a fit definition file and print the parsed result.

Primary usage:
  npm run definition -- validate <file.yaml>

Direct invocation (for debugging):
  npx tsx src/fit/shared/definition/parse-definition.ts <file.yaml>
  npx tsx src/fit/shared/definition/parse-definition.ts --help

Exits 0 and prints the normalised definition as JSON if the file is valid;
exits 1 with an explanation otherwise.`;

if (isMain(import.meta.url)) {
  runCli(() => {
    const path = process.argv[2];
    if (!path || path === "--help" || path === "-h") {
      console.log(HELP);
      if (!path) process.exit(2);
      return Promise.resolve();
    }
    const definition = loadDefinition(path);
    console.log(
      `✓ Valid ${FIT_DEFINITION_TYPE} definition (version ${definition.version}, ${definition.instances.length} instance(s), ${countRuns(definition)} run(s)).`,
    );
    return Promise.resolve();
  });
}
