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
import { run } from "../../../util/non-fit/proc.js";
import { prepareAwsCli } from "./aws-cli.js";
import { AWS_REGION } from "./aws-target.js";

/**
 * Recursively upload `localDir` to `s3Uri` (e.g. s3://bucket/prefix). Streams the
 * aws CLI's progress to the terminal. Rejects if the upload fails.
 */
export async function uploadDirectoryToS3(localDir: string, s3Uri: string): Promise<void> {
  await run("aws", ["s3", "cp", localDir, s3Uri, "--recursive", "--region", AWS_REGION]);
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
