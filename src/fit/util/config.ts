import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import JSON5 from "json5";
import YAML from "yaml";
import { confirm } from "../../util/non-fit/prompts.js";

export const FIT_CLI_CONFIG_VERSION = 1;
export const FIT_CLI_CONFIG_DIRNAME = ".fit-cli";
export const FIT_CLI_CONFIG_BASENAME = "config.json5";
const LEGACY_CONFIG_YAML_BASENAME = "config.yaml";

/**
 * The kinds of testing a default instance type can be chosen for. These are the
 * "purposes" a cloud instance is provisioned for; each can want a different
 * machine size (perf needs the beefiest box, functional the least). `perf` has
 * no run type in the definition schema yet — its default is carried here ready
 * for when one lands.
 */
export const CLOUD_INSTANCE_PURPOSES = ["functional", "situational", "perf"] as const;
export type CloudInstancePurpose = (typeof CLOUD_INSTANCE_PURPOSES)[number];

/** Cloud service providers fit-cli can provision instances on. Only AWS today. */
export const CLOUD_PROVIDERS = ["aws"] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

/** Baked-in default instance type per purpose, used when the config omits one. */
export const DEFAULT_CLOUD_INSTANCE_TYPES: Record<CloudProvider, Record<CloudInstancePurpose, string>> = {
  aws: {
    functional: "c5.xlarge",
    situational: "c5.xlarge",
    perf: "c5.4xlarge",
  },
};

export type FitCliInstanceTypes = Partial<Record<CloudInstancePurpose, string>>;

export interface FitCliAwsConfig {
  profile?: string;
  /** Default EC2 instance type per testing purpose; missing purposes fall back to the baked default. */
  instanceTypes?: FitCliInstanceTypes;
}

/**
 * Per-CSP cloud settings. Today only `aws` exists, but instance types are keyed
 * by purpose under each provider so a future GCP/Azure section can carry its own
 * sizes without restructuring.
 */
export interface FitCliCloudConfig {
  aws?: FitCliAwsConfig;
}

export interface FitCliGithubConfig {
  /** GitHub username (needed so cbdinocluster can pull from GHCR). */
  user?: string;
  /** Personal access token used to clone the private FIT repos and pull GHCR images. */
  token?: string;
}

export interface FitCliResultsDbConfig {
  /** Readonly password for the hosted results database (secret). */
  password?: string;
  /** Optional username override; defaults to the hosted database's default user. */
  username?: string;
}

/** The formats a generated definition file can be written in. */
export const OUTPUT_FORMATS = ["json5", "yaml"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Baked-in default output format, used when the config doesn't set one. */
export const DEFAULT_OUTPUT_FORMAT: OutputFormat = "json5";

/**
 * Top-level `output` settings: how fit-cli renders things it produces, plus the
 * hosted results database it writes test results to. `resultsDb` lives here (not
 * at the top level) so everything output-related is grouped under one key.
 */
export interface FitCliOutputConfig {
  /** Default format generated definition files are written in (json5 or yaml). */
  format?: OutputFormat;
  /** Readonly credentials for the hosted results database. */
  resultsDb?: FitCliResultsDbConfig;
}

export interface FitCliGerritConfig {
  /** Gerrit username. Defaults to github.user when not set. */
  user?: string;
  /** Path to the SSH private key registered with Gerrit. */
  sshKeyPath?: string;
}

/**
 * Capella control-plane settings the situational cbdinocluster cloud deployer
 * authenticates with. fit-cli forwards these to the remote box as `CAPELLA_*`
 * environment variables so `cbdinocluster init --auto` bakes them into
 * `~/.cbdinocluster` (see resolveCapellaConfig / uploadRemoteCapellaConfig).
 *
 * Only `username` is per-user and has no default; the rest default to the
 * well-known values in {@link DEFAULT_CAPELLA_SETTINGS} and rarely need changing.
 */
export interface FitCliCapellaConfig {
  /** Capella account the deployer logs in as (env: CAPELLA_USER). No default — required for situational runs. */
  username?: string;
  /** Capella control-plane endpoint (env: CAPELLA_ENDPOINT). */
  endpoint?: string;
  /** Capella organization/tenant ID (env: CAPELLA_OID). */
  organizationId?: string;
  /** Capella account password (env: CAPELLA_PASS). Forwarded to the remote box as CAPELLA_PASS for cbdinocluster init. Saved in plaintext. */
  password?: string;
}

/** Hardcoded defaults for every Capella field except `username` (which is per-user). */
export const DEFAULT_CAPELLA_SETTINGS = {
  endpoint: "https://api.dev.nonprod-project-avengers.com",
  organizationId: "6af08c0a-8cab-4c1c-b257-b521575c16d0",
  password: "NotUsed",
} as const;

export interface FitCliConfig {
  version: 1;
  cloud?: FitCliCloudConfig;
  github?: FitCliGithubConfig;
  output?: FitCliOutputConfig;
  gerrit?: FitCliGerritConfig;
  capella?: FitCliCapellaConfig;
}

export interface FitCliConfigResult {
  loaded: boolean;
  path: string;
  config?: FitCliConfig;
}

export interface AppliedFitCliConfigResult extends FitCliConfigResult {
  applied: string[];
}

export interface EnsuredFitCliConfigResult extends AppliedFitCliConfigResult {
  created: boolean;
}

export interface EnsureFitCliConfigOptions {
  path?: string;
  env?: NodeJS.ProcessEnv;
  promptIfMissing?: boolean;
  promptId?: string;
  promptMessage?: string;
  confirmCreate?: () => Promise<boolean>;
  runInitWorkflow?: (path: string) => Promise<void>;
}

export class UnsupportedFitCliConfigVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFitCliConfigVersionError";
  }
}

