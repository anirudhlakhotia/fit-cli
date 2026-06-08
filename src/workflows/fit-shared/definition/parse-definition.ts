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
} from "../../cluster/cluster-create/cluster-exists-policy.js";
import type { CbdinoclusterDef } from "../../cluster/cluster-create/build-cluster-def.js";
import {
  CURRENT_FIT_DEFINITION_VERSION,
  FIT_CYCLE_TYPES,
  FIT_DEFINITION_TYPE,
  SITUATIONAL_DATABASE_MODES,
  type CbdinoclusterInitSetup,
  type CbdinoclusterSetup,
  type ClusterSetup,
  type ClusterTls,
  type ConnectionClusterSetup,
  type DefinitionTests,
  type FitConfigPiece,
  type FitCycle,
  type FitDefinition,
  type FunctionalCycle,
  type FunctionalIteration,
  type IterationSetup,
  type PerformerSetup,
  type RuntimeSection,
  type SharedSetup,
  type SituationalCycle,
  type SituationalDatabaseMode,
  type SituationalDatabaseSetup,
  type SituationalIteration,
  type SituationalSection,
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
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
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
  const record = requireRecord(value, path);
  return validateJsonLike(record, path) as FitConfigPiece;
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
    throw new InvalidDefinitionError(
      `"${path}" must be empty; put clusterAccess fields under cycle iterations' fitConfig instead.`,
    );
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
    throw new InvalidDefinitionError(
      `"${path}.services" must be a non-empty list of service names; got ${JSON.stringify(services)}`,
    );
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
  return {
    config: validateFitConfig(record.config, `${path}.config`),
  };
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
        `"${path}.onClusterExists" must be one of ${CLUSTER_EXISTS_POLICIES.join(", ")} when present; ` +
          `got ${JSON.stringify(record.onClusterExists)}`,
      );
    }
    cbdinocluster.onClusterExists = record.onClusterExists;
  }
  if (record.deployer !== undefined) {
    cbdinocluster.deployer = requireString(record, "deployer", `${path}.deployer`);
  }
  return cbdinocluster;
}

function validateCluster(value: unknown, path: string): ClusterSetup {
  const record = requireRecord(value, path);
  const cluster: ClusterSetup = {};
  if (record.connection !== undefined) {
    cluster.connection = validateConnection(record.connection, `${path}.connection`);
  }
  if (record.useExisting !== undefined) {
    cluster.useExisting = validateUseExisting(record.useExisting, `${path}.useExisting`);
  }
  if (record.cbdinocluster !== undefined) {
    cluster.cbdinocluster = validateCbdinocluster(record.cbdinocluster, `${path}.cbdinocluster`);
  }
  const configuredModes = [cluster.connection, cluster.useExisting, cluster.cbdinocluster].filter(
    (mode) => mode !== undefined,
  );
  if (configuredModes.length !== 1) {
    throw new InvalidDefinitionError(
      `"${path}" must have exactly one of "connection", "useExisting", or "cbdinocluster".`,
    );
  }
  return cluster;
}

function validateRepos(value: unknown): SharedSetup["repos"] {
  const record = requireRecord(value, "setup.repos");
  const repos: NonNullable<SharedSetup["repos"]> = {};
  if (record["transactions-fit-performer"] !== undefined) {
    const fitPerformer = requireRecord(
      record["transactions-fit-performer"],
      "setup.repos.transactions-fit-performer",
    );
    repos["transactions-fit-performer"] = {
      ...(fitPerformer.gerritRef !== undefined
        ? {
            gerritRef: requireString(
              fitPerformer,
              "gerritRef",
              "setup.repos.transactions-fit-performer.gerritRef",
            ),
          }
        : {}),
    };
  }
  return repos;
}

function isPortInUsePolicy(value: unknown): value is PortInUsePolicy {
  return isString(value) && (PORT_IN_USE_POLICIES as readonly string[]).includes(value);
}

function validatePerformer(value: unknown, path: string): PerformerSetup {
  const record = requireRecord(value, path);
  const performer: PerformerSetup = {
    sdk: requireString(record, "sdk", `${path}.sdk`) as PerformerSetup["sdk"],
  };
  if (record.port !== undefined) {
    if (typeof record.port !== "number" || !Number.isInteger(record.port) || record.port <= 0) {
      throw new InvalidDefinitionError(
        `"${path}.port" must be a positive integer when present; got ${JSON.stringify(record.port)}`,
      );
    }
    performer.port = record.port;
  }
  if (record.version !== undefined) {
    performer.version = requireString(record, "version", `${path}.version`);
  }
  if (record.onPortInUse !== undefined) {
    if (!isPortInUsePolicy(record.onPortInUse)) {
      throw new InvalidDefinitionError(
        `"${path}.onPortInUse" must be one of ${PORT_IN_USE_POLICIES.join(", ")} when present; ` +
          `got ${JSON.stringify(record.onPortInUse)}`,
      );
    }
    performer.onPortInUse = record.onPortInUse;
  }
  return performer;
}

