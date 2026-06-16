/**
 * upload-directory — copy a local directory tree to S3, recursively. Thin
 * plumbing over `aws s3 cp --recursive`: it uses only PutObject (no bucket
 * listing, unlike `aws s3 sync`), so a write-only role is enough. Like the rest
 * of this directory it knows nothing about FIT — callers pick the bucket/key.
 *
 * Run on its own:
 *   npx tsx src/cloud/util/aws/upload-directory.ts ./local s3://my-bucket/prefix
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { runHiddenUntilFailure } from "../../../util/non-fit/proc.js";
import { prepareAwsCli } from "./aws-cli.js";
import { AWS_REGION } from "./aws-target.js";

/**
 * Recursively upload `localDir` to `s3Uri` (e.g. s3://bucket/prefix). Hides the
 * aws CLI's noisy progress output and only surfaces it on failure. Rejects if the
 * upload fails.
 */
export async function uploadDirectoryToS3(localDir: string, s3Uri: string): Promise<void> {
  await runHiddenUntilFailure("aws", ["s3", "cp", localDir, s3Uri, "--recursive", "--region", AWS_REGION], process.cwd(), { quiet: true });
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const [localDir, s3Uri, ...extra] = process.argv.slice(2);
    if (!localDir || !s3Uri || extra.length > 0) {
      throw new Error("Usage: upload-directory.ts <localDir> <s3://bucket/prefix>");
    }
    await prepareAwsCli();
    await uploadDirectoryToS3(localDir, s3Uri);
    console.log(`✓ Uploaded ${localDir} to ${s3Uri}`);
  });
}