export class InvalidFitCliConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFitCliConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(record: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new InvalidFitCliConfigError(`Field "${path}" has the wrong type: ${JSON.stringify(value)}`);
  }
  return value;
}

function compactRecord<T extends Record<string, string | undefined>>(record: T): Partial<T> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== "")) as Partial<T>;
}

function configEnvEntries(config: FitCliConfig): Record<string, string> {
  // Instance types are now per-purpose, so there's no single FIT_EC2_INSTANCE_TYPE
  // to export — runs resolve the right one via resolveCloudInstanceType().
  return compactRecord({
    AWS_PROFILE: config.cloud?.aws?.profile,
  });
}

/**
 * The default cloud instance type for a given testing purpose. Prefers the value
 * saved in the fit-cli config (`cloud.<csp>.instanceTypes.<purpose>`), then falls
 * back to the baked-in default. Loads the config itself when one isn't supplied.
 */
export function resolveCloudInstanceType(
  purpose: CloudInstancePurpose,
  options: { config?: FitCliConfig; path?: string; provider?: CloudProvider } = {},
): string {
  const provider = options.provider ?? "aws";
  const config = options.config ?? loadFitCliConfig(options.path).config;
  return config?.cloud?.[provider]?.instanceTypes?.[purpose] ?? DEFAULT_CLOUD_INSTANCE_TYPES[provider][purpose];
}

const promptedMissingConfigPaths = new Set<string>();

export function defaultFitCliConfigPath(home: string = homedir()): string {
  const json5Path = resolve(home, FIT_CLI_CONFIG_DIRNAME, FIT_CLI_CONFIG_BASENAME);
  // Fall back to legacy config.yaml if config.json5 does not exist yet.
  if (!existsSync(json5Path)) {
    const yamlPath = resolve(home, FIT_CLI_CONFIG_DIRNAME, LEGACY_CONFIG_YAML_BASENAME);
    if (existsSync(yamlPath)) {
      return yamlPath;
    }
  }
  return json5Path;
}

