#!/usr/bin/env node
import {
  FIT_CLI_CONFIG_VERSION,
  defaultFitCliConfigPath,
  loadFitCliConfig,
  saveFitCliConfig,
  type FitCliConfig,
} from "./util/fit/config.js";
import { isMain, runCli } from "./util/non-fit/cli.js";
import { confirm, input } from "./util/non-fit/prompts.js";

const DEFAULT_AWS_REGION = "us-east-1";
const DEFAULT_EC2_INSTANCE_TYPE = "c5.xlarge";

export interface AwsInitAnswers {
  region: string;
  profile: string;
  instanceType: string;
}

export interface InitAnswers {
  configureAws: boolean;
  aws?: AwsInitAnswers;
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

export function initAnswersToConfig(answers: InitAnswers): FitCliConfig {
  if (!answers.configureAws || !answers.aws) {
    return { version: FIT_CLI_CONFIG_VERSION };
  }

  const region = trimOptional(answers.aws.region) ?? DEFAULT_AWS_REGION;
  const profile = trimOptional(answers.aws.profile);
  const instanceType = trimOptional(answers.aws.instanceType) ?? DEFAULT_EC2_INSTANCE_TYPE;

  return {
    version: FIT_CLI_CONFIG_VERSION,
    ...(region || profile || instanceType
      ? {
          aws: {
            ...(region ? { region } : {}),
            ...(profile ? { profile } : {}),
            ...(instanceType ? { instanceType } : {}),
          },
        }
      : {}),
  };
}

function buildInitialDefaults(existing?: FitCliConfig): AwsInitAnswers {
  return existing ? initDefaultsFromConfig(existing) : initDefaultsFromEnv(process.env);
}

async function promptForConfig(existing?: FitCliConfig): Promise<InitAnswers> {
  const defaults = buildInitialDefaults(existing);
  const configureAws = await confirm({
    promptId: "init.aws.configure",
    message: "Configure AWS settings? This is only required for some workflows.",
    default: existing?.aws !== undefined,
  });

  if (!configureAws) {
    return { configureAws: false };
  }

  return {
    configureAws: true,
    aws: {
      region: await input({
        promptId: "init.aws.region",
        message: "AWS region:",
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
  const config = initAnswersToConfig(answers);
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