function validateIterationSetup(value: unknown, path: string): IterationSetup {
  const record = requireRecord(value, path);
  if (record.performer === undefined) {
    throw new InvalidDefinitionError(`Missing required field: ${path}.performer`);
  }
  return { performer: validatePerformer(record.performer, `${path}.performer`) };
}

function validateSharedSetup(value: unknown): SharedSetup {
  const record = requireRecord(value, "setup");
  const setup: SharedSetup = {};
  if (record.cluster !== undefined) {
    throw new InvalidDefinitionError(`"setup.cluster" is no longer supported; move cluster setup under each cycle.`);
  }
  if (record.repos !== undefined) {
    setup.repos = validateRepos(record.repos);
  }
  return setup;
}

function validateTests(value: unknown): DefinitionTests {
  if (value === undefined || value === "all") {
    return "all";
  }
  if (isStringArray(value)) {
    if (value.length === 0) {
      throw new InvalidDefinitionError(`"runtime.tests" must be "all" or a non-empty list of test class names`);
    }
    return value;
  }
  throw new InvalidDefinitionError(
    `"runtime.tests" must be "all" or a list of test class names; got ${JSON.stringify(value)}`,
  );
}

function validateRuntime(value: unknown, path: string): RuntimeSection {
  const record = requireRecord(value, path);
  const runtime: RuntimeSection = { tests: validateTests(record.tests) };
  if (record.excludedGroups !== undefined) {
    if (!isStringArray(record.excludedGroups)) {
      throw new InvalidDefinitionError(
        `"${path}.excludedGroups" must be a list of strings when present; got ${JSON.stringify(record.excludedGroups)}`,
      );
    }
    runtime.excludedGroups = record.excludedGroups;
  }
  return runtime;
}

function isSituationalDatabaseMode(value: unknown): value is SituationalDatabaseMode {
  return isString(value) && (SITUATIONAL_DATABASE_MODES as readonly string[]).includes(value);
}

function validateSituationalDatabase(value: unknown, path: string): SituationalDatabaseSetup {
  const record = requireRecord(value, path);
  if (!isSituationalDatabaseMode(record.mode)) {
    throw new InvalidDefinitionError(
      `"${path}.mode" must be one of ${SITUATIONAL_DATABASE_MODES.join(", ")}; got ${JSON.stringify(record.mode)}`,
    );
  }
  return { mode: record.mode };
}

function validateSituationalSection(value: unknown, path: string): SituationalSection {
  const record = requireRecord(value, path);
  if (record.cbdino !== undefined) {
    throw new InvalidDefinitionError(`"${path}.cbdino" is no longer supported; situational cycles create their own cluster.`);
  }
  if (record.database === undefined) {
    throw new InvalidDefinitionError(`Missing required field: ${path}.database`);
  }
  return {
    database: validateSituationalDatabase(record.database, `${path}.database`),
  };
}

function validateFunctionalIteration(value: unknown, path: string): FunctionalIteration {
  const record = requireRecord(value, path);
  if (record.type !== undefined) {
    throw new InvalidDefinitionError(`"${path}.type" is no longer supported; put "type" on the enclosing cycle.`);
  }
  if (record.situational !== undefined) {
    throw new InvalidDefinitionError(`"${path}.situational" is only allowed inside a situational cycle.`);
  }
  return {
    ...(record.fitConfig !== undefined ? { fitConfig: validateFitConfig(record.fitConfig, `${path}.fitConfig`) } : {}),
    setup: validateIterationSetup(record.setup, `${path}.setup`),
    runtime: validateRuntime(record.runtime ?? {}, `${path}.runtime`),
  };
}

function validateSituationalIteration(value: unknown, path: string): SituationalIteration {
  const record = requireRecord(value, path);
  if (record.type !== undefined) {
    throw new InvalidDefinitionError(`"${path}.type" is no longer supported; put "type" on the enclosing cycle.`);
  }
  if (record.situational === undefined) {
    throw new InvalidDefinitionError(`Missing required field: ${path}.situational`);
  }
  return {
    ...(record.fitConfig !== undefined ? { fitConfig: validateFitConfig(record.fitConfig, `${path}.fitConfig`) } : {}),
    setup: validateIterationSetup(record.setup, `${path}.setup`),
    situational: validateSituationalSection(record.situational, `${path}.situational`),
    runtime: validateRuntime(record.runtime ?? {}, `${path}.runtime`),
  };
}

