#!/usr/bin/env node
/**
 * Top-level dispatcher for the `config` npm script.
 *
 * npm run config -- init [--auto] [--dry-run] [--disable-aws] [--disable-github] [--disable-results-db]
 *                        [--aws-region <r>] [--aws-profile <p>] [--aws-instance-type <t>]
 *                        [--github-user <u>] [--github-token <t>]
 *                        [--results-db-password <p>] [--results-db-username <u>]
 *                        [--config-path <path>]
 * npm run config -- --help
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { runAutoInit, runInitWorkflow } from "../init/init.js";
import { defaultFitCliConfigPath } from "../util/config.js";

const HELP = `Manage fit-cli configuration.

Usage:
  npm run config -- init [options]
  npm run config -- --help

Subcommands:
  init   Create or update the fit-cli config file.

Init options:
  --auto                 Non-interactive mode. Reads from env vars and CLI args only.
  --dry-run              Show what would be written without touching the config file.
  --disable-aws          Skip writing the aws section.
  --disable-github       Skip writing the github section.
  --disable-results-db   Skip writing the resultsDb section.
  --aws-region <r>       AWS region (env: AWS_REGION / AWS_DEFAULT_REGION, default: us-east-1).
  --aws-profile <p>      AWS profile (env: AWS_PROFILE).
  --aws-instance-type <t> EC2 instance type (env: FIT_EC2_INSTANCE_TYPE, default: c5.xlarge).
  --github-user <u>      GitHub username (env: GITHUB_USER).
  --github-token <t>     GitHub PAT (env: GITHUB_TOKEN / GH_TOKEN).
  --results-db-password <p> Results DB password (env: FIT_RESULTS_DB_PASSWORD).
  --results-db-username <u> Results DB username (env: FIT_RESULTS_DB_USERNAME).
  --config-path <path>   Override config file path (default: ~/.fit-cli/config.json5).
  -h, --help             Show this help.`;

export interface AutoInitCliArgs {
  auto: boolean;
  dryRun: boolean;
  disableAws: boolean;
  disableGithub: boolean;
  disableResultsDb: boolean;
  awsRegion?: string;
  awsProfile?: string;
  awsInstanceType?: string;
  githubUser?: string;
  githubToken?: string;
  resultsDbPassword?: string;
  resultsDbUsername?: string;
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

export function parseInitArgs(argv: string[]): AutoInitCliArgs {
  const args = [...argv];

  const auto = consumeFlag(args, "--auto");
  const dryRun = consumeFlag(args, "--dry-run");
  const disableAws = consumeFlag(args, "--disable-aws");
  const disableGithub = consumeFlag(args, "--disable-github");
  const disableResultsDb = consumeFlag(args, "--disable-results-db");

  const awsRegion = consumeValue(args, "--aws-region");
  const awsProfile = consumeValue(args, "--aws-profile");
  const awsInstanceType = consumeValue(args, "--aws-instance-type");
  const githubUser = consumeValue(args, "--github-user");
  const githubToken = consumeValue(args, "--github-token");
  const resultsDbPassword = consumeValue(args, "--results-db-password");
  const resultsDbUsername = consumeValue(args, "--results-db-username");
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
    awsRegion,
    awsProfile,
    awsInstanceType,
    githubUser,
    githubToken,
    resultsDbPassword,
    resultsDbUsername,
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

    if (subcommand !== "init") {
      console.error(`Unknown subcommand: ${subcommand}\n`);
      console.error(HELP);
      process.exit(2);
    }

    // init subcommand
    if (rest.includes("--help") || rest.includes("-h")) {
      console.log(HELP);
      return;
    }

    const args = parseInitArgs(rest);

    if (args.auto) {
      await runAutoInit(args);
    } else {
      await runInitWorkflow(args.configPath);
    }
  });
}
