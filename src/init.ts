#!/usr/bin/env node
import {
  FIT_CLI_CONFIG_VERSION,
  defaultFitCliConfigPath,
  loadFitCliConfig,
  saveFitCliConfig,
  type FitCliConfig,
} from "./util/fit/config.js";
import { DEFAULT_AWS_REGION, awsRegionPromptMessage } from "./util/non-fit/aws/region.js";
import { isMain, runCli } from "./util/non-fit/cli.js";
import { confirm, input, password } from "./util/non-fit/prompts.js";

const DEFAULT_EC2_INSTANCE_TYPE = "c5.xlarge";

export interface AwsInitAnswers {
  region: string;
  profile: string;
  instanceType: string;
}

export interface InitAnswers {
  configureAws: boolean;
  aws?: AwsInitAnswers;
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
  const token = trimOptional(answers.githubToken);
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
    ...(token ? { github: { token } } : {}),
    ...(resultsDb ? { resultsDb } : {}),
  };
}

function buildInitialDefaults(existing?: FitCliConfig): AwsInitAnswers {
  return existing ? initDefaultsFromConfig(existing) : initDefaultsFromEnv(process.env);
}

async function promptForGithubToken(existing?: FitCliConfig): Promise<string | undefined> {
  const existingToken = existing?.github?.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const entered = await password({
    promptId: "init.github.token",
    message: existingToken
      ? "GitHub token for cloning the private FIT repos (leave blank to keep the current one):"
      : "GitHub token for cloning the private FIT repos (leave blank to skip):",
    mask: "*",
  });
  // A blank entry keeps whatever is already configured, so re-running init
  // doesn't force the user to retype the token.
  return trimOptional(entered) ?? existingToken;
}

async function promptForResultsDbPassword(existing?: FitCliConfig): Promise<string | undefined> {
  const existingPassword = existing?.resultsDb?.password ?? process.env.FIT_RESULTS_DB_PASSWORD;
  const entered = await password({
    promptId: "init.results-db.password",
    message: existingPassword
      ? "Hosted results-database readonly password (leave blank to keep the current one):"
      : "Hosted results-database readonly password (leave blank to skip — ask on #the-fit-stop):",
    mask: "*",
  });
  // A blank entry keeps whatever is already configured, mirroring the token prompt.
  return trimOptional(entered) ?? existingPassword;
}

async function promptForConfig(existing?: FitCliConfig): Promise<InitAnswers> {
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
    return { configureAws: false, githubToken, resultsDbPassword };
  }

  return {
    configureAws: true,
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

export async function runInitWorkflow(path: string = defaultFitCliConfigPath()): Promise<string> {
  const existing = loadFitCliConfig(path);
  const answers = await promptForConfig(existing.config);
  const config = initAnswersToConfig(answers, existing.config);
  const savedPath = saveFitCliConfig(config, existing.path);
  console.log(`Saved fit-cli config to ${savedPath}`);
  return savedPath;
}

export async function main(): Promise<void> {
  await runInitWorkflow();
}

if (isMain(import.meta.url)) {
  runCli(main);
}
