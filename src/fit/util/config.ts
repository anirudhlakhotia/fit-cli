import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import JSON5 from "json5";
import YAML from "yaml";
import { confirm } from "../../util/non-fit/prompts.js";
import { expandTilde } from "../../util/non-fit/expand-tilde.js";
import { runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import { loadEnvironments, type EnvironmentsFile } from "./environments.js";
import { getJsonSecret } from "../../cloud/util/aws/secrets.js";

/** Where to get cbdinocluster — shown to users when it can't be found. */
export const CBDINOCLUSTER_URL = "https://github.com/couchbaselabs/cbdinocluster";

/**
 * AWS Secrets Manager secret that carries the shared GitHub credentials.
 * Fields: `token` (PAT), `user` (GitHub username).
 * Used as a fallback when no local config or env var is set — the primary use
 * case is clean EC2 test instances that have no personal config file.
 */
export const GITHUB_AWS_SECRET_ID = "fit-cli/github/token";

/**
 * AWS Secrets Manager secret that carries the ROSA / OpenShift cluster credentials
 * CNG functional runs log into. Fields: `url` (OpenShift API URL), `password`
 * (cluster-admin password — the `OPENSHIFT_CLUSTER` value on CI) and an optional
 * `username` (defaults to {@link DEFAULT_ROSA_USERNAME}). Kept out of the
 * definition file per project convention, like {@link GITHUB_AWS_SECRET_ID}.
 */
export const ROSA_AWS_SECRET_ID = "fit-cli/rosa/openshift";

/** Default OpenShift login user when the ROSA secret doesn't override it. */
export const DEFAULT_ROSA_USERNAME = "cluster-admin";

/** Default environment block names — sourced from environments.json5 defaults. */
export const DEFAULT_CAPELLA_ENV = loadEnvironments().defaults.defaultCapellaEnvironment;
export const DEFAULT_RESULTS_ENV = loadEnvironments().defaults.defaultResultsEnvironment;
/** Default user for the hosted results database when the secret doesn't override it. */
const DEFAULT_RESULTS_DB_USERNAME = "postgres";

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
    // 16 GiB / 8 vCPU. Functional runs put 3 Couchbase nodes (sharing the host's
    // RAM under the docker deployer) plus the SDK performer and the Maven test
    // driver on one box; 8 GiB (c5.xlarge) left the box thrashing/OOMing partway
    // through a full all-non-transactions run, dropping the SSH session.
    functional: "c5.2xlarge",
    situational: "c5.2xlarge",
    perf: "c5.4xlarge",
  },
};

export type FitCliInstanceTypes = Partial<Record<CloudInstancePurpose, string>>;

export interface FitCliAwsConfig {
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
  /**
   * GitHub username (needed so cbdinocluster can pull from GHCR).
   * Optional: falls back to the `user` field in the AWS secret
   * {@link GITHUB_AWS_SECRET_ID} — useful on clean EC2 test instances.
   */
  user?: string;
  /**
   * Personal access token used to clone the private FIT repos and pull GHCR images.
   * Optional: falls back to GITHUB_TOKEN / GH_TOKEN env vars, then the `token`
   * field in the AWS secret {@link GITHUB_AWS_SECRET_ID} — useful on clean EC2
   * test instances that have no personal config file.
   */
  token?: string;
}

