#!/usr/bin/env node
/**
 * fit archive — zip a run artifact directory and/or upload it to S3.
 *
 *   fit archive zip <dir>
 *   fit archive s3-upload [--zip] <dir> [<s3-uri>]
 *   fit archive fetch <s3-zip-uri> [<output-dir>]
 *
 * zip:        Creates <dir>.zip next to the source directory.
 * s3-upload:  Uploads the directory to S3, either as individual files (default)
 *             or as a single zip archive (--zip). <s3-uri> defaults to
 *             s3://fit-cli/runs/.
 * fetch:      Downloads a .zip from S3 and extracts it locally. Output dir
 *             defaults to /tmp/fetched/<name-without-.zip>.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { ZipArchive } from "archiver";
import { Upload } from "@aws-sdk/lib-storage";
import { s3Client } from "../../cloud/util/aws/aws-clients.js";
import { checkAwsCredentials } from "../../cloud/util/aws/identity.js";
import { uploadDirectoryToS3 } from "../../cloud/util/aws/upload-directory.js";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import { run } from "../../util/non-fit/proc.js";
import { ARTIFACTS_BUCKET, ARTIFACTS_PREFIX } from "../util/aws/upload-run-artifacts.js";

function helpText(): string {
  const p = runScriptPrefix("archive");
  return `Archive (zip / S3-upload / fetch) a fit-cli run artifact directory.

Usage:
  ${p} zip <dir>
  ${p} s3-upload [--zip] <dir> [<s3-uri>]
  ${p} fetch <s3-zip-uri> [<output-dir>]
  ${p} --help

Subcommands:
  zip         Create <dir>.zip next to the source directory.
  s3-upload   Upload <dir> to S3. Without --zip, uploads each file individually;
              with --zip, zips first and uploads the single archive.
              <s3-uri> defaults to s3://${ARTIFACTS_BUCKET}/${ARTIFACTS_PREFIX}/.
  fetch       Download a .zip from S3 and extract it locally.
              <output-dir> defaults to /tmp/fetched/<name-without-.zip>.`;
}

/**
 * Glob patterns for run-dir content that must never leave the machine — secrets
 * that fit-cli keeps in `_internal` (SSH private keys, driver env files). Excluded
 * from the S3 zip here; the GitHub Actions upload-artifact step mirrors this with
 * its own `!.../_internal/**` path exclusion (it can't import this constant).
 */
export const ARTIFACT_UPLOAD_EXCLUDE_GLOBS = ["**/_internal/**"];

/** Zip the contents of sourceDir into a new file at outputPath, excluding secrets. */
export async function zipDirectory(sourceDir: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    // glob (rather than directory()) so we can exclude `_internal` — archiver's
    // directory() has no ignore option. dot:true keeps dotfiles that directory() included.
    archive.glob("**/*", { cwd: sourceDir, ignore: ARTIFACT_UPLOAD_EXCLUDE_GLOBS, dot: true });
    void archive.finalize();
  });
}

/** Upload a single local file to an S3 URI (s3://bucket/key). */
export async function uploadFileToS3(localPath: string, s3Uri: string): Promise<void> {
  const match = s3Uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid S3 URI for a single file (must include a key): ${s3Uri}`);
  }
  const [, bucket, key] = match;
  // Upload uses multipart under the hood for large files and retries each part,
  // avoiding the non-retryable streaming timeout that PutObjectCommand hits.
  await new Upload({
    client: s3Client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: createReadStream(localPath),
    },
  }).done();
}

async function cmdZip(argv: string[]): Promise<void> {
  const [dir, ...extra] = argv;
  if (!dir || extra.length > 0) {
    console.error(`Usage: ${runScriptPrefix("archive")} zip <dir>`);
    process.exit(2);
  }
  const absDir = resolve(dir);
  if (!existsSync(absDir)) {
    console.error(`Directory not found: ${absDir}`);
    process.exit(1);
  }
  const outputPath = `${absDir}.zip`;
  console.log(`Zipping ${absDir} → ${outputPath} ...`);
  await zipDirectory(absDir, outputPath);
  console.log(`✓ Created ${outputPath}`);
}

async function cmdS3Upload(argv: string[]): Promise<void> {
  const creds = await checkAwsCredentials();
  if (!creds.ok) {
    throw new Error(`AWS credentials are not usable: ${creds.message}`);
  }

  const args = [...argv];
  const zipIdx = args.indexOf("--zip");
  const doZip = zipIdx !== -1;
  if (doZip) args.splice(zipIdx, 1);

  const [dir, s3UriArg, ...extra] = args;
  if (!dir || extra.length > 0) {
    console.error(`Usage: ${runScriptPrefix("archive")} s3-upload [--zip] <dir> [<s3-uri>]`);
    process.exit(2);
  }
  const absDir = resolve(dir);
  if (!existsSync(absDir)) {
    console.error(`Directory not found: ${absDir}`);
    process.exit(1);
  }
  const dirName = basename(absDir);
  const destination = s3UriArg ?? `s3://${ARTIFACTS_BUCKET}/${ARTIFACTS_PREFIX}/${dirName}/`;

  if (doZip) {
    const zipPath = `${absDir}.zip`;
    console.log(`Zipping ${absDir} → ${zipPath} ...`);
    await zipDirectory(absDir, zipPath);
    console.log(`✓ Created ${zipPath}`);
    const zipKey = destination.endsWith("/") ? `${destination}${dirName}.zip` : destination;
    console.log(`Uploading ${zipPath} → ${zipKey} ...`);
    await uploadFileToS3(zipPath, zipKey);
    console.log(`✓ Uploaded to ${zipKey}`);
    console.log(`  Download:  aws s3 cp ${zipKey} .`);
  } else {
    console.log(`Uploading ${absDir} → ${destination} ...`);
    await uploadDirectoryToS3(absDir, destination);
    console.log(`✓ Uploaded to ${destination}`);
    console.log(`  Download:  aws s3 cp --recursive ${destination} ${dirName}/`);
  }
}

