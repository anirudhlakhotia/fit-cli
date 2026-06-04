/**
 * Parse and validate a `fit-functional-tests` definition file. Pure logic — no
 * file IO — so the validation rules are easy to unit test (see
 * tests/parse-definition.test.ts).
 *
 * Validation here is structural: it checks the file is the right type/version
 * and that every field has a usable shape. Semantic checks that need the rest of
 * the tool (is "java" a known SDK? is the connection string one we support?)
 * live in resolve-definition.ts, so this stays a self-contained, dependency-light
 * gate.
 *
 * Versioning: older major versions are upgraded in-memory to the current version
 * by {@link upgradeDefinitionRaw} before validation, so callers always get the
 * latest shape. There's only one version today; the upgrade seam is ready for
 * when that changes (see the README "Definition files" section).
 *
 * Run on its own (validate a file and print the parsed result as JSON):
 *   npx tsx src/workflows/fit-functional/definition/parse-definition.ts <file.yaml>
 *   npx tsx src/workflows/fit-functional/definition/parse-definition.ts --help
 */
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { SDKS } from "../../../util/sdk/sdks.js";
import {
  CURRENT_FIT_FUNCTIONAL_VERSION,
  FIT_FUNCTIONAL_DEFINITION_TYPE,
  type DefinitionCluster,
  type DefinitionTests,
  type FitFunctionalDefinition,
} from "./types.js";

/**
 * Thrown when a file's version can't be used by this build — either newer than
 * we understand, or an old one we have no upgrade path for. The message tells the
 * user how to get unstuck.
 */
export class UnsupportedDefinitionVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedDefinitionVersionError";
  }
}

/** Thrown when a file is the right type/version but malformed. */
export class InvalidDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDefinitionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireField<T>(record: Record<string, unknown>, key: string, check: (v: unknown) => v is T): T {
  if (!(key in record)) {
    throw new InvalidDefinitionError(`Missing required field: ${key}`);
  }
  const value = record[key];
  if (!check(value)) {
    throw new InvalidDefinitionError(`Field "${key}" has the wrong type: ${JSON.stringify(value)}`);
  }
  return value;
}

const isString = (v: unknown): v is string => typeof v === "string";
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

/** Validate the `tls` sub-field of a cluster against {@link TlsConfig}. */
function validateTls(value: unknown): DefinitionCluster["tls"] {
  if (value === null || value === undefined) {
    return null;
  }
  if (isRecord(value)) {
    if (value.insecure === true) {
      return { insecure: true };
    }
    if (isString(value.certPath)) {
      return { certPath: value.certPath };
    }
  }
  throw new InvalidDefinitionError(
    `cluster.tls must be null, { insecure: true }, or { certPath: <path> }; got ${JSON.stringify(value)}`,
  );
}

function validateCluster(value: unknown): DefinitionCluster {
  if (!isRecord(value)) {
    throw new InvalidDefinitionError(`Field "cluster" must be a mapping; got ${JSON.stringify(value)}`);
  }
  return {
    connectionString: requireField(value, "connectionString", isString),
    username: requireField(value, "username", isString),
    password: requireField(value, "password", isString),
    tls: validateTls(value.tls),
  };
}

function validateTests(value: unknown): DefinitionTests {
  if (value === undefined || value === "all") {
    return "all";
  }
  if (isStringArray(value)) {
    if (value.length === 0) {
      throw new InvalidDefinitionError(`"tests" must be "all" or a non-empty list of test class names`);
    }
    return value;
  }
  throw new InvalidDefinitionError(
    `"tests" must be "all" or a list of test class names; got ${JSON.stringify(value)}`,
  );
}

/**
 * Bring a raw, parsed object up to the current major version. Today every
 * supported file is already version {@link CURRENT_FIT_FUNCTIONAL_VERSION}, so
 * this only gatekeeps the version; future major bumps add a `case` per old
 * version that rewrites the object one step forward, chaining up to current.
 */
export function upgradeDefinitionRaw(raw: Record<string, unknown>): Record<string, unknown> {
  const { version } = raw;
  if (version === CURRENT_FIT_FUNCTIONAL_VERSION) {
    return raw;
  }
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new InvalidDefinitionError(
      `Missing or invalid "version" (expected an integer); got ${JSON.stringify(version)}`,
    );
  }
  if (version > CURRENT_FIT_FUNCTIONAL_VERSION) {
    throw new UnsupportedDefinitionVersionError(
      `This definition file is version ${version}, but this fit-cli only understands up to version ` +
        `${CURRENT_FIT_FUNCTIONAL_VERSION}. Update fit-cli (git pull) to run it.`,
    );
  }
  // version < current with no upgrader registered for it.
  throw new UnsupportedDefinitionVersionError(
    `Definition file version ${version} can no longer be upgraded automatically to version ` +
      `${CURRENT_FIT_FUNCTIONAL_VERSION}. Recreate it from a recent guided run and tweak the generated YAML.`,
  );
}

/** Validate an already-upgraded raw object into a typed definition. */
export function validateDefinition(raw: unknown): FitFunctionalDefinition {
  if (!isRecord(raw)) {
    throw new InvalidDefinitionError("Definition file must be a YAML mapping at the top level.");
  }

  const type = raw.type;
  if (type !== FIT_FUNCTIONAL_DEFINITION_TYPE) {
    throw new InvalidDefinitionError(
      `Expected "type: ${FIT_FUNCTIONAL_DEFINITION_TYPE}"; got ${JSON.stringify(type)}`,
    );
  }

  const upgraded = upgradeDefinitionRaw(raw);

  const sdk = requireField(upgraded, "sdk", isString);
  const performerVersion = upgraded.performerVersion;
  if (performerVersion !== undefined && !isString(performerVersion)) {
    throw new InvalidDefinitionError(
      `"performerVersion" must be a string when present; got ${JSON.stringify(performerVersion)}`,
    );
  }
  const excludedGroups = upgraded.excludedGroups;
  if (excludedGroups !== undefined && !isStringArray(excludedGroups)) {
    throw new InvalidDefinitionError(
      `"excludedGroups" must be a list of strings when present; got ${JSON.stringify(excludedGroups)}`,
    );
  }

  return {
    version: CURRENT_FIT_FUNCTIONAL_VERSION,
    type: FIT_FUNCTIONAL_DEFINITION_TYPE,
    // Structural check only — that this names a real SDK is resolve-definition's job.
    sdk: sdk as FitFunctionalDefinition["sdk"],
    ...(performerVersion !== undefined ? { performerVersion } : {}),
    cluster: validateCluster(upgraded.cluster),
    tests: validateTests(upgraded.tests),
    ...(excludedGroups !== undefined ? { excludedGroups } : {}),
  };
}

/** Parse YAML text into a validated, current-version definition. */
export function parseDefinition(text: string): FitFunctionalDefinition {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    throw new InvalidDefinitionError(`Could not parse YAML: ${(err as Error).message}`);
  }
  return validateDefinition(raw);
}

/** Read and parse a definition file from disk. */
export function loadDefinition(path: string): FitFunctionalDefinition {
  return parseDefinition(readFileSync(path, "utf8"));
}

const HELP = `Validate a fit-functional-tests definition file and print the parsed result.

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
    console.log(`✓ Valid ${FIT_FUNCTIONAL_DEFINITION_TYPE} definition (version ${definition.version}).`);
    console.log(`Known SDK values: ${SDKS.map((sdk) => sdk.value).join(", ")}\n`);
    console.log(JSON.stringify(definition, null, 2));
    return Promise.resolve();
  });
}
