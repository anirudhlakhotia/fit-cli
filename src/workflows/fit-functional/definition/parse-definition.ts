/**
 * Parse and validate a `fit` definition file.
 */
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { SDKS } from "../../../util/sdk/sdks.js";
import { PORT_IN_USE_POLICIES, type PortInUsePolicy } from "../../performers/performer-port.js";
import {
  CLUSTER_EXISTS_POLICIES,
  type ClusterExistsPolicy,
} from "../../cluster/cluster-create/cluster-exists-policy.js";
import type { CbdinoclusterDef } from "../../cluster/cluster-create/build-cluster-def.js";
import {
  CURRENT_FIT_DEFINITION_VERSION,
  FIT_DEFINITION_TYPE,
  FIT_ITERATION_TYPES,
  type CbdinoclusterSetup,
  type ConnectionClusterSetup,
  type ClusterSetup,
  type ClusterTls,
  type DefinitionTests,
  type FitConfigPiece,
  type FitDefinition,
  type FunctionalIteration,
  type IterationSetup,
  type PerformerSetup,
  type RuntimeSection,
  type SharedSetup,
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

function validateConnection(value: unknown): ConnectionClusterSetup {
  const record = requireRecord(value, "setup.cluster.connection");
  return {
    connectionString: requireString(record, "connectionString", "setup.cluster.connection.connectionString"),
    username: requireString(record, "username", "setup.cluster.connection.username"),
    password: requireString(record, "password", "setup.cluster.connection.password"),
    ...(record.tls !== undefined ? { tls: validateTls(record.tls, "setup.cluster.connection.tls") } : {}),
  };
}

function validateUseExisting(value: unknown): UseExistingClusterSetup {
  if (value === null || value === undefined) {
    return {};
  }
  const record = requireRecord(value, "setup.cluster.useExisting");
  if (Object.keys(record).length > 0) {
    throw new InvalidDefinitionError(
      `"setup.cluster.useExisting" must be empty; put clusterAccess fields under ` +
        `"iterations[].fitConfig" instead.`,
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

function validateCbdinoclusterDef(value: unknown): CbdinoclusterDef {
  const record = requireRecord(value, "setup.cluster.cbdinocluster.config");
  if (!Array.isArray(record.nodes) || record.nodes.length === 0) {
    throw new InvalidDefinitionError(
      `"setup.cluster.cbdinocluster.config.nodes" must be a non-empty list; got ${JSON.stringify(record.nodes)}`,
    );
  }
  const def: CbdinoclusterDef = {
    nodes: record.nodes.map((node, index) =>
      validateClusterNode(node, `setup.cluster.cbdinocluster.config.nodes[${index}]`),
    ),
  };
  if (record.cao !== undefined) {
    const cao = requireRecord(record.cao, "setup.cluster.cbdinocluster.config.cao");
    def.cao = {
      "operator-version": requireString(cao, "operator-version", "setup.cluster.cbdinocluster.config.cao.operator-version"),
      "gateway-version": requireString(cao, "gateway-version", "setup.cluster.cbdinocluster.config.cao.gateway-version"),
    };
  }
  return def;
}

function validateCbdinocluster(value: unknown): CbdinoclusterSetup {
  const record = requireRecord(value, "setup.cluster.cbdinocluster");
  if (record.config === undefined) {
    throw new InvalidDefinitionError("Missing required field: setup.cluster.cbdinocluster.config");
  }
  const cbdinocluster: CbdinoclusterSetup = { config: validateCbdinoclusterDef(record.config) };
  if (record.onClusterExists !== undefined) {
    if (!isClusterExistsPolicy(record.onClusterExists)) {
      throw new InvalidDefinitionError(
        `"setup.cluster.cbdinocluster.onClusterExists" must be one of ${CLUSTER_EXISTS_POLICIES.join(", ")} ` +
          `when present; got ${JSON.stringify(record.onClusterExists)}`,
      );
    }
    cbdinocluster.onClusterExists = record.onClusterExists;
  }
  if (record.deployer !== undefined) {
    cbdinocluster.deployer = requireString(record, "deployer", "setup.cluster.cbdinocluster.deployer");
  }
  return cbdinocluster;
}

function validateCluster(value: unknown): ClusterSetup {
  const record = requireRecord(value, "setup.cluster");
  const cluster: ClusterSetup = {};
  if (record.connection !== undefined) {
    cluster.connection = validateConnection(record.connection);
  }
  if (record.useExisting !== undefined) {
    cluster.useExisting = validateUseExisting(record.useExisting);
  }
  if (record.cbdinocluster !== undefined) {
    cluster.cbdinocluster = validateCbdinocluster(record.cbdinocluster);
  }
  const configuredModes = [cluster.connection, cluster.useExisting, cluster.cbdinocluster].filter(
    (mode) => mode !== undefined,
  );
  if (configuredModes.length > 1) {
    throw new InvalidDefinitionError(
      `"setup.cluster" must have at most one of "connection", "useExisting", or "cbdinocluster".`,
    );
  }
  return cluster;
}

function isPortInUsePolicy(value: unknown): value is PortInUsePolicy {
  return isString(value) && (PORT_IN_USE_POLICIES as readonly string[]).includes(value);
}

function validatePerformer(value: unknown): PerformerSetup {
  const record = requireRecord(value, "setup.performer");
  const performer: PerformerSetup = {
    sdk: requireString(record, "sdk", "setup.performer.sdk") as PerformerSetup["sdk"],
  };
  if (record.port !== undefined) {
    if (typeof record.port !== "number" || !Number.isInteger(record.port) || record.port <= 0) {
      throw new InvalidDefinitionError(
        `"setup.performer.port" must be a positive integer when present; got ${JSON.stringify(record.port)}`,
      );
    }
    performer.port = record.port;
  }
  if (record.version !== undefined) {
    performer.version = requireString(record, "version", "setup.performer.version");
  }
  if (record.gerritRef !== undefined) {
    performer.gerritRef = requireString(record, "gerritRef", "setup.performer.gerritRef");
  }
  if (record.onPortInUse !== undefined) {
    if (!isPortInUsePolicy(record.onPortInUse)) {
      throw new InvalidDefinitionError(
        `"setup.performer.onPortInUse" must be one of ${PORT_IN_USE_POLICIES.join(", ")} when present; ` +
          `got ${JSON.stringify(record.onPortInUse)}`,
      );
    }
    performer.onPortInUse = record.onPortInUse;
  }
  return performer;
}

function validateIterationSetup(value: unknown): IterationSetup {
  const record = requireRecord(value, "setup");
  return { performer: validatePerformer(record.performer) };
}

function validateSharedSetup(value: unknown): SharedSetup {
  const record = requireRecord(value, "setup");
  const setup: SharedSetup = {};
  if (record.cluster !== undefined) {
    setup.cluster = validateCluster(record.cluster);
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

function validateRuntime(value: unknown): RuntimeSection {
  const record = requireRecord(value, "runtime");
  const runtime: RuntimeSection = { tests: validateTests(record.tests) };
  if (record.excludedGroups !== undefined) {
    if (!isStringArray(record.excludedGroups)) {
      throw new InvalidDefinitionError(
        `"runtime.excludedGroups" must be a list of strings when present; got ${JSON.stringify(record.excludedGroups)}`,
      );
    }
    runtime.excludedGroups = record.excludedGroups;
  }
  return runtime;
}

function validateFunctionalIteration(value: unknown): FunctionalIteration {
  const record = requireRecord(value, "iterations[]");
  const type = requireString(record, "type", "iterations[].type");
  if (!FIT_ITERATION_TYPES.includes(type as (typeof FIT_ITERATION_TYPES)[number])) {
    throw new InvalidDefinitionError(
      `"iterations[].type" must be one of ${FIT_ITERATION_TYPES.join(", ")}; got ${JSON.stringify(type)}`,
    );
  }
  return {
    type: "functional",
    ...(record.fitConfig !== undefined ? { fitConfig: validateFitConfig(record.fitConfig, "iterations[].fitConfig") } : {}),
    setup: validateIterationSetup(record.setup),
    runtime: validateRuntime(record.runtime),
  };
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

  if (!Array.isArray(raw.iterations)) {
    throw new InvalidDefinitionError(`"iterations" must be a list; got ${JSON.stringify(raw.iterations)}`);
  }
  if (raw.iterations.length === 0) {
    throw new InvalidDefinitionError(`"iterations" must contain at least one iteration.`);
  }

  return {
    version: CURRENT_FIT_DEFINITION_VERSION,
    type: FIT_DEFINITION_TYPE,
    ...(raw.setup !== undefined ? { setup: validateSharedSetup(raw.setup) } : {}),
    iterations: raw.iterations.map(validateFunctionalIteration),
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
  npx tsx src/workflows/fit-functional/definition/parse-definition.ts <file.yaml>
  npx tsx src/workflows/fit-functional/definition/parse-definition.ts --help

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
      `✓ Valid ${FIT_DEFINITION_TYPE} definition (version ${definition.version}, ` +
        `${definition.iterations.length} iteration(s)).`,
    );
    console.log(`Known SDK values: ${SDKS.map((sdk) => sdk.value).join(", ")}\n`);
    console.log(JSON.stringify(definition, null, 2));
    return Promise.resolve();
  });
}
