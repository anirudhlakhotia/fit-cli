#!/usr/bin/env node
import {
  FIT_CLI_CONFIG_VERSION,
  defaultFitCliConfigPath,
  loadFitCliConfig,
  saveFitCliConfig,
  type FitCliConfig,
} from "./util/non-fit/config.js";
import { isMain, runCli } from "./util/non-fit/cli.js";
import { input, password } from "./util/non-fit/prompts.js";

const DEFAULT_AWS_REGION = "us-east-1";
const DEFAULT_EC2_INSTANCE_TYPE = "c5.xlarge";

export interface InitAnswers {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  profile: string;
  instanceType: string;
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function initDefaultsFromConfig(config?: FitCliConfig): InitAnswers {
  return {
    accessKeyId: config?.aws?.accessKeyId ?? "",
    secretAccessKey: "",
    region: config?.aws?.region ?? DEFAULT_AWS_REGION,
    profile: config?.aws?.profile ?? "",
    instanceType: config?.aws?.instanceType ?? DEFAULT_EC2_INSTANCE_TYPE,
  };
}

export function initDefaultsFromEnv(env: NodeJS.ProcessEnv): InitAnswers {
  return {
    accessKeyId: env.AWS_ACCESS_KEY_ID ?? "",
    secretAccessKey: "",
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? DEFAULT_AWS_REGION,
    profile: env.AWS_PROFILE ?? "",
    instanceType: env.FIT_EC2_INSTANCE_TYPE ?? DEFAULT_EC2_INSTANCE_TYPE,
  };
}

export function initAnswersToConfig(answers: InitAnswers, existing?: FitCliConfig): FitCliConfig {
  const accessKeyId = trimOptional(answers.accessKeyId);
  const enteredSecretAccessKey = trimOptional(answers.secretAccessKey);
  const region = trimOptional(answers.region) ?? DEFAULT_AWS_REGION;
  const profile = trimOptional(answers.profile);
  const instanceType = trimOptional(answers.instanceType) ?? DEFAULT_EC2_INSTANCE_TYPE;
  const secretAccessKey = enteredSecretAccessKey ?? (accessKeyId ? existing?.aws?.secretAccessKey : undefined);

  return {
    version: FIT_CLI_CONFIG_VERSION,
    aws: {
      ...(accessKeyId ? { accessKeyId } : {}),
      ...(secretAccessKey ? { secretAccessKey } : {}),
      ...(region ? { region } : {}),
      ...(profile ? { profile } : {}),
      ...(instanceType ? { instanceType } : {}),
    },
  };
}

function buildInitialDefaults(existing?: FitCliConfig): InitAnswers {
  return existing ? initDefaultsFromConfig(existing) : initDefaultsFromEnv(process.env);
}

async function promptForConfig(existing?: FitCliConfig): Promise<InitAnswers> {
  const defaults = buildInitialDefaults(existing);
  return {
    accessKeyId: await input({
      promptId: "init.aws.access-key-id",
      message: "AWS access key id (optional):",
      default: defaults.accessKeyId,
    }),
    secretAccessKey: await password({
      promptId: "init.aws.secret-access-key",
      message: existing?.aws?.secretAccessKey
        ? "AWS secret access key (optional; leave blank to keep the saved value):"
        : "AWS secret access key (optional):",
      mask: true,
      replay: {
        serializeResponse: () => null,
        deserializeResponse: () => "",
      },
    }),
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
