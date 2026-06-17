#!/usr/bin/env node
/**
 * fit archive — zip a run artifact directory and/or upload it to S3.
 *
 *   fit archive zip <dir>
 *   fit archive s3-upload [--zip] <dir> [<s3-uri>]
 *
 * zip:        Creates <dir>.zip next to the source directory.
 * s3-upload:  Uploads the directory to S3, either as individual files (default)
 *             or as a single zip archive (--zip). <s3-uri> defaults to
 *             s3://fit-cli/runs/.
 */
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { ZipArchive } from "archiver";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3Client } from "../../cloud/util/aws/aws-clients.js";
import { uploadDirectoryToS3 } from "../../cloud/util/aws/upload-directory.js";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import { ARTIFACTS_BUCKET, ARTIFACTS_PREFIX } from "../util/aws/upload-run-artifacts.js";

function helpText(): string {
  const p = runScriptPrefix("archive");
  return `Archive (zip / S3-upload) a fit-cli run artifact directory.

Usage:
  ${p} zip <dir>
  ${p} s3-upload [--zip] <dir> [<s3-uri>]
  ${p} --help

Subcommands:
  zip         Create <dir>.zip next to the source directory.
  s3-upload   Upload <dir> to S3. Without --zip, uploads each file individually;
              with --zip, zips first and uploads the single archive.
              <s3-uri> defaults to s3://${ARTIFACTS_BUCKET}/${ARTIFACTS_PREFIX}/.`;
}

/** Zip the contents of sourceDir into a new file at outputPath. */
export async function zipDirectory(sourceDir: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    void archive.finalize();
  });
}

/** Upload a single local file to an S3 URI (s3://bucket/key). */
async function uploadFileToS3(localPath: string, s3Uri: string): Promise<void> {
  const match = s3Uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid S3 URI for a single file (must include a key): ${s3Uri}`);
  }
  const [, bucket, key] = match;
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: createReadStream(localPath),
      ContentLength: statSync(localPath).size,
    }),
  );
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
  } else {
    console.log(`Uploading ${absDir} → ${destination} ...`);
    await uploadDirectoryToS3(absDir, destination);
    console.log(`✓ Uploaded to ${destination}`);
  }
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

    console.error(`Unknown subcommand: ${subcommand}\n`);
    console.error(helpText());
    process.exit(2);
  });
}

if (isMain(import.meta.url)) {
  runArchiveMain();
}
