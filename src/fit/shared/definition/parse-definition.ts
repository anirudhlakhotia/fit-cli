/**
 * Parse and validate a `fit` definition file.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import JSON5 from "json5";
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
  TEST_PRESETS,
  type AwsInstanceSetup,
  type CbdinoclusterInitSetup,
  type CbdinoclusterSetup,
  type ClusterConfigRef,
  type ClusterLifetime,
  type ClusterTls,
  type ConnectionClusterSetup,
  type FitConfigPiece,
  type FitConfigRef,
  type FitDefinition,
  type FitRun,
  type InstanceLifetime,
  type InstanceSetup,
  type MavenOptions,
  type PerformerSetup,
  type SessionLifetime,
  type SharedSetup,
  type SituationalDatabaseMode,
  type SituationalDatabaseSetup,
  type SituationalSection,
  type TestPreset,
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

/**
 * The cbdinocluster `config` block is passed through to the `cbdinocluster` CLI
 * verbatim (it's YAML-stringified straight into the def file at allocate time), so
 * we don't reshape it or reject keys fit-cli doesn't model — any valid cbdinocluster
 * cluster-def field is forwarded as-is. We only check that the block is a
 * JSON-compatible mapping (so it serialises cleanly) with a non-empty `nodes` list,
 * which cbdinocluster requires and fit-cli reads downstream to describe the cluster.
 */
function validateCbdinoclusterDef(value: unknown, path: string): CbdinoclusterDef {
  const record = requireRecord(value, path);
  if (!Array.isArray(record.nodes) || record.nodes.length === 0) {
    throw new InvalidDefinitionError(`"${path}.nodes" must be a non-empty list; got ${JSON.stringify(record.nodes)}`);
  }
  return validateJsonLike(record, path) as unknown as CbdinoclusterDef;
}

function validateCbdinoclusterInit(value: unknown, path: string): CbdinoclusterInitSetup {
  const record = requireRecord(value, path);
  const hasArgs = record.args !== undefined;
  const hasConfig = record.config !== undefined;
  if (hasArgs && hasConfig) {
    throw new InvalidDefinitionError(`"${path}" must have exactly one of "args" or "config", not both.`);
  }
  if (hasArgs) {
    return {
      args: requireString(record, "args", `${path}.args`),
      // configPatch is merged onto ~/.cbdinocluster after `cbdinocluster init`
      // runs, for config init can't express via flags (e.g. situational capella/aws).
      ...(record.configPatch !== undefined
        ? { configPatch: validateFitConfig(record.configPatch, `${path}.configPatch`) }
        : {}),
    };
  }
  if (hasConfig) {
    return { config: validateFitConfig(record.config, `${path}.config`) };
  }
  throw new InvalidDefinitionError(`Missing required field: ${path}.args (or ${path}.config)`);
}