/** The formats a generated definition file can be written in. */
export const OUTPUT_FORMATS = ["json5", "yaml"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Baked-in default output format, used when the config doesn't set one. */
export const DEFAULT_OUTPUT_FORMAT: OutputFormat = "json5";

/**
 * Top-level `output` settings: how fit-cli renders things it produces.
 *
 * Results-database credentials are NOT stored here — they're fetched at run time
 * from AWS Secrets Manager, keyed by the results environment selected in the
 * definition file (see environments.json5 / resolveResultsDbCredentials).
 */
export interface FitCliOutputConfig {
  /** Default format generated definition files are written in (json5 or yaml). */
  format?: OutputFormat;
}

export interface FitCliGerritConfig {
  /** Gerrit username. Defaults to github.user when not set. */
  user?: string;
}

/**
 * A repo fit-cli works with on localhost, keyed under `localhost.repos`. Mirrors
 * the definition file's `setup.repos` shape (see ReposSetup in
 * definition/types.ts), but carries the local checkout location rather than a
 * gerritRef.
 */
export interface FitCliRepoConfig {
  /** Absolute path to the local checkout of this repo. */
  dir?: string;
}

export interface FitCliReposConfig {
  "transactions-fit-performer"?: FitCliRepoConfig;
}

/**
 * Settings that only matter when running FIT tests on this machine (localhost).
 * EC2 runs need none of these — the remote box clones the repos itself,
 * installs its own cbdinocluster, and pulls GitHub/Gerrit credentials from
 * AWS Secrets Manager rather than the user's personal config.
 * grahamp: that is very intentional.  User testing found that user's own PAT
 * tokens often weren't recently SSO-permissioned to access couchbaselabs, and/or
 * did not have required permissions.  It's much cleaner to use the known one in
 * AWS secrets wherever we can.  If that ever hits a problem (maybe user wants
 * access to a particular branch only their PAT can access or something odd),
 * better to add runtime override at that point.
 */
export interface FitCliLocalhostConfig {
  /** Local checkouts of the repos a localhost run needs (the FIT test-driver). */
  repos?: FitCliReposConfig;
  /** Absolute path to the cbdinocluster binary, for non-PATH installs. */
  cbdinoclusterPath?: string;
  /**
   * GitHub credentials for localhost runs: cloning private FIT repos and pulling
   * GHCR images. EC2 runs always source these from the AWS secret
   * {@link GITHUB_AWS_SECRET_ID} so that a user's personal PAT (which may have
   * different permission scopes) is never used on the remote box.
   */
  github?: FitCliGithubConfig;
  /**
   * Gerrit username for localhost runs (checking out Gerrit change refs).
   * EC2 runs use the Gerrit SSH key from AWS Secrets Manager and derive the
   * username the same way — this field is not sent to the remote box.
   */
  gerrit?: FitCliGerritConfig;
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
  /** Your Capella account (env: CAPELLA_USER / CAP_USER). */
  username?: string;
  /** Your Capella account password (env: CAPELLA_PASS / CAP_PASS). */
  password?: string;
}

export interface FitCliConfig {
  version: 1;
  cloud?: FitCliCloudConfig;
  output?: FitCliOutputConfig;
  capella?: FitCliCapellaConfig;
  /** Settings that only matter for running FIT tests on this machine. */
  localhost?: FitCliLocalhostConfig;
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

function configEnvEntries(_config: FitCliConfig): Record<string, string> {
  return {};
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
      `Config file version ${version} is no longer supported. Recreate ${FIT_CLI_CONFIG_BASENAME} with \`${runScriptPrefix("config")} edit\`.`,
    );
  }

  const cloudValue = raw.cloud;
  if (cloudValue !== undefined && !isRecord(cloudValue)) {
    throw new InvalidFitCliConfigError(`Field "cloud" must be a mapping; got ${JSON.stringify(cloudValue)}`);
  }

  const cloud = cloudValue ? validateCloudConfig(cloudValue) : undefined;

  const output = validateOutputConfig(raw.output);

  const capellaValue = raw.capella;
  if (capellaValue !== undefined && !isRecord(capellaValue)) {
    throw new InvalidFitCliConfigError(`Field "capella" must be a mapping; got ${JSON.stringify(capellaValue)}`);
  }

  const capella = capellaValue
    ? compactRecord({
        username: readOptionalString(capellaValue, "username", "capella.username"),
        password: readOptionalString(capellaValue, "password", "capella.password"),
      })
    : undefined;

  // Legacy: cbdinoclusterPath used to be top-level; it now lives under `localhost`.
  // Legacy: github and gerrit used to be top-level; they now live under `localhost`.
  // Fold old top-level values in so existing configs keep working (no version bump).
  const legacyCbdinoclusterPath = readOptionalString(raw, "cbdinoclusterPath", "cbdinoclusterPath");
  const legacyGithubValue = raw.github;
  const legacyGithub =
    legacyGithubValue && isRecord(legacyGithubValue)
      ? compactRecord({
          user: readOptionalString(legacyGithubValue, "user", "github.user"),
          token: readOptionalString(legacyGithubValue, "token", "github.token"),
        })
      : undefined;
  const legacyGerritValue = raw.gerrit;
  const legacyGerrit =
    legacyGerritValue && isRecord(legacyGerritValue)
      ? compactRecord({ user: readOptionalString(legacyGerritValue, "user", "gerrit.user") })
      : undefined;
  const localhost = validateLocalhostConfig(raw.localhost, legacyCbdinoclusterPath, legacyGithub, legacyGerrit);

  return {
    version: FIT_CLI_CONFIG_VERSION,
    ...(cloud ? { cloud } : {}),
    ...(output ? { output } : {}),
    ...(capella && Object.keys(capella).length > 0 ? { capella } : {}),
    ...(localhost ? { localhost } : {}),
  };
}

