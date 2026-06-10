// It's set to this to support https://github.com/couchbaselabs/sdkqe-github-runners-tf/blob/master/terraform/aws/runners/main.tf
export const DEFAULT_AWS_REGION = "us-west-2";

export type AwsRegionSource = "option" | "env" | "default";

export interface ResolveAwsRegionOptions {
  region?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedAwsRegion {
  region: string;
  source: AwsRegionSource;
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveAwsRegion(options: ResolveAwsRegionOptions = {}): ResolvedAwsRegion {
  const explicit = trimOptional(options.region);
  if (explicit) {
    return { region: explicit, source: "option" };
  }

  const env = options.env ?? process.env;
  const fromEnv = trimOptional(env.AWS_REGION) ?? trimOptional(env.AWS_DEFAULT_REGION);
  if (fromEnv) {
    return { region: fromEnv, source: "env" };
  }

  return { region: DEFAULT_AWS_REGION, source: "default" };
}

export function awsRegionOverrideHelp(): string {
  return "Override with AWS_REGION or AWS_DEFAULT_REGION, pass `--region`, or save a different default with `npm run init`.";
}

export function defaultAwsRegionMessage(region: string = DEFAULT_AWS_REGION): string {
  return `No AWS region set, defaulting to ${region}. ${awsRegionOverrideHelp()}`;
}

export function awsRegionPromptMessage(defaultRegion: string = DEFAULT_AWS_REGION): string {
  return `AWS region (default: ${defaultRegion}; ${awsRegionOverrideHelp()}):`;
}
