/**
 * identity — check that AWS credentials are present and working, by asking who
 * we are with `aws sts get-caller-identity`. This is the preflight the EC2
 * workflow runs before trying to launch anything, so a missing/expired key
 * fails early with a clear message rather than midway through provisioning.
 *
 * Run on its own:
 *   npx tsx src/util/non-fit/aws/identity.ts [--region eu-west-1]
 *
 * Prints the caller identity, or the reason it couldn't be determined (exit 1).
 */
import { isMain, runCli } from "../cli.js";
import { awsJson, ensureAwsCli, logAwsAction, prepareAwsCli, type AwsOptions } from "./aws-cli.js";

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
export async function checkCredentials(options: AwsOptions = {}): Promise<CredentialsCheck> {
  if (!ensureAwsCli()) {
    return { ok: false, message: "The AWS CLI is not installed." };
  }
  try {
    const raw = await awsJson<{ Account: string; Arn: string; UserId: string }>(
      ["sts", "get-caller-identity"],
      options,
    );
    return { ok: true, identity: { account: raw.Account, arn: raw.Arn, userId: raw.UserId } };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const awsOptions = await prepareAwsCli(process.argv.slice(2));
    logAwsAction("Checking AWS credentials", awsOptions, { operation: "sts get-caller-identity" });
    const result = await checkCredentials(awsOptions);
    if (!result.ok) {
      console.error(`✗ ${result.message}`);
      process.exit(1);
    }
    console.log(`✓ Authenticated as ${result.identity.arn} (account ${result.identity.account})`);
  });
}
