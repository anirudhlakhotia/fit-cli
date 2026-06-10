#!/usr/bin/env node
import JSON5 from "json5";
import {
  FIT_CLI_CONFIG_VERSION,
  defaultFitCliConfigPath,
  loadFitCliConfig,
  saveFitCliConfig,
  type FitCliConfig,
} from "../util/config.js";
import { DEFAULT_AWS_REGION, awsRegionPromptMessage } from "../../util/non-fit/aws/region.js";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { confirm, input, password } from "../../util/non-fit/prompts.js";
import type { AutoInitCliArgs } from "../config/config.js";

const DEFAULT_EC2_INSTANCE_TYPE = "c5.xlarge";

export interface AwsInitAnswers {
  region: string;
  profile: string;
  instanceType: string;
}

export interface InitAnswers {
  configureAws: boolean;
  aws?: AwsInitAnswers;
  /** GitHub username for GHCR image pulls; empty/undefined to skip. */
  githubUser?: string;
  /** GitHub token for cloning the private FIT repos; empty/undefined to skip. */
  githubToken?: string;
  /** Readonly password for the hosted results database; empty/undefined to skip. */
  resultsDbPassword?: string;
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function initDefaultsFromConfig(config?: FitCliConfig): AwsInitAnswers {
  return {
    region: config?.aws?.region ?? DEFAULT_AWS_REGION,
    profile: config?.aws?.profile ?? "",
    instanceType: config?.aws?.instanceType ?? DEFAULT_EC2_INSTANCE_TYPE,
  };
}

export function initDefaultsFromEnv(env: NodeJS.ProcessEnv): AwsInitAnswers {
  return {
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? DEFAULT_AWS_REGION,
    profile: env.AWS_PROFILE ?? "",
    instanceType: env.FIT_EC2_INSTANCE_TYPE ?? DEFAULT_EC2_INSTANCE_TYPE,
  };
}

function awsAnswersToConfig(answers: AwsInitAnswers): FitCliConfig["aws"] {
  const region = trimOptional(answers.region) ?? DEFAULT_AWS_REGION;
  const profile = trimOptional(answers.profile);
  const instanceType = trimOptional(answers.instanceType) ?? DEFAULT_EC2_INSTANCE_TYPE;

  if (!region && !profile && !instanceType) {
    return undefined;
  }
  return {
    ...(region ? { region } : {}),
    ...(profile ? { profile } : {}),
    ...(instanceType ? { instanceType } : {}),
  };
}

export function initAnswersToConfig(answers: InitAnswers, existing?: FitCliConfig): FitCliConfig {
  // Declining the AWS prompt leaves any saved AWS settings untouched rather
  // than wiping them, so re-running init to update the token is non-destructive.
  const aws =
    answers.configureAws && answers.aws ? awsAnswersToConfig(answers.aws) : existing?.aws;
  const user = trimOptional(answers.githubUser) ?? existing?.github?.user;
  const token = trimOptional(answers.githubToken);
  const github = user || token
    ? { ...(user ? { user } : {}), ...(token ? { token } : {}) }
    : undefined;
  // Preserve a hand-set username; init only prompts for the password.
  const resultsDbPassword = trimOptional(answers.resultsDbPassword);
  const resultsDbUsername = existing?.resultsDb?.username;
  const resultsDb =
    resultsDbPassword || resultsDbUsername
      ? {
          ...(resultsDbPassword ? { password: resultsDbPassword } : {}),
          ...(resultsDbUsername ? { username: resultsDbUsername } : {}),
        }
      : undefined;

  return {
    version: FIT_CLI_CONFIG_VERSION,
    ...(aws ? { aws } : {}),
    ...(github ? { github } : {}),
    ...(resultsDb ? { resultsDb } : {}),
  };
}

function buildInitialDefaults(existing?: FitCliConfig): AwsInitAnswers {
  return existing ? initDefaultsFromConfig(existing) : initDefaultsFromEnv(process.env);
}

async function promptForGithubUser(existing?: FitCliConfig): Promise<string | undefined> {
  const existingUser = existing?.github?.user;
  const entered = await input({
    promptId: "init.github.user",
    message: existingUser
      ? "GitHub username for GHCR image pulls (leave blank to keep the current one):"
      : "GitHub username for GHCR image pulls:",
    default: existingUser ?? "",
  });
  return trimOptional(entered) ?? existingUser;
}

async function promptForGithubToken(existing?: FitCliConfig): Promise<string | undefined> {
  const existingToken = existing?.github?.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const entered = await password({
    promptId: "init.github.token",
    message: existingToken
      ? "GitHub PAT (for cloning FIT repos and pulling GHCR images — leave blank to keep the current one):"
      : "GitHub PAT (for cloning FIT repos and pulling GHCR images — leave blank to skip):",
    mask: "*",
  });
  // A blank entry keeps whatever is already configured, so re-running init
  // doesn't force the user to retype the token.
  return trimOptional(entered) ?? existingToken;
}

async function promptForResultsDbPassword(existing?: FitCliConfig): Promise<string | undefined> {
  const existingPassword = existing?.resultsDb?.password ?? process.env.FIT_RESULTS_DB_PASSWORD;
  const shared = "faas.couchbase.com results database password, for storing dev FIT/SIT and FIT/PERF results"
  const entered = await password({
    promptId: "init.results-db.password",
    message: existingPassword
      ? `${shared} (leave blank to keep the current one):`
      : `${shared} (leave blank to skip — ask on #the-fit-stop):`,
    mask: "*",
  });
  // A blank entry keeps whatever is already configured, mirroring the token prompt.
  return trimOptional(entered) ?? existingPassword;
}

async function promptForConfig(existing?: FitCliConfig): Promise<InitAnswers> {
  const githubUser = await promptForGithubUser(existing);
  const githubToken = await promptForGithubToken(existing);
  const resultsDbPassword = await promptForResultsDbPassword(existing);
  const defaults = buildInitialDefaults(existing);
  const hasExistingAws = existing?.aws !== undefined;
  const configureAws = await confirm({
    promptId: "init.aws.configure",
    message: hasExistingAws
      ? "Edit AWS settings? This is only required for some workflows."
      : "Configure AWS settings? This is only required for some workflows.",
    default: false,
  });

  if (!configureAws) {
    return { configureAws: false, githubUser, githubToken, resultsDbPassword };
  }

  return {
    configureAws: true,
    githubUser,
    githubToken,
    resultsDbPassword,
    aws: {
      region: await input({
        promptId: "init.aws.region",
        message: awsRegionPromptMessage(defaults.region),
        default: defaults.region,
      }),
      profile: await input({
        promptId: "init.aws.profile",
        message: "AWS profile (optional):",
        default: defaults.profile,
      }),
      instanceType: await input({
        promptId: "init.aws.instance-type",
        message: "Default FIT EC2 instance type:",
        default: defaults.instanceType,
      }),
    },
  };
}

/** Placeholder shown in place of secrets when echoing the config. */
const ELIDED = "********";

/**
 * Render the config as JSON5 with secrets (the GitHub token and results-DB
 * password) elided, so the saved config can be echoed to the terminal without
 * leaking credentials into scrollback or session logs.
 */
export function formatConfigForDisplay(config: FitCliConfig): string {
  const redacted: FitCliConfig = {
    ...config,
    ...(config.github
      ? { github: { ...config.github, ...(config.github.token ? { token: ELIDED } : {}) } }
      : {}),
    ...(config.resultsDb
      ? { resultsDb: { ...config.resultsDb, ...(config.resultsDb.password ? { password: ELIDED } : {}) } }
      : {}),
  };
  return JSON5.stringify(redacted, null, 2).trimEnd();
}

export async function runInitWorkflow(path: string = defaultFitCliConfigPath()): Promise<string> {
  const existing = loadFitCliConfig(path);
  const answers = await promptForConfig(existing.config);
  const config = initAnswersToConfig(answers, existing.config);
  const savedPath = saveFitCliConfig(config, existing.path);
  console.log(`Saved fit-cli config to ${savedPath}`);
  console.log(`\nConfig (secrets elided):\n\n${formatConfigForDisplay(config)}\n`);
  return savedPath;
}

// ─── Auto (non-interactive) init ────────────────────────────────────────────

/**
 * Describes a single resolution attempt: where we looked and what we found.
 */
export interface ResolutionEntry {
  field: string;
  source: string;
  found: boolean;
  value?: string;
}

export interface AutoInitOptions {
  args: AutoInitCliArgs;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve a config field from CLI arg → env var(s) → default. Records each
 * source checked into `log` for display.
 */
function resolveField(
  log: ResolutionEntry[],
  field: string,
  cliValue: string | undefined,
  cliLabel: string,
  envVars: { name: string; value: string | undefined }[],
  fallback?: string,
): string | undefined {
  // CLI arg
  if (cliValue !== undefined) {
    log.push({ field, source: cliLabel, found: true, value: cliValue });
    return cliValue;
  }
  log.push({ field, source: cliLabel, found: false });

  // Env vars
  for (const { name, value } of envVars) {
    if (value !== undefined && value !== "") {
      log.push({ field, source: `$${name}`, found: true, value });
      return value;
    }
    log.push({ field, source: `$${name}`, found: false });
  }

  // Default
  if (fallback !== undefined) {
    log.push({ field, source: "default", found: true, value: fallback });
    return fallback;
  }
  log.push({ field, source: "(none)", found: false });
  return undefined;
}

/** Mask a secret value for display. */
function mask(value: string | undefined): string {
  if (!value) return "";
  if (value.length <= 4) return "****";
  return value.slice(0, 4) + "****";
}

const SECRET_FIELDS = new Set(["github.token", "resultsDb.password"]);

/**
 * Print the resolution log as a table showing what was checked and found.
 */
export function printResolutionLog(log: ResolutionEntry[]): void {
  console.log("\nConfiguration resolution:\n");

  const col = (s: string, width: number) => s.padEnd(width);

  console.log(`  ${col("Field", 22)} ${col("Source", 24)} ${col("Found", 8)} Value`);
  console.log(`  ${col("─".repeat(22), 22)} ${col("─".repeat(24), 24)} ${col("─".repeat(8), 8)} ${"─".repeat(20)}`);
  for (const entry of log) {
    const displayValue = entry.found
      ? SECRET_FIELDS.has(entry.field) ? mask(entry.value) : (entry.value ?? "")
      : "";
    const marker = entry.found ? "✓" : "·";
    console.log(`  ${col(entry.field, 22)} ${col(entry.source, 24)} ${col(marker, 8)} ${displayValue}`);
  }
  console.log();
}

/**
 * Build a FitCliConfig from CLI args and env vars without any prompts.
 * Returns the config and the resolution log.
 */
export function buildAutoConfig(
  options: AutoInitOptions,
): { config: FitCliConfig; log: ResolutionEntry[] } {
  const { args, env = process.env } = options;
  const log: ResolutionEntry[] = [];

  // AWS section
  let aws: FitCliConfig["aws"] | undefined;
  if (!args.disableAws) {
    const region = resolveField(log, "aws.region", args.awsRegion, "--aws-region", [
      { name: "AWS_REGION", value: env.AWS_REGION },
      { name: "AWS_DEFAULT_REGION", value: env.AWS_DEFAULT_REGION },
    ], DEFAULT_AWS_REGION);
    const profile = resolveField(log, "aws.profile", args.awsProfile, "--aws-profile", [
      { name: "AWS_PROFILE", value: env.AWS_PROFILE },
    ]);
    const instanceType = resolveField(log, "aws.instanceType", args.awsInstanceType, "--aws-instance-type", [
      { name: "FIT_EC2_INSTANCE_TYPE", value: env.FIT_EC2_INSTANCE_TYPE },
    ], DEFAULT_EC2_INSTANCE_TYPE);

    const parts = {
      ...(region ? { region } : {}),
      ...(profile ? { profile } : {}),
      ...(instanceType ? { instanceType } : {}),
    };
    if (Object.keys(parts).length > 0) aws = parts;
  } else {
    log.push({ field: "aws.*", source: "--disable-aws", found: false });
  }

  // GitHub section
  let github: FitCliConfig["github"] | undefined;
  if (!args.disableGithub) {
    const user = resolveField(log, "github.user", args.githubUser, "--github-user", [
      { name: "GITHUB_USER", value: env.GITHUB_USER },
    ]);
    const token = resolveField(log, "github.token", args.githubToken, "--github-token", [
      { name: "GITHUB_TOKEN", value: env.GITHUB_TOKEN },
      { name: "GH_TOKEN", value: env.GH_TOKEN },
    ]);

    const parts = {
      ...(user ? { user } : {}),
      ...(token ? { token } : {}),
    };
    if (Object.keys(parts).length > 0) github = parts;
  } else {
    log.push({ field: "github.*", source: "--disable-github", found: false });
  }

  // Results DB section
  let resultsDb: FitCliConfig["resultsDb"] | undefined;
  if (!args.disableResultsDb) {
    const pw = resolveField(log, "resultsDb.password", args.resultsDbPassword, "--results-db-password", [
      { name: "FIT_RESULTS_DB_PASSWORD", value: env.FIT_RESULTS_DB_PASSWORD },
    ]);
    const username = resolveField(log, "resultsDb.username", args.resultsDbUsername, "--results-db-username", [
      { name: "FIT_RESULTS_DB_USERNAME", value: env.FIT_RESULTS_DB_USERNAME },
    ]);

    const parts = {
      ...(pw ? { password: pw } : {}),
      ...(username ? { username } : {}),
    };
    if (Object.keys(parts).length > 0) resultsDb = parts;
  } else {
    log.push({ field: "resultsDb.*", source: "--disable-results-db", found: false });
  }

  const config: FitCliConfig = {
    version: FIT_CLI_CONFIG_VERSION,
    ...(aws ? { aws } : {}),
    ...(github ? { github } : {}),
    ...(resultsDb ? { resultsDb } : {}),
  };

  return { config, log };
}

/**
 * Run the non-interactive auto-init flow: resolve config, display resolution
 * table, and write the config file (unless --dry-run).
 */
export async function runAutoInit(args: AutoInitCliArgs): Promise<void> {
  const { config, log } = buildAutoConfig({ args, env: process.env });

  printResolutionLog(log);

  console.log("Config (secrets elided):\n");
  console.log(formatConfigForDisplay(config));
  console.log();

  if (args.dryRun) {
    console.log(`[dry-run] Would write to: ${args.configPath}`);
    console.log("[dry-run] No changes made.");
    return;
  }

  const savedPath = saveFitCliConfig(config, args.configPath);
  console.log(`Saved fit-cli config to ${savedPath}`);
}

export async function main(): Promise<void> {
  await runInitWorkflow();
}

if (isMain(import.meta.url)) {
  runCli(main);
}