function validateCbdinocluster(value: unknown, path: string): CbdinoclusterSetup {
  const record = requireRecord(value, path);
  if (record.config === undefined) {
    throw new InvalidDefinitionError(`Missing required field: ${path}.config`);
  }
  const cbdinocluster: CbdinoclusterSetup = { config: validateCbdinoclusterDef(record.config, `${path}.config`) };
  if (record.init !== undefined) {
    throw new InvalidDefinitionError(
      `"${path}.init" is no longer accepted here — cbdinocluster init moved to instances[].setup.cbdinocluster.init (set up once per instance).`,
    );
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

function isTestPreset(value: unknown): value is TestPreset {
  return isString(value) && (TEST_PRESETS as readonly string[]).includes(value);
}

function validateTestPresets(value: unknown, path: string): TestPreset[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidDefinitionError(
      `"${path}" must be a non-empty list of presets (${TEST_PRESETS.join(", ")}); got ${JSON.stringify(value)}`,
    );
  }
  for (const entry of value) {
    if (!isTestPreset(entry)) {
      throw new InvalidDefinitionError(
        `"${path}" entries must be one of ${TEST_PRESETS.join(", ")}; got ${JSON.stringify(entry)}`,
      );
    }
  }
  return value as TestPreset[];
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
  if (record.run !== undefined) {
    throw new InvalidDefinitionError(
      `"${path}.run" is no longer supported; use "${path}.presets" (a list of ${TEST_PRESETS.join("/")}) and/or "${path}.classes" (a list of test class names).`,
    );
  }
  const tests: TestsSection = {};
  if (record.presets !== undefined) {
    tests.presets = validateTestPresets(record.presets, `${path}.presets`);
  }
  if (record.classes !== undefined) {
    if (!isStringArray(record.classes) || record.classes.length === 0) {
      throw new InvalidDefinitionError(
        `"${path}.classes" must be a non-empty list of test class names when present; got ${JSON.stringify(record.classes)}`,
      );
    }
    tests.classes = record.classes;
  }
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

function validateInstanceSetup(value: unknown, path: string): InstanceSetup | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = requireRecord(value, path);
  const setup: InstanceSetup = {};
  if (record.cbdinocluster !== undefined) {
    const cbdinocluster = requireRecord(record.cbdinocluster, `${path}.cbdinocluster`);
    if (cbdinocluster.init === undefined) {
      throw new InvalidDefinitionError(`Missing required field: ${path}.cbdinocluster.init`);
    }
    setup.cbdinocluster = { init: validateCbdinoclusterInit(cbdinocluster.init, `${path}.cbdinocluster.init`) };
  }
  return setup;
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
    throw new InvalidDefinitionError(
      `"${path}.cbdinocluster" is no longer accepted — cbdinocluster init moved to ${path}.setup.cbdinocluster.init (set up once per instance).`,
    );
  }
  const setup = validateInstanceSetup(record.setup, `${path}.setup`);
  if (setup !== undefined) {
    instance.setup = setup;
  }
  if (clusterlessSessions !== undefined) {
    if (clusterlessSessions.length === 0) {
      throw new InvalidDefinitionError(`"${path}.clusterlessSessions" must contain at least one session when present.`);
    }
    if (setup?.cbdinocluster?.init === undefined) {
      throw new InvalidDefinitionError(`"${path}.setup.cbdinocluster.init" is required when using clusterlessSessions.`);
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
    throw new InvalidDefinitionError("Definition file must be an object at the top level.");
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
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(raw.setup !== undefined ? { setup: validateSharedSetup(raw.setup) } : {}),
    instances: raw.instances.map(validateInstance),
    ...(raw.clusterConfigs !== undefined ? { clusterConfigs: validateClusterConfigs(raw.clusterConfigs) } : {}),
    ...(raw.fitConfigs !== undefined ? { fitConfigs: validateFitConfigs(raw.fitConfigs) } : {}),
  };
}

export type DefinitionFormat = "json5" | "yaml";

function detectDefinitionFormat(path: string): DefinitionFormat {
  if (/\.json5$/i.test(path)) return "json5";
  if (/\.ya?ml$/i.test(path)) return "yaml";
  return "json5";
}

export function parseDefinition(text: string, format?: DefinitionFormat): FitDefinition {
  let raw: unknown;
  if (format === "yaml") {
    try {
      raw = YAML.parse(text);
    } catch (err) {
      throw new InvalidDefinitionError(`Could not parse YAML: ${(err as Error).message}`);
    }
  } else if (format === "json5") {
    try {
      raw = JSON5.parse(text);
    } catch (err) {
      throw new InvalidDefinitionError(`Could not parse JSON5: ${(err as Error).message}`);
    }
  } else {
    let json5Err: Error;
    try {
      raw = JSON5.parse(text);
    } catch (err) {
      json5Err = err as Error;
      try {
        raw = YAML.parse(text);
      } catch (yamlErr) {
        throw new InvalidDefinitionError(
          `Could not parse definition file as JSON5 (${json5Err.message}) or YAML (${(yamlErr as Error).message})`,
        );
      }
    }
  }
  return validateDefinition(raw);
}

export function loadDefinition(path: string): FitDefinition {
  return parseDefinition(readFileSync(path, "utf8"), detectDefinitionFormat(path));
}

export function isDefinitionUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function basenameFromUrl(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts.at(-1) ?? "definition.json5";
  } catch {
    return "definition.json5";
  }
}

/** Stable local cache path for a URL: ~/.fit-cli/url-cache/<12-char-hash>/<basename> */
export function localPathForUrl(url: string, home: string = homedir()): string {
  const slug = createHash("sha256").update(url).digest("hex").slice(0, 12);
  return join(home, ".fit-cli", "url-cache", slug, basenameFromUrl(url));
}

/**
 * Fetch a definition file from a URL, write it to a stable local cache path, and
 * return that path. The stable path means resume state written next to it can be
 * found again when the same URL is passed to a later `--resume-at` invocation.
 */
export async function cacheDefinition(url: string): Promise<string> {
  let text: string;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new InvalidDefinitionError(
        `Failed to fetch definition from ${url}: HTTP ${response.status} ${response.statusText}`,
      );
    }
    text = await response.text();
  } catch (err) {
    if (err instanceof InvalidDefinitionError) throw err;
    throw new InvalidDefinitionError(`Failed to fetch definition from ${url}: ${(err as Error).message}`);
  }
  const localPath = localPathForUrl(url);
  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, text, "utf8");
  return localPath;
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
  npm run definition -- validate <file.json5>

Direct invocation (for debugging):
  npx tsx src/fit/shared/definition/parse-definition.ts <file.json5>
  npx tsx src/fit/shared/definition/parse-definition.ts --help

Both .json5 and .yaml definition files are accepted.
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