function validateCycleType(value: unknown): FitCycle["type"] {
  if (!isString(value) || !FIT_CYCLE_TYPES.includes(value as FitCycle["type"])) {
    throw new InvalidDefinitionError(
      `"cycles[].type" must be one of ${FIT_CYCLE_TYPES.join(", ")}; got ${JSON.stringify(value)}`,
    );
  }
  return value as FitCycle["type"];
}

function validateFunctionalCycle(record: Record<string, unknown>, path: string): FunctionalCycle {
  if (record.cluster === undefined) {
    throw new InvalidDefinitionError(`Missing required field: ${path}.cluster`);
  }
  if (!Array.isArray(record.iterations) || record.iterations.length === 0) {
    throw new InvalidDefinitionError(`"${path}.iterations" must contain at least one iteration.`);
  }
  return {
    type: "functional",
    cluster: validateCluster(record.cluster, `${path}.cluster`),
    iterations: record.iterations.map((iteration, index) =>
      validateFunctionalIteration(iteration, `${path}.iterations[${index}]`),
    ),
  };
}

function validateSituationalCycle(record: Record<string, unknown>, path: string): SituationalCycle {
  if (record.cluster !== undefined) {
    throw new InvalidDefinitionError(`"${path}.cluster" is not allowed on a situational cycle.`);
  }
  if (!Array.isArray(record.iterations) || record.iterations.length === 0) {
    throw new InvalidDefinitionError(`"${path}.iterations" must contain at least one iteration.`);
  }
  return {
    type: "situational",
    iterations: record.iterations.map((iteration, index) =>
      validateSituationalIteration(iteration, `${path}.iterations[${index}]`),
    ),
  };
}

function validateCycle(value: unknown, index: number): FitCycle {
  const path = `cycles[${index}]`;
  const record = requireRecord(value, path);
  const type = validateCycleType(record.type);
  return type === "functional"
    ? validateFunctionalCycle(record, path)
    : validateSituationalCycle(record, path);
}

function validateVersion(version: unknown): number {
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new InvalidDefinitionError(
      `Missing or invalid "version" (expected an integer); got ${JSON.stringify(version)}`,
    );
  }
  if (version > CURRENT_FIT_DEFINITION_VERSION) {
    throw new UnsupportedDefinitionVersionError(
      `This definition file is version ${version}, but this fit-cli only understands up to version ` +
        `${CURRENT_FIT_DEFINITION_VERSION}. Update fit-cli (git pull) to run it.`,
    );
  }
  if (version < CURRENT_FIT_DEFINITION_VERSION) {
    throw new UnsupportedDefinitionVersionError(
      `Definition file version ${version} is no longer supported. Recreate it as version ` +
        `${CURRENT_FIT_DEFINITION_VERSION}.`,
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
    throw new InvalidDefinitionError(
      `Expected "type: ${FIT_DEFINITION_TYPE}"; got ${JSON.stringify(raw.type)}`,
    );
  }

  if (raw.iterations !== undefined) {
    throw new InvalidDefinitionError(`"iterations" is no longer supported; use top-level "cycles" instead.`);
  }
  if (!Array.isArray(raw.cycles)) {
    throw new InvalidDefinitionError(`"cycles" must be a list; got ${JSON.stringify(raw.cycles)}`);
  }
  if (raw.cycles.length === 0) {
    throw new InvalidDefinitionError(`"cycles" must contain at least one cycle.`);
  }

  return {
    version: CURRENT_FIT_DEFINITION_VERSION,
    type: FIT_DEFINITION_TYPE,
    ...(raw.setup !== undefined ? { setup: validateSharedSetup(raw.setup) } : {}),
    cycles: raw.cycles.map(validateCycle),
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

const HELP = `Validate a fit definition file and print the parsed result.

Usage:
  npx tsx src/workflows/fit-shared/definition/parse-definition.ts <file.yaml>
  npx tsx src/workflows/fit-shared/definition/parse-definition.ts --help

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
    const iterationCount = definition.cycles.reduce((total, cycle) => total + cycle.iterations.length, 0);
    console.log(
      `✓ Valid ${FIT_DEFINITION_TYPE} definition (version ${definition.version}, ` +
        `${definition.cycles.length} cycle(s), ${iterationCount} iteration(s)).`,
    );
    console.log(JSON.stringify(definition, null, 2));
    return Promise.resolve();
  });
}