/**
 * Validate and compact the `localhost` section. `legacyCbdinoclusterPath`,
 * `legacyGithub`, and `legacyGerrit` are old top-level values folded in when
 * `localhost` doesn't set them — keeps existing configs working without a version bump.
 * Returns undefined when everything is empty.
 */
function validateLocalhostConfig(
  value: unknown,
  legacyCbdinoclusterPath?: string,
  legacyGithub?: Partial<FitCliGithubConfig>,
  legacyGerrit?: Partial<FitCliGerritConfig>,
): FitCliLocalhostConfig | undefined {
  if (value !== undefined && !isRecord(value)) {
    throw new InvalidFitCliConfigError(`Field "localhost" must be a mapping; got ${JSON.stringify(value)}`);
  }

  let repos: FitCliReposConfig | undefined;
  const reposValue = value?.repos;
  if (reposValue !== undefined) {
    if (!isRecord(reposValue)) {
      throw new InvalidFitCliConfigError(`Field "localhost.repos" must be a mapping; got ${JSON.stringify(reposValue)}`);
    }
    const performer = reposValue["transactions-fit-performer"];
    if (performer !== undefined) {
      if (!isRecord(performer)) {
        throw new InvalidFitCliConfigError(
          `Field "localhost.repos.transactions-fit-performer" must be a mapping; got ${JSON.stringify(performer)}`,
        );
      }
      const dir = readOptionalString(performer, "dir", "localhost.repos.transactions-fit-performer.dir");
      if (dir) repos = { "transactions-fit-performer": { dir } };
    }
  }

  const cbdinoclusterPath =
    (value ? readOptionalString(value, "cbdinoclusterPath", "localhost.cbdinoclusterPath") : undefined) ??
    legacyCbdinoclusterPath;

  const githubValue = value?.github;
  if (githubValue !== undefined && !isRecord(githubValue)) {
    throw new InvalidFitCliConfigError(`Field "localhost.github" must be a mapping; got ${JSON.stringify(githubValue)}`);
  }
  const githubRaw = githubValue && isRecord(githubValue)
    ? compactRecord({
        user: readOptionalString(githubValue, "user", "localhost.github.user"),
        token: readOptionalString(githubValue, "token", "localhost.github.token"),
      })
    : undefined;
  const github = Object.keys(githubRaw ?? {}).length > 0
    ? githubRaw
    : (legacyGithub && Object.keys(legacyGithub).length > 0 ? legacyGithub : undefined);

  const gerritValue = value?.gerrit;
  if (gerritValue !== undefined && !isRecord(gerritValue)) {
    throw new InvalidFitCliConfigError(`Field "localhost.gerrit" must be a mapping; got ${JSON.stringify(gerritValue)}`);
  }
  const gerritRaw = gerritValue && isRecord(gerritValue)
    ? compactRecord({ user: readOptionalString(gerritValue, "user", "localhost.gerrit.user") })
    : undefined;
  const gerrit = Object.keys(gerritRaw ?? {}).length > 0
    ? gerritRaw
    : (legacyGerrit && Object.keys(legacyGerrit).length > 0 ? legacyGerrit : undefined);

  if (!repos && !cbdinoclusterPath && !github && !gerrit) return undefined;
  return {
    ...(repos ? { repos } : {}),
    ...(cbdinoclusterPath ? { cbdinoclusterPath } : {}),
    ...(github ? { github } : {}),
    ...(gerrit ? { gerrit } : {}),
  };
}

