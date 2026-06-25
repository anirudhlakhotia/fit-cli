/**
 * identity — check that AWS credentials are present and working. This is the
 * preflight the EC2 workflow runs before trying to launch anything, so a
 * missing/expired key fails early with a clear message rather than midway
 * through provisioning.
 *
 * Run on its own:
 *   bun src/cloud/util/aws/identity.ts
 *
 * Prints the caller identity, or the reason it couldn't be determined (exit 1).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ListAccountAliasesCommand } from "@aws-sdk/client-iam";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { logAwsAction, prepareAwsCli } from "./aws-cli.js";
import { iamClient, stsClient } from "./aws-clients.js";

/** Who the current credentials belong to. */
export interface CallerIdentity {
  account: string;
  arn: string;
  userId: string;
  /** Active AWS profile, if set via AWS_PROFILE or AWS_DEFAULT_PROFILE. */
  profile?: string;
}

/** The result of a credentials check: usable identity, or a reason it failed. */
export type CredentialsCheck =
  | { ok: true; identity: CallerIdentity }
  | { ok: false; message: string };

/**
 * Resolve the current AWS caller identity, or a failure with a human-readable
 * reason. Returns `ok: false` (rather than throwing) for the expected cases —
 * credentials being absent or invalid — so the workflow can report and offer
 * the local path instead.
 */
export async function checkCredentials(): Promise<CredentialsCheck> {
  try {
    const response = await stsClient.send(new GetCallerIdentityCommand({}));
    const profile = process.env.AWS_PROFILE ?? process.env.AWS_DEFAULT_PROFILE;
    return {
      ok: true,
      identity: {
        account: response.Account ?? "",
        arn: response.Arn ?? "",
        userId: response.UserId ?? "",
        ...(profile ? { profile } : {}),
      },
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Print a ✓/✗ checklist of which AWS credential sources are present. When none
 * are found, adds instructions for the three common fix paths.
 */
export function printCredentialsDiagnostic(env: NodeJS.ProcessEnv = process.env): void {
  const hasEnvVars = Boolean(env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim());
  const home = env.HOME ?? homedir();
  const hasCredentialsFile = existsSync(join(home, ".aws", "credentials"));
  const hasConfigFile = existsSync(join(home, ".aws", "config"));

  console.log("AWS credential sources:");
  console.log(`  ${hasEnvVars ? "✓" : "✗"} AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (env vars)`);
  console.log(`  ${hasCredentialsFile ? "✓" : "✗"} ~/.aws/credentials`);
  console.log(`  ${hasConfigFile ? "✓" : "✗"} ~/.aws/config`);

  if (!hasEnvVars && !hasCredentialsFile && !hasConfigFile) {
    console.log("");
    console.log("No AWS credentials found.  To get set up:");
    console.log("");
    console.log("  1. If you don't have AWS access yet, file a Zendesk ticket requesting");
    console.log('     access and ask to be added to the "cb-sdk" tenant.');
    console.log("");
    console.log("  2. Once you have access, create an access key in the AWS console");
    console.log("     (IAM → Users → your user → Security credentials → Create access key).");
    console.log("");
    console.log("  3. Install the AWS CLI if you haven't already:");
    console.log("     https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html");
    console.log("");
    console.log("  4. Configure your credentials with one of:");
    console.log("     aws configure                            (static key/secret — simplest)");
    console.log("     aws sso login --profile <profile>        (SSO)");
    console.log("     export AWS_ACCESS_KEY_ID=...             (env vars)");
    console.log("       export AWS_SECRET_ACCESS_KEY=...");
  }
}

/** Raw AWS credential values needed to forward to a remote execution target. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Verify that AWS credentials are present and valid, then extract their raw
 * values so they can be forwarded to a remote instance. Returns the credentials
 * on success, or an error-message string on failure.
 *
 * Prefers explicit env vars (fastest, covers CI / STS / assumed-role sessions);
 * falls back to the SDK credential provider chain for profile-based credentials.
 */
export async function resolveAwsCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AwsCredentials | string> {
  // Validate first — this covers all credential sources (env, profiles, SSO, IMDS).
  const check = await checkCredentials();
  if (!check.ok) {
    printCredentialsDiagnostic(env);
    return (
      `AWS credentials are required for situational FIT/SIT runs — the test-driver ` +
      `allocates cloud clusters via cbdinocluster. ${check.message}.`
    );
  }

  // Credentials are valid; extract raw values for forwarding to remote instances.
  // Explicit env vars are the common case (CI, STS sessions, assumed roles).
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
  if (accessKeyId && secretAccessKey) {
    const sessionToken = env.AWS_SESSION_TOKEN?.trim() || undefined;
    return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
  }

  // Fall back to the SDK credential provider chain for profile-based credentials.
  try {
    const creds = await fromNodeProviderChain()();
    if (!creds.accessKeyId || !creds.secretAccessKey) {
      return (
        "AWS credentials were validated but their raw values could not be read. " +
        "Please export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY explicitly."
      );
    }
    return {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    };
  } catch (err) {
    return (
      "AWS credentials were validated but could not be read for forwarding. " +
      "Please export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY explicitly. " +
      `(${err instanceof Error ? err.message : String(err)})`
    );
  }
}

/**
 * Print the account (and profile, if one is active) from a credentials check,
 * in the same indented-detail style as logAwsAction.
 */
export function logAwsIdentity(creds: CredentialsCheck): void {
  if (!creds.ok) return;
  const { account, profile } = creds.identity;
  console.log(`  account: ${account}`);
  if (profile) {
    console.log(`  profile: ${profile}`);
  }
}

/**
 * Fetch the IAM account alias for the current credentials. Returns the first
 * alias if one exists, undefined otherwise. Silently returns undefined on
 * permission errors — not all roles have iam:ListAccountAliases.
 */
export async function checkAccountAlias(): Promise<string | undefined> {
  try {
    const response = await iamClient.send(new ListAccountAliasesCommand({}));
    return response.AccountAliases?.[0];
  } catch {
    return undefined;
  }
}

const EXPECTED_ACCOUNT_ALIAS = "cb-sdk";

/**
 * Warn if the current account alias doesn't match the expected cb-sdk tenant.
 * Prints nothing if the alias couldn't be determined (e.g. missing IAM permission).
 */
export function warnIfNotCbSdkAccount(alias: string | undefined): void {
  if (alias === undefined || alias === EXPECTED_ACCOUNT_ALIAS) return;
  console.warn(`⚠  You appear to be authenticated to AWS account "${alias}", not "${EXPECTED_ACCOUNT_ALIAS}".`);
  console.warn(`   fit-cli expects the cb-sdk account.  To switch:`);
  console.warn(`     export AWS_PROFILE=cb-sdk`);
  console.warn(`     aws sso login --profile cb-sdk   # if your session has expired`);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    await prepareAwsCli();
    logAwsAction("Checking AWS credentials", { operation: "sts:GetCallerIdentity" });
    const result = await checkCredentials();
    if (!result.ok) {
      console.error(`✗ ${result.message}`);
      process.exit(1);
    }
    const profilePart = result.identity.profile ? `  profile: ${result.identity.profile}` : "";
    console.log(`✓ Authenticated as ${result.identity.arn} (account ${result.identity.account}${profilePart})`);
    const alias = await checkAccountAlias();
    if (alias !== undefined) {
      console.log(`  account alias: ${alias}`);
    }
    warnIfNotCbSdkAccount(alias);
  });
}