export function validateFitCliConfig(raw: unknown): FitCliConfig {
  if (!isRecord(raw)) {
    throw new InvalidFitCliConfigError("fit-cli config must be an object at the top level.");
  }

  const { version } = raw;
  if (version !== FIT_CLI_CONFIG_VERSION) {
    if (typeof version !== "number" || !Number.isInteger(version)) {
      throw new InvalidFitCliConfigError(
        `Missing or invalid "version" (expected an integer); got ${JSON.stringify(version)}`,
      );
    }
    if (version > FIT_CLI_CONFIG_VERSION) {
      throw new UnsupportedFitCliConfigVersionError(
        `This config file is version ${version}, but this fit-cli only understands up to version ${FIT_CLI_CONFIG_VERSION}. Update fit-cli and try again.`,
      );
    }
    throw new UnsupportedFitCliConfigVersionError(
      `Config file version ${version} is no longer supported. Recreate ${FIT_CLI_CONFIG_BASENAME} with \`npm run config -- edit\`.`,
    );
  }

  const cloudValue = raw.cloud;
  if (cloudValue !== undefined && !isRecord(cloudValue)) {
    throw new InvalidFitCliConfigError(`Field "cloud" must be a mapping; got ${JSON.stringify(cloudValue)}`);
  }

  const cloud = cloudValue ? validateCloudConfig(cloudValue) : undefined;

  const githubValue = raw.github;
  if (githubValue !== undefined && !isRecord(githubValue)) {
    throw new InvalidFitCliConfigError(`Field "github" must be a mapping; got ${JSON.stringify(githubValue)}`);
  }

  const github = githubValue
    ? compactRecord({
        user: readOptionalString(githubValue, "user", "github.user"),
        token: readOptionalString(githubValue, "token", "github.token"),
      })
    : undefined;

  const output = validateOutputConfig(raw.output, raw.resultsDb);

  const gerritValue = raw.gerrit;
  if (gerritValue !== undefined && !isRecord(gerritValue)) {
    throw new InvalidFitCliConfigError(`Field "gerrit" must be a mapping; got ${JSON.stringify(gerritValue)}`);
  }

  const gerrit = gerritValue
    ? compactRecord({
        user: readOptionalString(gerritValue, "user", "gerrit.user"),
        sshKeyPath: readOptionalString(gerritValue, "sshKeyPath", "gerrit.sshKeyPath"),
      })
    : undefined;

  const capellaValue = raw.capella;
  if (capellaValue !== undefined && !isRecord(capellaValue)) {
    throw new InvalidFitCliConfigError(`Field "capella" must be a mapping; got ${JSON.stringify(capellaValue)}`);
  }

  const capella = capellaValue
    ? compactRecord({
        username: readOptionalString(capellaValue, "username", "capella.username"),
        endpoint: readOptionalString(capellaValue, "endpoint", "capella.endpoint"),
        organizationId: readOptionalString(capellaValue, "organizationId", "capella.organizationId"),
        password: readOptionalString(capellaValue, "password", "capella.password"),
      })
    : undefined;

  return {
    version: FIT_CLI_CONFIG_VERSION,
    ...(cloud ? { cloud } : {}),
    ...(github && Object.keys(github).length > 0 ? { github } : {}),
    ...(output ? { output } : {}),
    ...(gerrit && Object.keys(gerrit).length > 0 ? { gerrit } : {}),
    ...(capella && Object.keys(capella).length > 0 ? { capella } : {}),
  };
}

/**
 * Validate and compact the `output` section. `format` must be one of
 * {@link OUTPUT_FORMATS}. The results-database credentials live here; for
 * backwards compatibility a `resultsDb` still found at the top level (the
 * pre-`output` layout) is folded in when `output.resultsDb` is absent, so older
 * configs keep working and re-saving rewrites them in the new shape. Returns
 * undefined when nothing is configured.
 */