/**
 * Validate and compact the `output` section. `format` must be one of
 * {@link OUTPUT_FORMATS}. Returns undefined when nothing is configured.
 *
 * Results-database credentials used to live here (`output.resultsDb` / a legacy
 * top-level `resultsDb`); they're now fetched from AWS Secrets Manager, so any
 * such key in an older config is simply ignored.
 */
function validateOutputConfig(outputValue: unknown): FitCliOutputConfig | undefined {
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

  return format ? { format } : undefined;
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
    if (instanceTypes) aws = { instanceTypes };
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
 * The GitHub token used to clone the private FIT repos on localhost. Resolution order:
 *   1. `localhost.github.token` in the fit-cli config
 *   2. GITHUB_TOKEN / GH_TOKEN env vars
 *   3. `token` field in the {@link GITHUB_AWS_SECRET_ID} AWS secret
 *
 * For EC2 runs use {@link resolveGithubTokenFromAws} directly — the user's personal
 * PAT is never forwarded to the remote box.
 */
export async function resolveGithubToken(
  options: {
    config?: FitCliConfig;
    path?: string;
    env?: NodeJS.ProcessEnv;
    fetchSecret?: (secretId: string) => Promise<Record<string, string>>;
  } = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const config = options.config ?? loadFitCliConfig(options.path).config;
  const fromLocal = config?.localhost?.github?.token ?? (env.GITHUB_TOKEN?.trim() || undefined) ?? (env.GH_TOKEN?.trim() || undefined);
  if (fromLocal) return fromLocal;

  try {
    const fetchSecret = options.fetchSecret ?? getJsonSecret;
    const secret = await fetchSecret(GITHUB_AWS_SECRET_ID);
    return secret.token?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The GitHub token for EC2 runs, fetched directly from {@link GITHUB_AWS_SECRET_ID}.
 * EC2 runs always use the shared org secret rather than the user's personal PAT:
 * personal PATs may have different permission scopes and should not be sent to
 * remote boxes the user does not fully control.
 */
export async function resolveGithubTokenFromAws(
  options: {
    fetchSecret?: (secretId: string) => Promise<Record<string, string>>;
  } = {},
): Promise<string | undefined> {
  try {
    const fetchSecret = options.fetchSecret ?? getJsonSecret;
    const secret = await fetchSecret(GITHUB_AWS_SECRET_ID);
    return secret.token?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the path to the cbdinocluster binary. Priority: cbdinoclusterPath in
 * the fit-cli config → CBDINOCLUSTER_PATH env var. Returns undefined when neither
 * is set, in which case callers fall back to PATH lookup.
 */
export function resolveCbdinoclusterPath(
  options: { config?: FitCliConfig; path?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const env = options.env ?? process.env;
  const config = options.config ?? loadFitCliConfig(options.path).config;
  return config?.localhost?.cbdinoclusterPath ?? (env.CBDINOCLUSTER_PATH?.trim() || undefined);
}

/**
 * Resolve the local transactions-fit-performer checkout directory for localhost
 * runs, from `localhost.repos["transactions-fit-performer"].dir` in the config.
 * Returns undefined when the user hasn't configured localhost testing — there's
 * no env var or default; the EC2 path clones the repo on the remote box instead.
 */
export function resolveFitPerformerDir(
  options: { config?: FitCliConfig; path?: string } = {},
): string | undefined {
  const config = options.config ?? loadFitCliConfig(options.path).config;
  const dir = config?.localhost?.repos?.["transactions-fit-performer"]?.dir;
  return dir === undefined ? undefined : expandTilde(dir);
}

/**
 * The GitHub credentials (user + token) needed for GHCR image pulls in localhost
 * cbdinocluster environments. Resolution order for each field:
 *   1. `localhost.github.user` / `localhost.github.token` in the fit-cli config
 *   2. `user` / `token` fields in the {@link GITHUB_AWS_SECRET_ID} AWS secret
 *
 * For EC2 runs use {@link resolveGithubCredentialsFromAws} directly — the user's
 * personal PAT is never forwarded to the remote box.
 */
export async function resolveGithubCredentials(
  options: {
    config?: FitCliConfig;
    path?: string;
    fetchSecret?: (secretId: string) => Promise<Record<string, string>>;
  } = {},
): Promise<{ user: string; token: string } | string> {
  const config = options.config ?? loadFitCliConfig(options.path).config;
  let user = config?.localhost?.github?.user;
  let token = config?.localhost?.github?.token;

  if (!user || !token) {
    try {
      const fetchSecret = options.fetchSecret ?? getJsonSecret;
      const secret = await fetchSecret(GITHUB_AWS_SECRET_ID);
      user = user ?? (secret.user?.trim() || undefined);
      token = token ?? (secret.token?.trim() || undefined);
    } catch {
      // AWS not available — fall through to the error below.
    }
  }

  if (!user || !token) {
    const missing = [!user && "localhost.github.user", !token && "localhost.github.token"].filter(Boolean).join(" and ");
    return (
      `${missing} not found in ~/.fit-cli/config.json5 or in the AWS secret "${GITHUB_AWS_SECRET_ID}". ` +
      `Run \`${runScriptPrefix("config")} edit\` to configure locally, or populate the AWS secret for EC2 use.`
    );
  }
  return { user, token };
}

/**
 * The GitHub credentials (user + token) for EC2 runs, fetched directly from
 * {@link GITHUB_AWS_SECRET_ID}. EC2 runs always use the shared org secret rather
 * than the user's personal PAT — personal PATs may have different permission scopes
 * and should not be sent to remote boxes the user does not fully control.
 */
export async function resolveGithubCredentialsFromAws(
  options: {
    fetchSecret?: (secretId: string) => Promise<Record<string, string>>;
  } = {},
): Promise<{ user: string; token: string } | string> {
  try {
    const fetchSecret = options.fetchSecret ?? getJsonSecret;
    const secret = await fetchSecret(GITHUB_AWS_SECRET_ID);
    const user = secret.user?.trim() || undefined;
    const token = secret.token?.trim() || undefined;
    if (user && token) return { user, token };
    const missing = [!user && "user", !token && "token"].filter(Boolean).join(" and ");
    return (
      `GitHub ${missing} not found in the AWS secret "${GITHUB_AWS_SECRET_ID}". ` +
      `Populate the secret for EC2 use.`
    );
  } catch {
    return `Could not fetch the AWS secret "${GITHUB_AWS_SECRET_ID}". Ensure AWS credentials are configured.`;
  }
}

/** ROSA / OpenShift cluster login details for a CNG functional run. */
export interface ResolvedRosaCredentials {
  /** OpenShift API URL to `oc login` against. */
  url: string;
  /** Login user (defaults to {@link DEFAULT_ROSA_USERNAME}). */
  username: string;
  /** cluster-admin password. */
  password: string;
}

/**
 * Resolve the ROSA / OpenShift credentials a CNG functional run logs into, from
 * the {@link ROSA_AWS_SECRET_ID} AWS secret. The shared ROSA cluster has no
 * per-user identity, so — unlike GitHub creds — there's no local-config path:
 * the URL and password always come from Secrets Manager. `username` defaults to
 * {@link DEFAULT_ROSA_USERNAME} when the secret omits it. Returns the credentials
 * on success, or an actionable error message string on failure (mirroring
 * {@link resolveGithubCredentials}).
 */
export async function resolveRosaCredentials(
  options: {
    fetchSecret?: (secretId: string) => Promise<Record<string, string>>;
  } = {},
): Promise<ResolvedRosaCredentials | string> {
  let secret: Record<string, string>;
  try {
    const fetchSecret = options.fetchSecret ?? getJsonSecret;
    secret = await fetchSecret(ROSA_AWS_SECRET_ID);
  } catch (err) {
    return (
      `Could not read the ROSA credentials from the AWS secret "${ROSA_AWS_SECRET_ID}": ${(err as Error).message}\n` +
      `Populate it with \`${runScriptPrefix("secrets")} set ${ROSA_AWS_SECRET_ID} url=… password=…\` ` +
      `and make sure your AWS credentials are active.`
    );
  }
  const url = secret.url?.trim();
  const password = secret.password?.trim();
  if (!url || !password) {
    const missing = [!url && "url", !password && "password"].filter(Boolean).join(" and ");
    return (
      `The AWS secret "${ROSA_AWS_SECRET_ID}" is missing ${missing}. ` +
      `Set it with \`${runScriptPrefix("secrets")} set ${ROSA_AWS_SECRET_ID} url=… password=…\`.`
    );
  }
  return { url, username: secret.username?.trim() || DEFAULT_ROSA_USERNAME, password };
}

/** Hosted results-database connection details for a results environment. */
export interface ResolvedResultsDbCredentials {
  host: string;
  username: string;
  password: string;
}

/**
 * Resolve the hosted results-database credentials for a results environment
 * (a key under `results` in environments.json5; default "dev"). The host is the
 * non-secret registry value; the password (and optional username) come from that
 * environment's AWS Secrets Manager secret. Throws with an actionable message
 * when the environment is unknown/unprovisioned or the secret can't be read.
 */
export async function resolveResultsDbCredentials(
  options: {
    block?: string;
    environments?: EnvironmentsFile;
    fetchSecret?: (secretId: string) => Promise<Record<string, string>>;
  } = {},
): Promise<ResolvedResultsDbCredentials> {
  const block = options.block ?? DEFAULT_RESULTS_ENV;
  const environments = options.environments ?? loadEnvironments();
  const fetchSecret = options.fetchSecret ?? getJsonSecret;
  const entry = environments.results[block];
  if (!entry) {
    throw new InvalidFitCliConfigError(`Unknown results environment "${block}" — not defined in environments.json5.`);
  }
  const host = entry.host?.trim();
  if (!host) {
    throw new InvalidFitCliConfigError(`Results environment "${block}" has no host set in environments.json5.`);
  }
  if (!entry.secretId) {
    throw new InvalidFitCliConfigError(`Results environment "${block}" has no secretId in environments.json5.`);
  }
  const secret = await fetchSecret(entry.secretId);
  const password = secret.password?.trim();
  if (!password) {
    throw new InvalidFitCliConfigError(`AWS secret "${entry.secretId}" (results "${block}") has no "password" field.`);
  }
  return { host, username: secret.username?.trim() || DEFAULT_RESULTS_DB_USERNAME, password };
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
 * Resolve the Capella control-plane settings for a Capella environment (a key
 * under `capella` in environments.json5; default "prod").
 *
 * endpoint/organizationId/username are the non-secret registry values (username is
 * the shared account for the environment). Only the password is a secret: a personal
 * one (capella.password in config, or CAPELLA_PASS / CAP_PASS) takes precedence, else
 * we fall back to the shared account password in AWS Secrets Manager (and warn). A
 * personal username can still be set to override the shared one. Throws when the
 * environment is unknown/unprovisioned or no password can be resolved.
 */
export async function resolveCapellaConfig(
  options: {
    block?: string;
    config?: FitCliConfig;
    path?: string;
    env?: NodeJS.ProcessEnv;
    environments?: EnvironmentsFile;
    fetchSecret?: (secretId: string) => Promise<Record<string, string>>;
  } = {},
): Promise<ResolvedCapellaConfig> {
  const block = options.block ?? DEFAULT_CAPELLA_ENV;
  const env = options.env ?? process.env;
  const config = options.config ?? loadFitCliConfig(options.path).config;
  const environments = options.environments ?? loadEnvironments();
  const fetchSecret = options.fetchSecret ?? getJsonSecret;

  const entry = environments.capella[block];
  if (!entry) {
    throw new InvalidFitCliConfigError(`Unknown Capella environment "${block}" — not defined in environments.json5.`);
  }
  const endpoint = entry.endpoint?.trim();
  const organizationId = entry.oid?.trim();
  if (!endpoint || !organizationId) {
    const missing = [!endpoint && "endpoint", !organizationId && "oid"].filter(Boolean).join(", ");
    throw new InvalidFitCliConfigError(
      `Capella environment "${block}" isn't fully provisioned in environments.json5 (missing ${missing}).`,
    );
  }

  const c = config?.capella;
  // Username is the shared, non-secret account from the registry, overridable by personal config/env.
  let username = c?.username ?? firstEnv(env, ["CAPELLA_USER", "CAP_USER"]) ?? entry.username?.trim();
  // Password: personal first, else the shared account password from the secret.
  let password = c?.password ?? firstEnv(env, ["CAPELLA_PASS", "CAP_PASS"]);
  if (!password) {
    if (!entry.secretId) {
      throw new InvalidFitCliConfigError(
        `Capella environment "${block}" has no secretId in environments.json5 and no personal password is configured.`,
      );
    }
    console.info(
      `No personal Capella password configured — using the shared "${block}" account password from AWS Secrets Manager.\n` +
        `  Set CAPELLA_PASS (or run \`${runScriptPrefix("config")} edit\`) to use your own.`,
    );
    const secret = await fetchSecret(entry.secretId);
    password = secret.password?.trim();
    username = username ?? secret.username?.trim();
  }
  if (!username || !password) {
    const missing = [!username && "username", !password && "password"].filter(Boolean).join(", ");
    throw new InvalidFitCliConfigError(`Could not resolve Capella ${missing} for "${block}".`);
  }
  return { username, endpoint, organizationId, password };
}

const CANDIDATE_GERRIT_SSH_KEY_NAMES = ["id_rsa", "id_ed25519", "id_ecdsa"];

/**
 * Resolve the Gerrit username. Priority: localhost.gerrit.user in config →
 * FIT_GERRIT_USER env var → GERRIT_USER env var → localhost.github.user in config
 * (same login is typical at Couchbase). Returns undefined if nothing is found.
 */
export function resolveGerritUser(
  options: { config?: FitCliConfig; path?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const env = options.env ?? process.env;
  const config = options.config ?? loadFitCliConfig(options.path).config;
  return (
    config?.localhost?.gerrit?.user ??
    (env.FIT_GERRIT_USER?.trim() || undefined) ??
    (env.GERRIT_USER?.trim() || undefined) ??
    config?.localhost?.github?.user
  );
}

/**
 * Resolve the SSH private key path for Gerrit. Priority: FIT_GERRIT_KEY env
 * var → GERRIT_SSH_KEY env var → first of the standard ~/.ssh key files that
 * exists on disk. For the AWS Secrets Manager fallback (when no local key is
 * found at all) see `resolveGerritKeyWithAwsFallback` in remote-fit-execution-context.ts.
 */
export function resolveGerritSshKey(
  options: { config?: FitCliConfig; path?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
  const env = options.env ?? process.env;
  const configured =
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
          `No fit-cli config found at ${path}. Run \`${runScriptPrefix("config")} edit\` now?`,
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
