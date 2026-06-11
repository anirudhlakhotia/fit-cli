/**
 * image — resolve an AMI to launch. `findUbuntuAmi` asks EC2 for Canonical's
 * Ubuntu 22.04 LTS images in the fixed region and picks the most recent, so we
 * don't hardcode a per-region AMI id that goes stale. The "newest by creation
 * date" choice is a pure function (`pickLatestImageId`) so it can be unit tested
 * (see tests/image.test.ts).
 *
 * If `ec2:DescribeImages` is not permitted (e.g. a restricted CI user), the
 * function falls back to AWS's public SSM Parameter Store entry for the same
 * image — no IAM permissions are needed to read public SSM parameters.
 *
 * Run on its own:
 *   npx tsx src/util/non-fit/aws/image.ts
 */
import { isMain, runCli } from "../cli.js";
import { awsJson, logAwsAction, prepareAwsCli } from "./aws-cli.js";

/** Canonical's AWS account id — the trusted owner of official Ubuntu images. */
export const CANONICAL_OWNER_ID = "099720109477";

/** Default name pattern: Ubuntu 22.04 LTS (Jammy), amd64, SSD-backed server. */
export const UBUNTU_2204_NAME_PATTERN = "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*";

/** The fields of a describe-images entry we use. */
export interface AmiImage {
  ImageId: string;
  CreationDate?: string;
  Name?: string;
}

/**
 * Pick the id of the most recently created image, or null if the list is empty.
 * CreationDate is an ISO-8601 string, so a lexical comparison orders them
 * correctly (later timestamps sort higher).
 */
export function pickLatestImageId(images: readonly AmiImage[]): string | null {
  let latest: AmiImage | undefined;
  for (const image of images) {
    if (!latest || (image.CreationDate ?? "") > (latest.CreationDate ?? "")) {
      latest = image;
    }
  }
  return latest?.ImageId ?? null;
}

/**
 * Find the latest Ubuntu 22.04 LTS amd64 AMI in the fixed region. Throws if no
 * matching image is found (which would mean the filters are wrong).
 */
export async function findUbuntuAmi(): Promise<string> {
  try {
    const response = await awsJson<{ Images?: AmiImage[] }>(
      [
        "ec2",
        "describe-images",
        "--owners",
        CANONICAL_OWNER_ID,
        "--filters",
        `Name=name,Values=${UBUNTU_2204_NAME_PATTERN}`,
        "Name=state,Values=available",
        "Name=architecture,Values=x86_64",
      ],
    );
    const ami = pickLatestImageId(response.Images ?? []);
    if (!ami) {
      throw new Error("No Ubuntu 22.04 amd64 AMI found — check the region and your account permissions.");
    }
    return ami;
  } catch (describeErr) {
    // Fall back to the AWS public SSM Parameter Store entry — no IAM
    // permissions are needed to read these public parameters, so this works
    // even when ec2:DescribeImages is not allowed.
    try {
      const ssmPath = "/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id";
      const result = await awsJson<{ Parameters?: { Value?: string }[]; InvalidParameters?: string[] }>(
        ["ssm", "get-parameters", "--names", ssmPath],
      );
      const amiId = result.Parameters?.[0]?.Value;
      if (!amiId) {
        throw new Error(`SSM parameter ${ssmPath} returned no value.`, { cause: describeErr });
      }
      console.warn(`Warning: ec2:DescribeImages not permitted — resolved Ubuntu 22.04 AMI via SSM: ${amiId}`);
      return amiId;
    } catch {
      // Re-throw the original DescribeImages error since that's the root cause.
      throw describeErr;
    }
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    await prepareAwsCli();
    logAwsAction("Looking up Ubuntu AMI", {
      owner: CANONICAL_OWNER_ID,
      namePattern: UBUNTU_2204_NAME_PATTERN,
    });
    console.log(`✓ Latest Ubuntu 22.04 amd64 AMI: ${await findUbuntuAmi()}`);
  });
}
