/**
 * aws-cli — the thin shared layer the rest of util/non-fit/aws sits on. We drive
 * the real `aws` CLI (rather than an SDK), exactly as the cluster code drives
 * `cbdinocluster`: it keeps dependencies at zero, reuses the caller's existing
 * AWS config/credentials, and means every module here can be exercised on its
 * own. Nothing in this directory knows anything about FIT.
 *
 * Run on its own (checks the aws CLI is usable):
 *   npx tsx src/util/non-fit/aws/aws-cli.ts
 */
import { isMain, runCli } from "../cli.js";
import { ensureFitCliConfigEnv } from "../../../fit/util/config.js";
import { fitCliError } from "../fit-cli-log.js";
import { capture } from "../proc.js";
import { findOnPath } from "../which.js";
import { defaultAwsRegionMessage, resolveAwsRegion } from "./region.js";

/** Where to get the AWS CLI, shown when it can't be found on the PATH. */
export const AWS_CLI_URL = "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html";

/** Options common to every aws invocation. */
export interface AwsOptions {
  /** Region to target. Defaults to AWS_REGION / AWS_DEFAULT_REGION, then us-east-1. */
  region?: string;
}

/**
 * The region to use: an explicit option wins, otherwise the standard AWS env
 * vars, otherwise fit-cli falls back to us-east-1.
 */
export function resolveRegion(options: AwsOptions = {}): string {
  return resolveAwsRegion({ region: options.region }).region;
}

/** Read a `--region` flag from argv, supporting both `--region x` and `--region=x`. */
export function regionFromArgv(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--region") {
      return argv[i + 1];
    }
    if (arg.startsWith("--region=")) {
      return arg.slice("--region=".length);
    }
  }
  return undefined;
}

/** Load config sources, resolve the AWS region, and return the resulting options. */
export async function prepareAwsCli(argv: readonly string[]): Promise<AwsOptions> {
  await ensureFitCliConfigEnv({
    promptId: "aws.config.create",
    promptMessage: "No fit-cli config found. Run `npm run init` now before continuing with this AWS command?",
  });
  return { region: regionFromArgv(argv) };
}

function formatAwsDetail(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") {
    return value.description ? `Symbol(${value.description})` : "Symbol()";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return typeof value;
}

/** Print a short, consistent summary of the AWS action the CLI is about to run. */
export function logAwsAction(action: string, options: AwsOptions = {}, details: Record<string, unknown> = {}): void {
  const { region, source } = resolveAwsRegion({ region: options.region });
  console.log(`${action} (region: ${region}${source === "default" ? ", default" : ""})`);
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      console.log(`  ${key}: ${value.join(", ")}`);
      continue;
    }
    console.log(`  ${key}: ${formatAwsDetail(value)}`);
  }
}

/**
 * Make sure the `aws` CLI is on the PATH, returning its location or null (after
 * printing where to get it). The other helpers here invoke the bare `aws`
 * command, which Node resolves on the PATH; this is the friendly up-front check.
 */
export function ensureAwsCli(): string | null {
  const onPath = findOnPath("aws");
  if (onPath) {
    return onPath;
  }
  fitCliError(`The AWS CLI ('aws') is not on your PATH. You can install it from ${AWS_CLI_URL}.`);
  return null;
}

function regionArgs(options: AwsOptions): string[] {
  const region = resolveRegion(options);
  return region ? ["--region", region] : [];
}

/**
 * Run an `aws` command with JSON output and return the parsed result. Throws a
 * clean error (with stderr) if the command fails, and a clear one if the output
 * isn't the JSON we expected.
 */
export async function awsJson<T = unknown>(args: string[], options: AwsOptions = {}): Promise<T> {
  const fullArgs = [...regionArgs(options), ...args, "--output", "json"];
  const stdout = await capture("aws", fullArgs);
  const trimmed = stdout.trim();
  if (trimmed === "") {
    return undefined as T;
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error(`Could not parse JSON from \`aws ${args.join(" ")}\`:\n${trimmed}`);
  }
}

/**
 * Run an `aws` command with plain text output and return it (trimmed). Used for
 * the few calls whose result is a raw string rather than JSON — e.g. fetching
 * key material.
 */
export async function awsText(args: string[], options: AwsOptions = {}): Promise<string> {
  const stdout = await capture("aws", [...regionArgs(options), ...args, "--output", "text"]);
  return stdout.trim();
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    await prepareAwsCli(process.argv.slice(2));
    if (!ensureAwsCli()) {
      process.exit(1);
    }
    const { region, source } = resolveAwsRegion();
    console.log(`✓ aws CLI found (region: ${region}${source === "default" ? ", default" : ""})`);
    if (source === "default") {
      console.log(defaultAwsRegionMessage(region));
    }
    const version = await capture("aws", ["--version"]).catch((err: Error) => err.message);
    console.log(version.trim());
  });
}