function validateOutputConfig(outputValue: unknown, legacyResultsDbValue: unknown): FitCliOutputConfig | undefined {
  if (outputValue !== undefined && !isRecord(outputValue)) {
    throw new InvalidFitCliConfigError(`Field "output" must be a mapping; got ${JSON.stringify(outputValue)}`);
  }

  let format: OutputFormat | undefined;
  const formatValue = outputValue ? readOptionalString(outputValue, "format", "output.format") : undefined;
  if (formatValue !== undefined && formatValue !== "") {
    if (!(OUTPUT_FORMATS as readonly string[]).includes(formatValue)) {
      throw new InvalidFitCliConfigError(
        `Field "output.format" must be one of ${OUTPUT_FORMATS.join(", ")}; got ${JSON.stringify(formatValue)}`,
      );
    }
    format = formatValue as OutputFormat;
  }

  const resultsDbValue = (isRecord(outputValue) ? outputValue.resultsDb : undefined) ?? legacyResultsDbValue;
  const resultsDbPath = isRecord(outputValue) && outputValue.resultsDb !== undefined ? "output.resultsDb" : "resultsDb";
  if (resultsDbValue !== undefined && !isRecord(resultsDbValue)) {
    throw new InvalidFitCliConfigError(`Field "${resultsDbPath}" must be a mapping; got ${JSON.stringify(resultsDbValue)}`);
  }
  const resultsDb = resultsDbValue
    ? compactRecord({
        password: readOptionalString(resultsDbValue, "password", `${resultsDbPath}.password`),
        username: readOptionalString(resultsDbValue, "username", `${resultsDbPath}.username`),
      })
    : undefined;

  const parts: FitCliOutputConfig = {
    ...(format ? { format } : {}),
    ...(resultsDb && Object.keys(resultsDb).length > 0 ? { resultsDb } : {}),
  };
  return Object.keys(parts).length > 0 ? parts : undefined;
}

/** Validate and compact the `cloud` section. Returns undefined when it's empty. */
function validateCloudConfig(cloudValue: Record<string, unknown>): FitCliCloudConfig | undefined {
  const awsValue = cloudValue.aws;
  if (awsValue !== undefined && !isRecord(awsValue)) {
    throw new InvalidFitCliConfigError(`Field "cloud.aws" must be a mapping; got ${JSON.stringify(awsValue)}`);
  }

  let aws: FitCliAwsConfig | undefined;
  if (awsValue) {
    const instanceTypes = validateInstanceTypes(awsValue.instanceTypes, "cloud.aws.instanceTypes");
    const parts: FitCliAwsConfig = {
      ...compactRecord({
        profile: readOptionalString(awsValue, "profile", "cloud.aws.profile"),
      }),
      ...(instanceTypes ? { instanceTypes } : {}),
    };
    if (Object.keys(parts).length > 0) aws = parts;
  }

  if (!aws) return undefined;
  return { aws };
}

/** Validate and compact a per-purpose instance-type mapping. */
function validateInstanceTypes(value: unknown, path: string): FitCliInstanceTypes | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new InvalidFitCliConfigError(`Field "${path}" must be a mapping; got ${JSON.stringify(value)}`);
  }
  const parts: FitCliInstanceTypes = {};
  for (const purpose of CLOUD_INSTANCE_PURPOSES) {
    const type = readOptionalString(value, purpose, `${path}.${purpose}`);
    if (type !== undefined && type !== "") parts[purpose] = type;
  }
  return Object.keys(parts).length > 0 ? parts : undefined;
}

function detectConfigFormat(path: string): "json5" | "yaml" {
  if (/\.ya?ml$/i.test(path)) return "yaml";
  return "json5";
}

export function parseFitCliConfig(text: string, format?: "json5" | "yaml"): FitCliConfig {
  let raw: unknown;
  if (format !== undefined) {
    try {
      raw = format === "yaml" ? YAML.parse(text) : JSON5.parse(text);
    } catch (err) {
      throw new InvalidFitCliConfigError(`Could not parse config: ${(err as Error).message}`);
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
        throw new InvalidFitCliConfigError(
          `Could not parse config as JSON5 (${json5Err.message}) or YAML (${(yamlErr as Error).message})`,
        );
      }
    }
  }
  return validateFitCliConfig(raw);
}

export function loadFitCliConfig(path: string = defaultFitCliConfigPath()): FitCliConfigResult {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    return { loaded: false, path: absolute };
  }
  return {
    loaded: true,
    path: absolute,
    config: parseFitCliConfig(readFileSync(absolute, "utf8"), detectConfigFormat(absolute)),
  };
}

/**
 * The GitHub token used to clone the private FIT repos. We prefer the value
 * saved in the fit-cli config, then fall back to the usual environment variables,
 * so that someone who already exports GITHUB_TOKEN/GH_TOKEN doesn't have to run
 * `npm run config -- edit`. Loads the config itself when a parsed config isn't supplied.
 */
