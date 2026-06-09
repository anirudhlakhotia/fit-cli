import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { confirm } from "../../util/non-fit/prompts.js";

export const FIT_CLI_CONFIG_VERSION = 1;
export const FIT_CLI_CONFIG_DIRNAME = ".fit-cli";
export const FIT_CLI_CONFIG_BASENAME = "config.yaml";

export interface FitCliAwsConfig {
  region?: string;
  profile?: string;
  instanceType?: string;
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

export interface FitCliConfig {
  version: 1;
  aws?: FitCliAwsConfig;
  github?: FitCliGithubConfig;
  resultsDb?: FitCliResultsDbConfig;
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
  return compactRecord({
    AWS_REGION: config.aws?.region,
    AWS_PROFILE: config.aws?.profile,
    FIT_EC2_INSTANCE_TYPE: config.aws?.instanceType,
  });
}

const promptedMissingConfigPaths = new Set<string>();

export function defaultFitCliConfigPath(home: string = homedir()): string {
  return resolve(home, FIT_CLI_CONFIG_DIRNAME, FIT_CLI_CONFIG_BASENAME);
}

export function validateFitCliConfig(raw: unknown): FitCliConfig {
  if (!isRecord(raw)) {
    throw new InvalidFitCliConfigError("fit-cli config must be a YAML mapping at the top level.");
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
      `Config file version ${version} is no longer supported. Recreate ${FIT_CLI_CONFIG_BASENAME} with \`npm run init\`.`,
    );
  }

  const awsValue = raw.aws;
  if (awsValue !== undefined && !isRecord(awsValue)) {
    throw new InvalidFitCliConfigError(`Field "aws" must be a mapping; got ${JSON.stringify(awsValue)}`);
  }

  const aws = awsValue
    ? compactRecord({
        region: readOptionalString(awsValue, "region", "aws.region"),
        profile: readOptionalString(awsValue, "profile", "aws.profile"),
        instanceType: readOptionalString(awsValue, "instanceType", "aws.instanceType"),
      })
    : undefined;

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

  const resultsDbValue = raw.resultsDb;
  if (resultsDbValue !== undefined && !isRecord(resultsDbValue)) {
    throw new InvalidFitCliConfigError(`Field "resultsDb" must be a mapping; got ${JSON.stringify(resultsDbValue)}`);
  }

  const resultsDb = resultsDbValue
    ? compactRecord({
        password: readOptionalString(resultsDbValue, "password", "resultsDb.password"),
        username: readOptionalString(resultsDbValue, "username", "resultsDb.username"),
      })
    : undefined;

  return {
    version: FIT_CLI_CONFIG_VERSION,
    ...(aws && Object.keys(aws).length > 0 ? { aws } : {}),
    ...(github && Object.keys(github).length > 0 ? { github } : {}),
    ...(resultsDb && Object.keys(resultsDb).length > 0 ? { resultsDb } : {}),
  };
}

export function parseFitCliConfig(text: string): FitCliConfig {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    throw new InvalidFitCliConfigError(`Could not parse YAML: ${(err as Error).message}`);
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
    config: parseFitCliConfig(readFileSync(absolute, "utf8")),
  };
}

/**
 * The GitHub token used to clone the private FIT repos. We prefer the value
 * saved in config.yaml, then fall back to the usual environment variables, so
 * that someone who already exports GITHUB_TOKEN/GH_TOKEN doesn't have to run
 * `npm run init`. Loads config.yaml itself when a parsed config isn't supplied.
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
 * cbdinocluster environments. Both fields must be present in config.yaml —
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
    return `${missing} must be set in ~/.fit-cli/config.yaml — run \`npm run init\` to configure it.`;
  }
  return { user, token };
}

/**
 * The hosted results-database readonly credentials. We prefer the values saved
 * in config.yaml, then fall back to the FIT_RESULTS_DB_* environment variables
 * (loaded from a `.env`), so existing setups keep working. The password is a
 * secret, so it's resolved on demand (like the GitHub token) rather than pushed
 * into the process env. Loads config.yaml itself when a parsed config isn't
 * supplied.
 */
export function resolveResultsDbCredentials(
  options: { config?: FitCliConfig; path?: string; env?: NodeJS.ProcessEnv } = {},
): { password?: string; username?: string } {
  const env = options.env ?? process.env;
  const config = options.config ?? loadFitCliConfig(options.path).config;
  return {
    password: config?.resultsDb?.password ?? env.FIT_RESULTS_DB_PASSWORD,
    username: config?.resultsDb?.username ?? env.FIT_RESULTS_DB_USERNAME,
  };
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
  const text = YAML.stringify(validateFitCliConfig(config));
  writeFileSync(absolute, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
  return absolute;
}

async function defaultRunInitWorkflow(path: string): Promise<void> {
  const { runInitWorkflow } = await import("../init/init.js");
  await runInitWorkflow(path);
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
          `No fit-cli config found at ${path}. Run \`npm run init\` now?`,
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