/** Download a single S3 URI (s3://bucket/key) to a local file path. */
export async function downloadFileFromS3(
  s3Uri: string,
  localPath: string,
  onProgress?: (downloaded: number, total: number | undefined) => void,
): Promise<void> {
  const match = s3Uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid S3 URI: ${s3Uri}`);
  const [, bucket, key] = match;
  mkdirSync(dirname(localPath), { recursive: true });
  const resp = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!resp.Body) throw new Error(`Empty response body for ${s3Uri}`);
  const total = resp.ContentLength;
  let downloaded = 0;
  onProgress?.(0, total);
  const tracker = new Transform({
    transform(chunk: Buffer, _, callback) {
      downloaded += chunk.length;
      onProgress?.(downloaded, total);
      callback(null, chunk);
    },
  });
  await pipeline(resp.Body as NodeJS.ReadableStream, tracker, createWriteStream(localPath));
}

async function cmdFetch(argv: string[]): Promise<void> {
  const creds = await checkAwsCredentials();
  if (!creds.ok) {
    throw new Error(`AWS credentials are not usable: ${creds.message}`);
  }

  const [s3Uri, outputDirArg, ...extra] = argv;
  if (!s3Uri || extra.length > 0) {
    console.error(`Usage: ${runScriptPrefix("archive")} fetch <s3-zip-uri> [<output-dir>]`);
    process.exit(2);
  }
  if (!s3Uri.endsWith(".zip")) {
    console.error(`Expected a .zip S3 URI, got: ${s3Uri}`);
    process.exit(1);
  }
  const zipName = basename(s3Uri);
  const runName = zipName.replace(/\.zip$/, "");
  const outputDir = outputDirArg ?? `/tmp/fetched/${runName}`;
  const zipPath = `${outputDir}.zip`;

  const MB = 1024 * 1024;
  let progressLineLen = 0;

  function renderProgress(downloaded: number, total: number | undefined): void {
    const dlMB = (downloaded / MB).toFixed(1);
    let line: string;
    if (total) {
      const pct = downloaded / total;
      const width = 30;
      const filled = Math.round(pct * width);
      const bar = "█".repeat(filled) + "░".repeat(width - filled);
      const totalMB = (total / MB).toFixed(1);
      line = `  [${bar}] ${dlMB} / ${totalMB} MB (${Math.round(pct * 100)}%)`;
    } else {
      line = `  ${dlMB} MB downloaded`;
    }
    process.stderr.write(`\r${line.padEnd(progressLineLen)}`);
    progressLineLen = line.length;
  }

  console.log(`Downloading ${s3Uri} → ${zipPath} ...`);
  await downloadFileFromS3(s3Uri, zipPath, renderProgress);
  process.stderr.write(`\r${" ".repeat(progressLineLen)}\r`);
  console.log(`✓ Downloaded to ${zipPath}`);

  mkdirSync(outputDir, { recursive: true });
  console.log(`Extracting ${zipPath} → ${outputDir} ...`);
  await run("unzip", ["-o", zipPath, "-d", outputDir]);
  console.log(`✓ Extracted to ${outputDir}`);
}

export function runArchiveMain(): void {
  const [subcommand, ...rest] = process.argv.slice(2);

  runCli(async () => {
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      console.log(helpText());
      if (!subcommand) process.exit(2);
      return;
    }

    if (subcommand === "zip") {
      await cmdZip(rest);
      return;
    }

    if (subcommand === "s3-upload") {
      await cmdS3Upload(rest);
      return;
    }

    if (subcommand === "fetch") {
      await cmdFetch(rest);
      return;
    }

    console.error(`Unknown subcommand: ${subcommand}\n`);
    console.error(helpText());
    process.exit(2);
  });
}

if (isMain(import.meta.url)) {
  runArchiveMain();
}
