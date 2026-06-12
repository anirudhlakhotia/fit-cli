import JSON5 from "json5";
import {
  CLOUD_INSTANCE_PURPOSES,
  DEFAULT_CAPELLA_SETTINGS,
  DEFAULT_CLOUD_INSTANCE_TYPES,
  FIT_CLI_CONFIG_VERSION,
  defaultFitCliConfigPath,
  loadFitCliConfig,
  resolveGerritSshKey,
  saveFitCliConfig,
  type CloudInstancePurpose,
  type FitCliAwsConfig,
  type FitCliCapellaConfig,
  type FitCliCloudConfig,
  type FitCliConfig,
  type FitCliInstanceTypes,
} from "../util/config.js";
import { confirm, input, password } from "../../util/non-fit/prompts.js";
import type { AutoInitCliArgs } from "./config.js";

/** The AWS default instance types, keyed by testing purpose. */
const DEFAULT_EC2_INSTANCE_TYPES = DEFAULT_CLOUD_INSTANCE_TYPES.aws;

/** Human-friendly label for a purpose, used in prompts. */
const PURPOSE_LABELS: Record<CloudInstancePurpose, string> = {
  functional: "functional",
  situational: "situational (SIT)",
  perf: "performance (PERF)",
};

/** Env var carrying a per-purpose instance-type override (e.g. FIT_EC2_INSTANCE_TYPE_PERF). */
function purposeEnvVar(purpose: CloudInstancePurpose): string {
  return `FIT_EC2_INSTANCE_TYPE_${purpose.toUpperCase()}`;
}

export type AwsInstanceTypeAnswers = Record<CloudInstancePurpose, string>;

export interface AwsInitAnswers {
  profile: string;
  instanceTypes: AwsInstanceTypeAnswers;
}

/** Every Capella field as a (possibly empty) string, ready to write to config. */
export type CapellaInitAnswers = Required<Record<keyof FitCliCapellaConfig, string>>;

