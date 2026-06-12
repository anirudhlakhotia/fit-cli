#!/usr/bin/env node
/**
 * Top-level dispatcher for the `config` npm script.
 *
 * npm run config -- edit [--auto] [--dry-run] [--disable-aws] [--disable-github] [--disable-results-db]
 *                        [--aws-profile <p>] [--aws-instance-type <t>]
 *                        [--github-user <u>] [--github-token <t>]
 *                        [--results-db-password <p>] [--results-db-username <u>]
 *                        [--config-path <path>]
 * npm run config -- show [--config-path <path>]
 * npm run config -- --help
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { runAutoEdit, runEditWorkflow, formatConfigForDisplay } from "./edit.js";
import {
  CLOUD_INSTANCE_PURPOSES,
  defaultFitCliConfigPath,
  loadFitCliConfig,
  type FitCliInstanceTypes,
} from "../util/config.js";

const HELP = `Manage fit-cli configuration.

Usage:
  npm run config -- edit [options]
  npm run config -- show [--config-path <path>]
  npm run config -- --help

Subcommands:
  edit   Create or update the fit-cli config file (interactive by default).
  show   Print the current config with secrets elided.

Edit options:
  --auto                 Non-interactive mode. Reads from env vars and CLI args only.
  --dry-run              Show what would be written without touching the config file.
  --disable-aws          Skip writing the aws section.
  --disable-github       Skip writing the github section.
  --disable-results-db   Skip writing the resultsDb section.
  --disable-gerrit       Skip writing the gerrit section.
  --disable-capella      Skip writing the capella section.
  --aws-profile <p>      AWS profile (env: AWS_PROFILE).
  --aws-instance-type-functional <t>  EC2 instance type for functional tests
                         (env: FIT_EC2_INSTANCE_TYPE_FUNCTIONAL / FIT_EC2_INSTANCE_TYPE, default: c5.xlarge).
  --aws-instance-type-situational <t> EC2 instance type for situational (SIT) tests
                         (env: FIT_EC2_INSTANCE_TYPE_SITUATIONAL / FIT_EC2_INSTANCE_TYPE, default: c5.xlarge).
  --aws-instance-type-perf <t>        EC2 instance type for performance (PERF) tests
                         (env: FIT_EC2_INSTANCE_TYPE_PERF / FIT_EC2_INSTANCE_TYPE, default: c5.4xlarge).
  --github-user <u>      GitHub username (env: GITHUB_USER).
  --github-token <t>     GitHub PAT (env: GITHUB_TOKEN / GH_TOKEN).
  --results-db-password <p> Results DB password (env: FIT_RESULTS_DB_PASSWORD).
  --results-db-username <u> Results DB username (env: FIT_RESULTS_DB_USERNAME).
  --output-format <fmt>  Default format for generated definition files: json5 or yaml (env: FIT_OUTPUT_FORMAT; default: json5).
  --gerrit-user <u>      Gerrit username (env: FIT_GERRIT_USER / GERRIT_USER; defaults to github.user).
  --gerrit-ssh-key <path> Path to SSH private key registered with Gerrit (env: FIT_GERRIT_KEY / GERRIT_SSH_KEY).
  --capella-username <u> Capella username for situational/SIT runs (env: CAPELLA_USER / CAP_USER). No default.
  --capella-endpoint <e> Capella endpoint (env: CAPELLA_ENDPOINT / CAP_END_POINT; default: api.dev.nonprod-project-avengers.com).
  --capella-oid <id>     Capella organization ID (env: CAPELLA_OID / CAP_OID; has a default).
  --capella-password <p> Capella password (env: CAPELLA_PASS / CAP_PASS; default: NotUsed).
  --config-path <path>   Override config file path (default: ~/.fit-cli/config.json5).
  -h, --help             Show this help.`;

export interface AutoInitCliArgs {
  auto: boolean;
  dryRun: boolean;
  disableAws: boolean;
  disableGithub: boolean;
  disableResultsDb: boolean;
  disableGerrit: boolean;
  disableCapella: boolean;
  awsProfile?: string;
  /** Default EC2 instance type per testing purpose. */
  awsInstanceTypes?: FitCliInstanceTypes;
  githubUser?: string;
  githubToken?: string;
  resultsDbPassword?: string;
  resultsDbUsername?: string;
  outputFormat?: string;
  gerritUser?: string;
  gerritSshKeyPath?: string;
  capellaUsername?: string;
  capellaEndpoint?: string;
  capellaOrganizationId?: string;
  capellaPassword?: string;
  configPath: string;
}

function consumeFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

function consumeValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`Missing value for ${flag}`);
    process.exit(2);
  }
  args.splice(idx, 2);
  return value;
}

export function parseEditArgs(argv: string[]): AutoInitCliArgs {
  const args = [...argv];

  const auto = consumeFlag(args, "--auto");
  const dryRun = consumeFlag(args, "--dry-run");
  const disableAws = consumeFlag(args, "--disable-aws");
  const disableGithub = consumeFlag(args, "--disable-github");
  const disableResultsDb = consumeFlag(args, "--disable-results-db");
  const disableGerrit = consumeFlag(args, "--disable-gerrit");
  const disableCapella = consumeFlag(args, "--disable-capella");

  const awsProfile = consumeValue(args, "--aws-profile");
  const awsInstanceTypes: FitCliInstanceTypes = {};
  for (const purpose of CLOUD_INSTANCE_PURPOSES) {
    const value = consumeValue(args, `--aws-instance-type-${purpose}`);
    if (value !== undefined) awsInstanceTypes[purpose] = value;
  }
  const githubUser = consumeValue(args, "--github-user");
  const githubToken = consumeValue(args, "--github-token");
  const resultsDbPassword = consumeValue(args, "--results-db-password");
  const resultsDbUsername = consumeValue(args, "--results-db-username");
  const outputFormat = consumeValue(args, "--output-format");
  const gerritUser = consumeValue(args, "--gerrit-user");
  const gerritSshKeyPath = consumeValue(args, "--gerrit-ssh-key");
  const capellaUsername = consumeValue(args, "--capella-username");
  const capellaEndpoint = consumeValue(args, "--capella-endpoint");
  const capellaOrganizationId = consumeValue(args, "--capella-oid");
  const capellaPassword = consumeValue(args, "--capella-password");
  const configPath = consumeValue(args, "--config-path") ?? defaultFitCliConfigPath();

  // Warn about unknown flags
  for (const arg of args) {
    if (arg.startsWith("--") || (arg.startsWith("-") && arg.length > 1)) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(2);
    }
  }

  return {
    auto,
    dryRun,
    disableAws,
    disableGithub,
    disableResultsDb,
    disableGerrit,
    disableCapella,
    awsProfile,
    ...(Object.keys(awsInstanceTypes).length > 0 ? { awsInstanceTypes } : {}),
    githubUser,
    githubToken,
    resultsDbPassword,
    resultsDbUsername,
    outputFormat,
    gerritUser,
    gerritSshKeyPath,
    capellaUsername,
    capellaEndpoint,
    capellaOrganizationId,
    capellaPassword,
    configPath,
  };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    const [subcommand, ...rest] = argv;

    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      console.log(HELP);
      if (!subcommand) process.exit(2);
      return;
    }

    if (subcommand === "show") {
      const configPath = consumeValue([...rest], "--config-path") ?? defaultFitCliConfigPath();
      const { config } = loadFitCliConfig(configPath);
      if (!config) {
        console.error(`No config found at ${configPath}`);
        process.exit(1);
      }
      console.log(formatConfigForDisplay(config));
      return;
    }

    if (subcommand !== "edit") {
      console.error(`Unknown subcommand: ${subcommand}\n`);
      console.error(HELP);
      process.exit(2);
    }

    // edit subcommand
    if (rest.includes("--help") || rest.includes("-h")) {
      console.log(HELP);
      return;
    }

    const args = parseEditArgs(rest);

    if (args.auto) {
      await runAutoEdit(args);
    } else {
      await runEditWorkflow(args.configPath);
    }
  });
}
