/**
 * upload-run-artifacts — at the end of a run, copy the run's artifact directory
 * (/tmp/fit-cli/<run>) up to S3. This lets results outlive the local box or the
 * (ephemeral) GitHub Actions runner, and lets the GitHub job summary stay small:
 * it can link to S3 rather than inlining megabytes of JUnit output (which blows
 * the 1024k step-summary cap).
 *
 * Best-effort: a skipped or failed upload never fails the run. It runs only
 * inside GitHub Actions — where the runner is ephemeral and AWS creds are present
 * via OIDC — so local runs don't surprise-upload to the shared bucket; no GHA
 * config is needed to switch it on. The destination bucket and prefix are fixed,
 * mirroring the fixed AWS region — the bucket lives in us-west-2 (see AWS_REGION).
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { fitCliWarn } from "../../../util/non-fit/fit-cli-log.js";
import { uploadDirectoryToS3 } from "../../../cloud/util/aws/upload-directory.js";

/** Bucket run artifacts are uploaded to (us-west-2, see AWS_REGION). */
export const ARTIFACTS_BUCKET = "fit-cli";
/** Key prefix under the bucket; each run lands in `<prefix>/<runId>/`. */
export const ARTIFACTS_PREFIX = "runs";

/** Upload runs only inside GitHub Actions, which always sets GITHUB_ACTIONS=true. */
export function artifactUploadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GITHUB_ACTIONS === "true";
}

/**
 * Upload `runDir` to s3://fit-cli/runs/<runId>/. The run id prefers GITHUB_RUN_ID
 * (so the S3 path lines up with the Actions run) and falls back to the run
 * directory's own name for local runs. Returns the destination URI on success,
 * or null when skipped (disabled / dir missing) or failed — it never throws, so
 * it's safe to call from a teardown/finally path.
 */
export async function uploadRunArtifacts(runDir: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (!artifactUploadEnabled(env)) {
    return null;
  }
  if (!existsSync(runDir)) {
    return null;
  }
  const runId = env.GITHUB_RUN_ID ?? basename(runDir);
  const destination = `s3://${ARTIFACTS_BUCKET}/${ARTIFACTS_PREFIX}/${runId}/`;
  try {
    console.log(`\nUploading run artifacts to ${destination} ...`);
    await uploadDirectoryToS3(runDir, destination);
    console.log(`✓ Uploaded run artifacts to ${destination}`);
    return destination;
  } catch (err) {
    fitCliWarn(`Could not upload run artifacts to ${destination}: ${(err as Error).message}`);
    return null;
  }
}