export function resolveGithubToken(
  options: { config?: FitCliConfig; path?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const env = options.env ?? process.env;
  const config = options.config ?? loadFitCliConfig(options.path).config;
  return config?.github?.token ?? env.GITHUB_TOKEN ?? env.GH_TOKEN;
}

/**
 * The GitHub credentials (user + token) needed for GHCR image pulls in remote
 * cbdinocluster environments. Both fields must be present in the fit-cli config —
 * environment-variable fallbacks are intentionally not supported here since GHCR
 * pulls require an explicit username. Returns the credentials on success, or an
 * error message string on failure.
 */
export function resolveGithubCredentials(
  options: { config?: FitCliConfig; path?: string } = {},
): { user: string; token: string } | string {
  const config = options.config ?? loadFitCliConfig(options.path).config;
  const user = config?.github?.user;
  const token = config?.github?.token;
  if (!user || !token) {
    const missing = [!user && "github.user", !token && "github.token"].filter(Boolean).join(" and ");
    return `${missing} must be set in ~/.fit-cli/config.json5 — run \`npm run config -- edit\` to configure it.`;
  }
  return { user, token };
}

/**
 * The hosted results-database readonly credentials. We prefer the values saved
 * in the fit-cli config, then fall back to the FIT_RESULTS_DB_* environment
 * variables (loaded from a `.env`), so existing setups keep working. The password
 * is a secret, so it's resolved on demand (like the GitHub token) rather than
 * pushed into the process env. Loads the config itself when one isn't supplied.
 */
export function resolveResultsDbCredentials(
  options: { config?: FitCliConfig; path?: string; env?: NodeJS.ProcessEnv } = {},
): { password?: string; username?: string } {
  const env = options.env ?? process.env;
  const config = options.config ?? loadFitCliConfig(options.path).config;
  return {
    password: config?.output?.resultsDb?.password ?? env.FIT_RESULTS_DB_PASSWORD,
    username: config?.output?.resultsDb?.username ?? env.FIT_RESULTS_DB_USERNAME,
  };
}

/**
 * The default format generated definition files are written in. Prefers
 * `output.format` from the fit-cli config, then falls back to
 * {@link DEFAULT_OUTPUT_FORMAT}. Loads the config itself when one isn't supplied.
 */
export function resolveOutputFormat(
  options: { config?: FitCliConfig; path?: string } = {},
): OutputFormat {
  const config = options.config ?? loadFitCliConfig(options.path).config;
  return config?.output?.format ?? DEFAULT_OUTPUT_FORMAT;
}

/** The Capella settings forwarded to a remote box, with every field resolved. */
export interface ResolvedCapellaConfig {
  /** Undefined when no username is configured (situational runs then can't enable Capella). */
  username?: string;
  endpoint: string;
  organizationId: string;
  password: string;
}

/** First non-empty trimmed env var among `names`, or undefined. */
function firstEnv(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Resolve the Capella control-plane settings for the situational cloud deployer.
 * Priority per field: fit-cli config → `CAPELLA_*`/`CAP_*` env var → hardcoded
 * default ({@link DEFAULT_CAPELLA_SETTINGS}). `username` has no default, so it's
 * undefined unless configured or present in the environment. The `CAP_*` aliases
 * match the GitHub Actions variable names used by fit-app-deployment. Loads the
 * config itself when one isn't supplied.
 */
export function resolveCapellaConfig(
  options: { config?: FitCliConfig; path?: string; env?: NodeJS.ProcessEnv } = {},
): ResolvedCapellaConfig {
  const env = options.env ?? process.env;
  const config = options.config ?? loadFitCliConfig(options.path).config;
  const c = config?.capella;
  return {
    username: c?.username ?? firstEnv(env, ["CAPELLA_USER", "CAP_USER"]),
    endpoint: c?.endpoint ?? firstEnv(env, ["CAPELLA_ENDPOINT", "CAP_END_POINT"]) ?? DEFAULT_CAPELLA_SETTINGS.endpoint,
    organizationId:
      c?.organizationId ?? firstEnv(env, ["CAPELLA_OID", "CAP_OID"]) ?? DEFAULT_CAPELLA_SETTINGS.organizationId,
    password: c?.password ?? firstEnv(env, ["CAPELLA_PASS", "CAP_PASS"]) ?? DEFAULT_CAPELLA_SETTINGS.password,
  };
}

const CANDIDATE_GERRIT_SSH_KEY_NAMES = ["id_rsa", "id_ed25519", "id_ecdsa"];

/**
 * Resolve the Gerrit username. Priority: gerrit.user in config → FIT_GERRIT_USER
 * env var → GERRIT_USER env var → github.user in config (same login is typical
 * at Couchbase). Returns undefined if nothing is found.
 */
export function resolveGerritUser(
  options: { config?: FitCliConfig; path?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const env = options.env ?? process.env;
  const config = options.config ?? loadFitCliConfig(options.path).config;
  return (
    config?.gerrit?.user ??
    (env.FIT_GERRIT_USER?.trim() || undefined) ??
    (env.GERRIT_USER?.trim() || undefined) ??
    config?.github?.user
  );
}

/**
 * Resolve the SSH private key path for Gerrit. Priority: gerrit.sshKeyPath in
 * config → FIT_GERRIT_KEY env var → GERRIT_SSH_KEY env var → first of the
 * standard ~/.ssh key files that exists on disk.
 */
export function resolveGerritSshKey(
  options: { config?: FitCliConfig; path?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const env = options.env ?? process.env;
  const config = options.config ?? loadFitCliConfig(options.path).config;
  const configured =
    config?.gerrit?.sshKeyPath ??
    (env.FIT_GERRIT_KEY?.trim() || undefined) ??
    (env.GERRIT_SSH_KEY?.trim() || undefined);
  if (configured) return configured;
  const home = env.HOME ?? homedir();
  for (const name of CANDIDATE_GERRIT_SSH_KEY_NAMES) {
    const candidate = join(home, ".ssh", name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function applyFitCliConfigToEnv(config: FitCliConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(configEnvEntries(config))) {
    if (env[key] === undefined) {
      env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

export function loadFitCliConfigEnv(
  path: string = defaultFitCliConfigPath(),
  env: NodeJS.ProcessEnv = process.env,
): AppliedFitCliConfigResult {
  const loaded = loadFitCliConfig(path);
  return {
    ...loaded,
    applied: loaded.config ? applyFitCliConfigToEnv(loaded.config, env) : [],
  };
}

export function saveFitCliConfig(config: FitCliConfig, path: string = defaultFitCliConfigPath()): string {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const format = detectConfigFormat(absolute);
  let text: string;
  if (format === "yaml") {
    text = YAML.stringify(validateFitCliConfig(config));
  } else {
    text = JSON5.stringify(validateFitCliConfig(config), null, 2);
    if (!text.endsWith("\n")) text += "\n";
  }
  writeFileSync(absolute, text, { mode: 0o600 });
  return absolute;
}

async function defaultRunInitWorkflow(path: string): Promise<void> {
  const { runEditWorkflow } = await import("../config/edit.js");
  await runEditWorkflow(path);
}

export async function ensureFitCliConfigEnv(
  options: EnsureFitCliConfigOptions = {},
): Promise<EnsuredFitCliConfigResult> {
  const path = resolve(options.path ?? defaultFitCliConfigPath());
  const env = options.env ?? process.env;
  const loaded = loadFitCliConfigEnv(path, env);
  if (loaded.loaded || options.promptIfMissing === false) {
    return { ...loaded, created: false };
  }

  if (promptedMissingConfigPaths.has(path)) {
    return { ...loaded, created: false };
  }
  promptedMissingConfigPaths.add(path);

  const create = options.confirmCreate
    ? await options.confirmCreate()
    : await confirm({
        promptId: options.promptId ?? "fit-cli.config.create",
        message:
          options.promptMessage ??
          `No fit-cli config found at ${path}. Run \`npm run config -- edit\` now?`,
        default: true,
      });
  if (!create) {
    return { ...loaded, created: false };
  }

  try {
    await (options.runInitWorkflow ?? defaultRunInitWorkflow)(path);
  } catch (err) {
    if (err instanceof Error && err.name === "ExitPromptError") {
      return { ...loaded, created: false };
    }
    throw err;
  }

  const reloaded = loadFitCliConfigEnv(path, env);
  return { ...reloaded, created: reloaded.loaded };
}
