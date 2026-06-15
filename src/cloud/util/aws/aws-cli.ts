/**
 * aws-cli — the thin shared layer the rest of cloud/util/aws sits on. We drive
 * the real `aws` CLI (rather than an SDK), exactly as the cluster code drives
 * `cbdinocluster`: it keeps dependencies at zero, reuses the caller's existing
 * AWS config/credentials, and means every module here can be exercised on its
 * own. Nothing in this directory knows anything about FIT.
 *
 * Every invocation targets the single fixed region in aws-target.ts; the region
 * is not configurable.
 *
 * Run on its own (checks the aws CLI is usable):
 *   npx tsx src/cloud/util/aws/aws-cli.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { ensureFitCliConfigEnv } from "../../../fit/util/config.js";
import { fitCliError } from "../../../util/non-fit/fit-cli-log.js";
import { capture } from "../../../util/non-fit/proc.js";
import { findOnPath } from "../../../util/non-fit/which.js";
import { AWS_REGION } from "./aws-target.js";

/** Where to get the AWS CLI, shown when it can't be found on the PATH. */
export const AWS_CLI_URL = "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html";

/** Load config sources so credentials/env are in place before running aws commands. */
export async function prepareAwsCli(): Promise<void> {
  // Config only contributes AWS_PROFILE; skip prompt when explicit creds are already set (e.g. GHA OIDC).
  const hasExplicitCredentials = Boolean(process.env.AWS_ACCESS_KEY_ID);
  await ensureFitCliConfigEnv({
    promptId: "aws.config.create",
    promptMessage: "No fit-cli config found. Run `bun run config -- edit` now before continuing with this AWS command?",
    promptIfMissing: hasExplicitCredentials ? false : undefined,
  });
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
export function logAwsAction(action: string, details: Record<string, unknown> = {}): void {
  console.log(`${action} (region: ${AWS_REGION})`);
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

/**
 * Run an `aws` command with JSON output and return the parsed result. Throws a
 * clean error (with stderr) if the command fails, and a clear one if the output
 * isn't the JSON we expected.
 */
export async function awsJson<T = unknown>(args: string[]): Promise<T> {
  const fullArgs = ["--region", AWS_REGION, ...args, "--output", "json"];
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
export async function awsText(args: string[]): Promise<string> {
  const stdout = await capture("aws", ["--region", AWS_REGION, ...args, "--output", "text"]);
  return stdout.trim();
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    await prepareAwsCli();
    if (!ensureAwsCli()) {
      process.exit(1);
    }
    console.log(`✓ aws CLI found (region: ${AWS_REGION})`);
    const version = await capture("aws", ["--version"]).catch((err: Error) => err.message);
    console.log(version.trim());
  });
}
