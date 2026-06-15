/**
 * Loader for `environments.json5` (repo root): the non-secret, per-environment
 * settings selected from a definition file. Two axes:
 *   - capella: control-plane endpoint + org id per Capella environment (dev/stage/…)
 *   - results: the hosted results host per results environment (dev/prod/…), which
 *     serves both the Postgres DB and the results UI.
 *
 * Secrets are deliberately NOT here — they come from the environment at run time
 * (see resolveCapellaConfig / resolveResultsDbCredentials). A `null` value means the
 * block exists but hasn't been provisioned yet; selecting it fails fast.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";

export interface CapellaEnvironment {
  endpoint?: string | null;
  oid?: string | null;
  /** The (shared, non-secret) Capella account username for this environment. */
  username?: string | null;
  /** AWS Secrets Manager id/ARN holding { password } for this Capella environment. */
  secretId?: string | null;
}

export interface ResultsEnvironment {
  host?: string | null;
  /** AWS Secrets Manager id/ARN holding { password } for this results environment. */
  secretId?: string | null;
}

export interface EnvironmentsFile {
  capella: Record<string, CapellaEnvironment>;
  results: Record<string, ResultsEnvironment>;
}

/** Absolute path to the repo-root environments file (this module lives at src/fit/util/). */
export const DEFAULT_ENVIRONMENTS_PATH = fileURLToPath(new URL("../../../environments.json5", import.meta.url));

let cached: EnvironmentsFile | undefined;

/** Load and validate the environments file. Cached when reading the default path. */
export function loadEnvironments(path: string = DEFAULT_ENVIRONMENTS_PATH): EnvironmentsFile {
  if (path === DEFAULT_ENVIRONMENTS_PATH && cached) return cached;
  const parsed = JSON5.parse<EnvironmentsFile>(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || typeof parsed.capella !== "object" || typeof parsed.results !== "object") {
    throw new Error(`Environments file at ${path} must define "capella" and "results" sections.`);
  }
  if (path === DEFAULT_ENVIRONMENTS_PATH) cached = parsed;
  return parsed;
}

/** The configured Capella environment names (e.g. ["dev", "stage"]). */
export function capellaEnvironmentNames(environments: EnvironmentsFile = loadEnvironments()): string[] {
  return Object.keys(environments.capella);
}

/** The configured results environment names (e.g. ["dev", "prod"]). */
export function resultsEnvironmentNames(environments: EnvironmentsFile = loadEnvironments()): string[] {
  return Object.keys(environments.results);
}
