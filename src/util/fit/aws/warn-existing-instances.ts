/**
 * warn-existing-instances — a preflight we run before provisioning a fresh box:
 * list the EC2 instances fit-cli already owns in the target region and warn about
 * any that exist, so a forgotten, still-billing instance is noticed before a new
 * one is launched on top of it.
 *
 * "The usual" filter set: same region (via the AwsOptions region), owned by fit
 * (the fit-cli ownership tag), and the same owner — implicit, since
 * describe-instances only ever sees the account the current credentials belong
 * to. This is the FIT-specific opinion (the ownership tag, the wording of the
 * warning); the listing plumbing it composes lives in util/non-fit/aws.
 *
 * Run on its own:
 *   npx tsx src/util/fit/aws/warn-existing-instances.ts [--region eu-west-1]
 */
import { isMain, runCli } from "../../non-fit/cli.js";
import { logAwsAction, prepareAwsCli, resolveRegion, type AwsOptions } from "../../non-fit/aws/aws-cli.js";
import { checkCredentials } from "../../non-fit/aws/identity.js";
import { listInstances, LIVE_STATES } from "../../non-fit/aws/list-instances.js";
import { type InstanceInfo } from "../../non-fit/aws/parse-instance.js";
import { fitCliWarn } from "../../non-fit/fit-cli-log.js";
import { FIT_OWNER_TAG } from "./fit-instance.js";
import { formatExistingInstancesBanner, type InstanceListContext } from "./lifecycle-warning.js";

/**
 * List the fit-owned instances already running in the region and warn about each
 * one, so the user can reap a forgotten box before launching another. Returns the
 * instances found (empty if none), so callers can branch on the result if they
 * want; on its own it only warns and never blocks provisioning.
 *
 * Pass `{ warn: false }` to suppress the banner and only return the instance
 * list (useful when the caller will display its own combined banner).
 */
export async function warnAboutExistingInstances(
  options: AwsOptions = {},
  context?: InstanceListContext,
  { warn = true }: { warn?: boolean } = {},
): Promise<InstanceInfo[]> {
  const region = resolveRegion(options);
  const existing = await listInstances(FIT_OWNER_TAG, { region });
  if (existing.length === 0 || !warn) {
    return existing;
  }

  fitCliWarn(`\n${formatExistingInstancesBanner(existing, region, context)}\n`);
  return existing;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const awsOptions = await prepareAwsCli(process.argv.slice(2));
    logAwsAction("Checking for existing fit-cli EC2 instances", awsOptions, {
      tag: `${FIT_OWNER_TAG.key}=${FIT_OWNER_TAG.value}`,
      states: LIVE_STATES,
    });
    const creds = await checkCredentials(awsOptions);
    const context: InstanceListContext | undefined = creds.ok
      ? { account: creds.identity.account, creator: creds.identity.arn.split("/").at(-1) ?? creds.identity.userId }
      : undefined;
    const existing = await warnAboutExistingInstances(awsOptions, context);
    if (existing.length === 0) {
      console.log("No existing fit-cli EC2 instances — clear to provision.");
    }
  });
}
