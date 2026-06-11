/**
 * identity — check that AWS credentials are present and working, by asking who
 * we are with `aws sts get-caller-identity`. This is the preflight the EC2
 * workflow runs before trying to launch anything, so a missing/expired key
 * fails early with a clear message rather than midway through provisioning.
 *
 * Run on its own:
 *   npx tsx src/util/non-fit/aws/identity.ts
 *
 * Prints the caller identity, or the reason it couldn't be determined (exit 1).
 */
import { isMain, runCli } from "../cli.js";
import { capture } from "../proc.js";
import { awsJson, ensureAwsCli, logAwsAction, prepareAwsCli } from "./aws-cli.js";

/** Who the current credentials belong to. */
export interface CallerIdentity {
  account: string;
  arn: string;
  userId: string;
}

/** The result of a credentials check: usable identity, or a reason it failed. */
export type CredentialsCheck =
  | { ok: true; identity: CallerIdentity }
  | { ok: false; message: string };

/**
 * Resolve the current AWS caller identity, or a failure with a human-readable
 * reason. Returns `ok: false` (rather than throwing) for the expected cases —
 * the aws CLI not being installed, or credentials being absent/invalid — so the
 * workflow can report and offer the local path instead.
 */
export async function checkCredentials(): Promise<CredentialsCheck> {
  if (!ensureAwsCli()) {
    return { ok: false, message: "The AWS CLI is not installed." };
  }
  try {
    const raw = await awsJson<{ Account: string; Arn: string; UserId: string }>(
      ["sts", "get-caller-identity"],
    );
    return { ok: true, identity: { account: raw.Account, arn: raw.Arn, userId: raw.UserId } };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
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
 * falls back to `aws configure get` for profile-based credentials.
 */
export async function resolveAwsCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AwsCredentials | string> {
  // Validate first — this covers all credential sources (env, profiles, SSO, IMDS).
  const check = await checkCredentials();
  if (!check.ok) {
    return (
      `AWS credentials are required for situational FIT/SIT runs — the test-driver ` +
      `allocates cloud clusters via cbdinocluster. ${check.message}. ` +
      `Set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY or run \`aws configure\`.`
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

  // Fall back to `aws configure get` for profile-based credentials (~/.aws/credentials).
  try {
    const keyId = (await capture("aws", ["configure", "get", "aws_access_key_id"])).trim();
    const secret = (await capture("aws", ["configure", "get", "aws_secret_access_key"])).trim();
    if (!keyId || !secret) {
      return (
        "AWS credentials were validated but their raw values could not be read. " +
        "Please export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY explicitly."
      );
    }
    let sessionToken: string | undefined;
    try {
      const raw = (await capture("aws", ["configure", "get", "aws_session_token"])).trim();
      if (raw) {
        sessionToken = raw;
      }
    } catch {
      // Session token is optional; ignore if absent.
    }
    return { accessKeyId: keyId, secretAccessKey: secret, ...(sessionToken ? { sessionToken } : {}) };
  } catch (err) {
    return (
      "AWS credentials were validated but could not be read for forwarding. " +
      "Please export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY explicitly. " +
      `(${err instanceof Error ? err.message : String(err)})`
    );
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    await prepareAwsCli();
    logAwsAction("Checking AWS credentials", { operation: "sts get-caller-identity" });
    const result = await checkCredentials();
    if (!result.ok) {
      console.error(`✗ ${result.message}`);
      process.exit(1);
    }
    console.log(`✓ Authenticated as ${result.identity.arn} (account ${result.identity.account})`);
  });
}
