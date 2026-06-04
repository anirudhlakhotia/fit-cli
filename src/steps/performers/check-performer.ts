/**
 * Step: check that an SDK's performer exists within transactions-fit-performer.
 * Each SDK's performer lives in performers/<performer> (JVM SDKs share "java").
 *
 * Run on its own:
 *   npx tsx src/steps/check-performer.ts dotnet
 *
 * Exits 0 if the performer exists, 1 if it does not (or the SDK is unknown).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isMain, runCli } from "../lib/cli.js";
import { FIT_PERFORMER, repoPath } from "../lib/repos.js";
import { SDKS, sdkByValue, type Sdk } from "../lib/sdks.js";

/** Absolute path to an SDK's performer within transactions-fit-performer. */
export function performerPath(sdk: Sdk): string {
  return join(repoPath(FIT_PERFORMER), "performers", sdk.performer);
}

/**
 * Report whether the SDK's performer exists, and return that result.
 */
export function checkPerformer(sdk: Sdk): boolean {
  const path = performerPath(sdk);
  if (existsSync(path)) {
    console.log(`✓ Found the ${sdk.name} performer at ${path}`);
    return true;
  }
  console.log(`✗ Could not find the ${sdk.name} performer at ${path}`);
  return false;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const value = process.argv[2];
    const sdk = value ? sdkByValue(value) : undefined;
    if (!sdk) {
      const values = SDKS.map((s) => s.value).join(" | ");
      console.error(`Usage: tsx src/steps/check-performer.ts <${values}>`);
      process.exit(2);
    }
    process.exit(checkPerformer(sdk) ? 0 : 1);
  });
}
