/**
 * aws-cli — shared helpers for the rest of cloud/util/aws. Provides config
 * preparation (so AWS_PROFILE / credentials are in place before SDK calls) and
 * console logging conventions.
 *
 * Run on its own (checks the AWS config is ready):
 *   bun src/cloud/util/aws/aws-cli.ts
 */
import { userInfo } from "node:os";
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { loadFitCliConfigEnv } from "../../../fit/util/config.js";
import { AWS_REGION } from "./aws-target.js";

const FIT_CLI_ROLE_ARN = "arn:aws:iam::958525475024:role/fit-cli-role";
let roleAssumeAttempted = false;

/**
 * Assume fit-cli-role if the current identity is not already that role.
 *
 * Uses a fresh STSClient (not the module-level singleton) so we don't prime
 * the shared client's credential cache with the pre-assume identity.  After
 * injecting the temporary credentials into process.env, all subsequently-used
 * AWS SDK clients pick them up on their first API call.
 *
 * Fails softly: a warning is printed and we continue with current credentials
 * if assume-role fails (e.g. trust policy not configured for this user).
 */
async function assumeFitCliRoleIfNeeded(): Promise<void> {
  const freshSts = new STSClient({ region: AWS_REGION });

  let currentArn: string;
  try {
    const identity = await freshSts.send(new GetCallerIdentityCommand({}));
    currentArn = identity.Arn ?? "";
  } catch {
    return;
  }

  if (currentArn.includes("fit-cli-role")) {
    console.log(`Assuming fit-cli-role (already assumed as ${currentArn})`);
    return;
  }

  console.log(`Assuming fit-cli-role...`);
  console.log(`  current identity: ${currentArn}`);

  let sessionName: string;
  try {
    sessionName = `fit-cli-${userInfo().username}`;
  } catch {
    sessionName = "fit-cli-local";
  }

  try {
    const result = await freshSts.send(
      new AssumeRoleCommand({ RoleArn: FIT_CLI_ROLE_ARN, RoleSessionName: sessionName }),
    );
    const creds = result.Credentials;
    if (!creds?.AccessKeyId || !creds?.SecretAccessKey || !creds?.SessionToken) {
      throw new Error("AssumeRole returned incomplete credentials");
    }
    process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
    process.env.AWS_SESSION_TOKEN = creds.SessionToken;
    const expiry = creds.Expiration?.toISOString() ?? "unknown";
    console.log(`✓ Assumed fit-cli-role (session expires: ${expiry})`);
  } catch (err) {
    console.warn(`⚠  Could not assume fit-cli-role: ${err instanceof Error ? err.message : String(err)}`);
    console.warn(`   Continuing with current credentials.`);
  }
}

/** Apply fit-cli config to env (sets AWS_PROFILE if configured) before SDK calls. */
export async function prepareAwsCli(): Promise<void> {
  loadFitCliConfigEnv();
  if (!roleAssumeAttempted) {
    roleAssumeAttempted = true;
    await assumeFitCliRoleIfNeeded();
  }
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

/** Print a short, consistent summary of the AWS action about to be run. */
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

if (isMain(import.meta.url)) {
  runCli(async () => {
    await prepareAwsCli();
    console.log(`✓ AWS config ready (region: ${AWS_REGION})`);
  });
}