export interface InitAnswers {
  configureAws: boolean;
  aws?: AwsInitAnswers;
  /** GitHub username for GHCR image pulls; empty/undefined to skip. */
  githubUser?: string;
  /** GitHub token for cloning the private FIT repos; empty/undefined to skip. */
  githubToken?: string;
  /** Readonly password for the hosted results database; empty/undefined to skip. */
  resultsDbPassword?: string;
  /** Gerrit username; defaults to github.user when blank. */
  gerritUser?: string;
  /** Path to the SSH private key registered with Gerrit. */
  gerritSshKeyPath?: string;
  configureCapella: boolean;
  capella?: CapellaInitAnswers;
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Fill every purpose, preferring saved values then the baked-in defaults. */
function instanceTypeDefaults(saved?: FitCliInstanceTypes): AwsInstanceTypeAnswers {
  const result = {} as AwsInstanceTypeAnswers;
  for (const purpose of CLOUD_INSTANCE_PURPOSES) {
    result[purpose] = saved?.[purpose] ?? DEFAULT_EC2_INSTANCE_TYPES[purpose];
  }
  return result;
}

export function initDefaultsFromConfig(config?: FitCliConfig): AwsInitAnswers {
  const aws = config?.cloud?.aws;
  return {
    profile: aws?.profile ?? "",
    instanceTypes: instanceTypeDefaults(aws?.instanceTypes),
  };
}

export function initDefaultsFromEnv(env: NodeJS.ProcessEnv): AwsInitAnswers {
  const instanceTypes = {} as AwsInstanceTypeAnswers;
  for (const purpose of CLOUD_INSTANCE_PURPOSES) {
    instanceTypes[purpose] =
      env[purposeEnvVar(purpose)] ?? env.FIT_EC2_INSTANCE_TYPE ?? DEFAULT_EC2_INSTANCE_TYPES[purpose];
  }
  return {
    profile: env.AWS_PROFILE ?? "",
    instanceTypes,
  };
}

/** Keep only the purposes with a non-empty value. */
function compactInstanceTypes(types: AwsInstanceTypeAnswers): FitCliInstanceTypes | undefined {
  const parts: FitCliInstanceTypes = {};
  for (const purpose of CLOUD_INSTANCE_PURPOSES) {
    const value = trimOptional(types[purpose]);
    if (value) parts[purpose] = value;
  }
  return Object.keys(parts).length > 0 ? parts : undefined;
}

function awsAnswersToConfig(answers: AwsInitAnswers): FitCliAwsConfig | undefined {
  const profile = trimOptional(answers.profile);
  const instanceTypes = compactInstanceTypes(answers.instanceTypes);

  const parts: FitCliAwsConfig = {
    ...(profile ? { profile } : {}),
    ...(instanceTypes ? { instanceTypes } : {}),
  };
  return Object.keys(parts).length > 0 ? parts : undefined;
}

/** Capella prompt defaults from a saved config: username from config, the rest defaulting to the hardcoded values. */
function capellaDefaultsFromConfig(config?: FitCliConfig): CapellaInitAnswers {
  const c = config?.capella;
  return {
    username: c?.username ?? "",
    endpoint: c?.endpoint ?? DEFAULT_CAPELLA_SETTINGS.endpoint,
    organizationId: c?.organizationId ?? DEFAULT_CAPELLA_SETTINGS.organizationId,
    password: c?.password ?? DEFAULT_CAPELLA_SETTINGS.password,
    overrideToken: c?.overrideToken ?? DEFAULT_CAPELLA_SETTINGS.overrideToken,
    internalSupportToken: c?.internalSupportToken ?? DEFAULT_CAPELLA_SETTINGS.internalSupportToken,
  };
}

/** Keep only the Capella fields with a non-empty value. */
function capellaAnswersToConfig(answers: CapellaInitAnswers): FitCliCapellaConfig | undefined {
  const parts: FitCliCapellaConfig = {};
  for (const key of Object.keys(answers) as (keyof CapellaInitAnswers)[]) {
    const value = trimOptional(answers[key]);
    if (value) parts[key] = value;
  }
  return Object.keys(parts).length > 0 ? parts : undefined;
}

export function initAnswersToConfig(answers: InitAnswers, existing?: FitCliConfig): FitCliConfig {
  // Declining the AWS prompt leaves any saved cloud settings untouched rather
  // than wiping them, so re-running edit is non-destructive.
  const aws =
    answers.configureAws && answers.aws ? awsAnswersToConfig(answers.aws) : existing?.cloud?.aws;
  const cloud: FitCliCloudConfig | undefined = aws ? { aws } : undefined;
  const user = trimOptional(answers.githubUser) ?? existing?.github?.user;
  const token = trimOptional(answers.githubToken);
  const github = user || token
    ? { ...(user ? { user } : {}), ...(token ? { token } : {}) }
    : undefined;
  // Preserve a hand-set username; edit only prompts for the password.
  const resultsDbPassword = trimOptional(answers.resultsDbPassword);
  const resultsDbUsername = existing?.resultsDb?.username;
  const resultsDb =
    resultsDbPassword || resultsDbUsername
      ? {
          ...(resultsDbPassword ? { password: resultsDbPassword } : {}),
          ...(resultsDbUsername ? { username: resultsDbUsername } : {}),
        }
      : undefined;

  const gerritUser = trimOptional(answers.gerritUser);
  const gerritSshKeyPath = trimOptional(answers.gerritSshKeyPath);
  const gerrit =
    gerritUser || gerritSshKeyPath
      ? {
          ...(gerritUser ? { user: gerritUser } : {}),
          ...(gerritSshKeyPath ? { sshKeyPath: gerritSshKeyPath } : {}),
        }
      : existing?.gerrit;

  // Declining the Capella prompt leaves any saved capella settings untouched.
  const capella =
    answers.configureCapella && answers.capella ? capellaAnswersToConfig(answers.capella) : existing?.capella;

  return {
    version: FIT_CLI_CONFIG_VERSION,
    ...(cloud ? { cloud } : {}),
    ...(github ? { github } : {}),
    ...(resultsDb ? { resultsDb } : {}),
    ...(gerrit ? { gerrit } : {}),
    ...(capella ? { capella } : {}),
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
  // A blank entry keeps whatever is already configured, so re-running edit
  // doesn't force the user to retype the token.
  return trimOptional(entered) ?? existingToken;
}

async function promptForGerritUser(existing?: FitCliConfig): Promise<string | undefined> {
  const existingUser = existing?.gerrit?.user;
  const githubUser = existing?.github?.user;
  const defaultUser = existingUser ?? githubUser;
  const entered = await input({
    promptId: "init.gerrit.user",
    message: defaultUser
      ? `Gerrit username (leave blank to use "${defaultUser}"):`
      : "Gerrit username (leave blank to use your GitHub username):",
    default: existingUser ?? "",
  });
  return trimOptional(entered) ?? existingUser;
}

async function promptForGerritSshKeyPath(existing?: FitCliConfig): Promise<string | undefined> {
  const existingPath = existing?.gerrit?.sshKeyPath ?? resolveGerritSshKey({ config: existing });
  const entered = await input({
    promptId: "init.gerrit.ssh-key",
    message: existingPath
      ? `Path to Gerrit SSH private key (leave blank to use "${existingPath}"):`
      : "Path to Gerrit SSH private key (leave blank to skip — required for fetching Gerrit change refs):",
    default: existingPath ?? "",
  });
  return trimOptional(entered) ?? (existing?.gerrit?.sshKeyPath);
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

async function promptForConfig(existing?: FitCliConfig, configPath?: string): Promise<InitAnswers> {
  const githubUser = await promptForGithubUser(existing);
  const githubToken = await promptForGithubToken(existing);
  const resultsDbPassword = await promptForResultsDbPassword(existing);
  const gerritUser = await promptForGerritUser(existing);
  const gerritSshKeyPath = await promptForGerritSshKeyPath(existing);
  const defaults = buildInitialDefaults(existing);
  const hasExistingAws = existing?.cloud?.aws !== undefined;
  const configureAws = await confirm({
    promptId: "init.aws.configure",
    message: hasExistingAws
      ? "Edit AWS settings? This is only required for some workflows."
      : "Configure AWS settings? This is only required for some workflows.",
    default: false,
  });

  const aws = configureAws
    ? {
        profile: await input({
          promptId: "init.aws.profile",
          message: "AWS profile (optional):",
          default: defaults.profile,
        }),
        instanceTypes: await promptForInstanceTypes(defaults.instanceTypes),
      }
    : undefined;

  const { configureCapella, capella } = await promptForCapella(existing, configPath);

  return {
    configureAws,
    ...(aws ? { aws } : {}),
    githubUser,
    githubToken,
    resultsDbPassword,
    gerritUser,
    gerritSshKeyPath,
    configureCapella,
    ...(capella ? { capella } : {}),
  };
}

/**
 * Ask whether to configure Capella (situational/SIT only), and if so, the
 * username plus the five fields that default to the hardcoded values.
 */
async function promptForCapella(
  existing?: FitCliConfig,
  configPath?: string,
): Promise<{ configureCapella: boolean; capella?: CapellaInitAnswers }> {
  const hasExisting = existing?.capella !== undefined;
  const configureCapella = await confirm({
    promptId: "init.capella.configure",
    message: hasExisting
      ? "Edit Capella settings? Only needed for situational (SIT) runs."
      : "Configure Capella settings? Only needed for situational (SIT) runs.",
    default: false,
  });
  if (!configureCapella) {
    return { configureCapella: false };
  }

  const defaults = capellaDefaultsFromConfig(existing);
  const ask = (field: keyof CapellaInitAnswers, label: string) =>
      input({ promptId: `init.capella.${field}`, message: `${label}:`, default: defaults[field] });
  const endpoint = await ask("endpoint", "Capella endpoint (defaults to development - https://dev.nonprod-project-avengers.com/)");
  const username = await input({
    promptId: "init.capella.username",
    message: defaults.username
        ? `Capella username (leave blank to keep "${defaults.username}"):`
        : "Capella username (usually your Couchbase email for that Capella endpoint/environment):",
    default: defaults.username,
  });

  console.warn(
    `\nWarning: Capella password will be saved in plaintext in ${configPath ?? "~/.fit-cli/config.json5"}.\n` +
    `Set CAPELLA_PASS in your environment to avoid storing it on disk.\n`,
  );
  const capellaPassword = await password({
    promptId: "init.capella.password",
    message: defaults.password && defaults.password !== "NotUsed"
      ? "Capella password (leave blank to keep the current one):"
      : "Capella password (leave blank to skip — set CAPELLA_PASS env var instead):",
    mask: "*",
  });

  return {
    configureCapella: true,
    capella: {
      username,
      endpoint: endpoint,
      organizationId: await ask("organizationId", "Capella organization ID"),
      password: trimOptional(capellaPassword) ?? defaults.password,
      overrideToken: await ask("overrideToken", "Capella override token"),
      internalSupportToken: await ask("internalSupportToken", "Capella internal support token"),
    },
  };
}

/** Ask for a default EC2 instance type per testing purpose. */
async function promptForInstanceTypes(defaults: AwsInstanceTypeAnswers): Promise<AwsInstanceTypeAnswers> {
  const answers = {} as AwsInstanceTypeAnswers;
  for (const purpose of CLOUD_INSTANCE_PURPOSES) {
    answers[purpose] = await input({
      promptId: `init.aws.instance-type.${purpose}`,
      message: `Default EC2 instance type for ${PURPOSE_LABELS[purpose]} tests:`,
      default: defaults[purpose],
    });
  }
  return answers;
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
    ...(config.capella
      ? {
          capella: {
            ...config.capella,
            ...(config.capella.password ? { password: ELIDED } : {}),
            ...(config.capella.overrideToken ? { overrideToken: ELIDED } : {}),
            ...(config.capella.internalSupportToken ? { internalSupportToken: ELIDED } : {}),
          },
        }
      : {}),
  };
  return JSON5.stringify(redacted, null, 2).trimEnd();
}

export async function runEditWorkflow(path: string = defaultFitCliConfigPath()): Promise<string> {
  const existing = loadFitCliConfig(path);
  const answers = await promptForConfig(existing.config, existing.path);
  const config = initAnswersToConfig(answers, existing.config);
  const savedPath = saveFitCliConfig(config, existing.path);
  console.log(`Saved fit-cli config to ${savedPath}`);
  console.log(`\nConfig (secrets elided):\n\n${formatConfigForDisplay(config)}\n`);
  return savedPath;
}

// ─── Auto (non-interactive) edit ────────────────────────────────────────────

/**
 * Describes a single resolution attempt: where we looked and what we found.
 */
export interface ResolutionEntry {
  field: string;
  source: string;
  found: boolean;
  value?: string;
  /** If true, this entry is a diagnostic-only env check — not written to config. */
  diagnosticOnly?: boolean;
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

const SECRET_FIELDS = new Set([
  "github.token",
  "resultsDb.password",
  "capella.password",
  "capella.overrideToken",
  "capella.internalSupportToken",
]);

/** Check whether a diagnostic-only env var is present, appending an entry to the log. */
function checkDiagnosticVar(log: ResolutionEntry[], envName: string, value: string | undefined): void {
  const found = value !== undefined && value !== "";
  log.push({ field: `$${envName}`, source: `$${envName}`, found, ...(found ? { value } : {}), diagnosticOnly: true });
}

/**
 * Print the resolution log as a compact table: one row per config field with
 * one cell per source checked (CLI arg, env vars, default), plus a separate
 * diagnostic section for env-only checks that are not written to the config.
 */
export function printResolutionLog(log: ResolutionEntry[]): void {
  console.log("\nConfiguration resolution:\n");

  const regularEntries = log.filter((e) => !e.diagnosticOnly);
  const diagnosticEntries = log.filter((e) => e.diagnosticOnly);

  // Group regular entries by field, preserving insertion order
  const fieldGroups = new Map<string, ResolutionEntry[]>();
  for (const entry of regularEntries) {
    if (!fieldGroups.has(entry.field)) fieldGroups.set(entry.field, []);
    fieldGroups.get(entry.field)!.push(entry);
  }

  // One column per source position; width = longest source name at that position + 2 (for "✓ " / "· ")
  const maxSources = Math.max(...[...fieldGroups.values()].map((g) => g.length), 0);
  const srcWidths: number[] = [];
  for (let i = 0; i < maxSources; i++) {
    let w = 0;
    for (const group of fieldGroups.values()) {
      if (i < group.length) w = Math.max(w, group[i].source.length + 2);
    }
    srcWidths.push(w);
  }

  const fieldWidth = Math.max(...[...fieldGroups.keys()].map((k) => k.length), 5);
  const srcTotalWidth = srcWidths.length > 0 ? srcWidths.reduce((s, w) => s + w + 2, 0) - 2 : 0;
  const col = (s: string, w: number) => s.padEnd(w);

  console.log(`  ${col("Field", fieldWidth)}  ${col("Sources", srcTotalWidth)}  Value`);
  console.log(`  ${"─".repeat(fieldWidth)}  ${"─".repeat(srcTotalWidth)}  ${"─".repeat(20)}`);

  for (const [field, entries] of fieldGroups) {
    const cells = entries.map((e, i) => col(`${e.found ? "✓" : "·"} ${e.source}`, srcWidths[i]));
    for (let i = entries.length; i < maxSources; i++) cells.push(col("", srcWidths[i]));

    const resolved = entries.find((e) => e.found);
    const finalValue = resolved
      ? SECRET_FIELDS.has(field) ? mask(resolved.value) : (resolved.value ?? "")
      : "";

    console.log(`  ${col(field, fieldWidth)}  ${cells.join("  ")}  ${finalValue}`);
  }

  if (diagnosticEntries.length > 0) {
    const diagLabel = "─── env-only (not saved to config) ";
    const diagWidth = Math.max(...diagnosticEntries.map((e) => e.source.length));
    const divWidth = fieldWidth + 2 + srcTotalWidth + 2 + 20;
    console.log();
    console.log(`  ${diagLabel}${"─".repeat(Math.max(0, divWidth - diagLabel.length))}`);
    for (const entry of diagnosticEntries) {
      const marker = entry.found ? "~" : "✗";
      const displayValue = entry.found ? mask(entry.value) : "";
      console.log(`  ${col(entry.source, diagWidth)}  ${marker}  ${displayValue}`);
    }
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

  // Cloud (AWS) section
  let cloud: FitCliCloudConfig | undefined;
  if (!args.disableAws) {
    const profile = resolveField(log, "cloud.aws.profile", args.awsProfile, "--aws-profile", [
      { name: "AWS_PROFILE", value: env.AWS_PROFILE },
    ]);

    const instanceTypes: FitCliInstanceTypes = {};
    for (const purpose of CLOUD_INSTANCE_PURPOSES) {
      const type = resolveField(
        log,
        `cloud.aws.instanceTypes.${purpose}`,
        args.awsInstanceTypes?.[purpose],
        `--aws-instance-type-${purpose}`,
        [
          { name: purposeEnvVar(purpose), value: env[purposeEnvVar(purpose)] },
          { name: "FIT_EC2_INSTANCE_TYPE", value: env.FIT_EC2_INSTANCE_TYPE },
        ],
        DEFAULT_EC2_INSTANCE_TYPES[purpose],
      );
      if (type) instanceTypes[purpose] = type;
    }

    const parts: FitCliAwsConfig = {
      ...(profile ? { profile } : {}),
      ...(Object.keys(instanceTypes).length > 0 ? { instanceTypes } : {}),
    };
    if (Object.keys(parts).length > 0) cloud = { aws: parts };

    // Diagnostic: AWS credentials (must be set in env; not written to config)
    checkDiagnosticVar(log, "AWS_ACCESS_KEY_ID", env.AWS_ACCESS_KEY_ID);
    checkDiagnosticVar(log, "AWS_SECRET_ACCESS_KEY", env.AWS_SECRET_ACCESS_KEY);
    checkDiagnosticVar(log, "AWS_SESSION_TOKEN", env.AWS_SESSION_TOKEN);
  } else {
    log.push({ field: "cloud.aws.*", source: "--disable-aws", found: false });
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

  // Gerrit section
  let gerrit: FitCliConfig["gerrit"] | undefined;
  if (!args.disableGerrit) {
    const user = resolveField(log, "gerrit.user", args.gerritUser, "--gerrit-user", [
      { name: "FIT_GERRIT_USER", value: env.FIT_GERRIT_USER },
      { name: "GERRIT_USER", value: env.GERRIT_USER },
    ]);
    const sshKeyPath = resolveField(log, "gerrit.sshKeyPath", args.gerritSshKeyPath, "--gerrit-ssh-key", [
      { name: "FIT_GERRIT_KEY", value: env.FIT_GERRIT_KEY },
      { name: "GERRIT_SSH_KEY", value: env.GERRIT_SSH_KEY },
    ]);
    const parts = {
      ...(user ? { user } : {}),
      ...(sshKeyPath ? { sshKeyPath } : {}),
    };
    if (Object.keys(parts).length > 0) gerrit = parts;
  } else {
    log.push({ field: "gerrit.*", source: "--disable-gerrit", found: false });
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

  // Capella section. Anchored on the username: with no username there's nothing
  // to log in as, so we skip the section entirely rather than write a block of
  // bare defaults into every config. The defaults still apply at use time via
  // resolveCapellaConfig().
  let capella: FitCliConfig["capella"] | undefined;
  if (args.disableCapella) {
    log.push({ field: "capella.*", source: "--disable-capella", found: false });
  } else {
    const username = resolveField(log, "capella.username", args.capellaUsername, "--capella-username", [
      { name: "CAPELLA_USER", value: env.CAPELLA_USER },
      { name: "CAP_USER", value: env.CAP_USER },
    ]);
    if (!username) {
      log.push({ field: "capella.*", source: "(no username)", found: false });
    } else {
    const endpoint = resolveField(
      log,
      "capella.endpoint",
      args.capellaEndpoint,
      "--capella-endpoint",
      [
        { name: "CAPELLA_ENDPOINT", value: env.CAPELLA_ENDPOINT },
        { name: "CAP_END_POINT", value: env.CAP_END_POINT },
      ],
      DEFAULT_CAPELLA_SETTINGS.endpoint,
    );
    const organizationId = resolveField(
      log,
      "capella.organizationId",
      args.capellaOrganizationId,
      "--capella-oid",
      [
        { name: "CAPELLA_OID", value: env.CAPELLA_OID },
        { name: "CAP_OID", value: env.CAP_OID },
      ],
      DEFAULT_CAPELLA_SETTINGS.organizationId,
    );
    const capellaPassword = resolveField(
      log,
      "capella.password",
      args.capellaPassword,
      "--capella-password",
      [
        { name: "CAPELLA_PASS", value: env.CAPELLA_PASS },
        { name: "CAP_PASS", value: env.CAP_PASS },
      ],
      DEFAULT_CAPELLA_SETTINGS.password,
    );
    const overrideToken = resolveField(
      log,
      "capella.overrideToken",
      args.capellaOverrideToken,
      "--capella-override-token",
      [
        { name: "CAPELLA_OVERRIDE_TOKEN", value: env.CAPELLA_OVERRIDE_TOKEN },
        { name: "CAP_OVERRIDE_TOKEN", value: env.CAP_OVERRIDE_TOKEN },
      ],
      DEFAULT_CAPELLA_SETTINGS.overrideToken,
    );
    const internalSupportToken = resolveField(
      log,
      "capella.internalSupportToken",
      args.capellaInternalSupportToken,
      "--capella-internal-support-token",
      [
        { name: "CAPELLA_INTERNAL_SUPPORT_TOKEN", value: env.CAPELLA_INTERNAL_SUPPORT_TOKEN },
        { name: "CAP_INTERNAL_SUPPORT_TOKEN", value: env.CAP_INTERNAL_SUPPORT_TOKEN },
      ],
      DEFAULT_CAPELLA_SETTINGS.internalSupportToken,
    );

      capella = {
        username,
        ...(endpoint ? { endpoint } : {}),
        ...(organizationId ? { organizationId } : {}),
        ...(capellaPassword ? { password: capellaPassword } : {}),
        ...(overrideToken ? { overrideToken } : {}),
        ...(internalSupportToken ? { internalSupportToken } : {}),
      };
    }
  }

  const config: FitCliConfig = {
    version: FIT_CLI_CONFIG_VERSION,
    ...(cloud ? { cloud } : {}),
    ...(github ? { github } : {}),
    ...(resultsDb ? { resultsDb } : {}),
    ...(gerrit ? { gerrit } : {}),
    ...(capella ? { capella } : {}),
  };

  return { config, log };
}

/**
 * Run the non-interactive auto-edit flow: resolve config, display resolution
 * table, and write the config file (unless --dry-run).
 */
export function runAutoEdit(args: AutoInitCliArgs): Promise<void> {
  const { config, log } = buildAutoConfig({ args, env: process.env });

  printResolutionLog(log);

  console.log("Config (secrets elided):\n");
  console.log(formatConfigForDisplay(config));
  console.log();

  if (args.dryRun) {
    console.log(`[dry-run] Would write to: ${args.configPath}`);
    console.log("[dry-run] No changes made.");
    return Promise.resolve();
  }

  const savedPath = saveFitCliConfig(config, args.configPath);
  console.log(`Saved fit-cli config to ${savedPath}`);
  return Promise.resolve();
}
