/**
 * Step: check that an SDK's performer exists on disk.
 *
 * Non-JVM SDKs live in transactions-fit-performer/performers/<performer>.
 * JVM SDKs (Java, Kotlin, Scala) live in couchbase-jvm-clients as their own
 * <performer>-fit-performer directory.
 *
 * Run on its own (add --root <dir> to point at another workspace):
 *   npx tsx src/workflows/fit-functional/steps/performers/check-performer.ts dotnet
 *
 * Exits 0 if the performer exists, 1 if it does not (or the SDK is unknown).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isMain, runCli } from "../../../../lib/cli.js";
import { FIT_PERFORMER, JVM_CLIENTS, repoPath } from "../../../../lib/repos.js";
import { rootDirFromArgv } from "../../../../lib/root.js";
import { SDKS, sdkByValue, type Sdk } from "../../../../lib/sdks.js";

/** Absolute path to an SDK's performer on disk, under ROOT_DIR. */
export function performerPath(sdk: Sdk, rootDir: string): string {
  if (sdk.jvm) {
    return join(repoPath(JVM_CLIENTS, rootDir), `${sdk.performer}-fit-performer`);
  }
  return join(repoPath(FIT_PERFORMER, rootDir), "performers", sdk.performer);
}

/**
 * Report whether the SDK's performer exists, and return that result.
 */
export function checkPerformer(sdk: Sdk, rootDir: string): boolean {
  const path = performerPath(sdk, rootDir);
  if (existsSync(path)) {
    console.log(`✓ Found the ${sdk.name} performer at ${path}`);
    return true;
  }
  console.log(`✗ Could not find the ${sdk.name} performer at ${path}`);
  return false;
}

if (isMain(import.meta.url)) {
  // checkPerformer is synchronous, but every step CLI uses the same async
  // runCli entry point for consistency.
  // eslint-disable-next-line @typescript-eslint/require-await
  runCli(async () => {
    const { rootDir, positionals } = rootDirFromArgv(process.argv.slice(2));
    const value = positionals[0];
    const sdk = value ? sdkByValue(value) : undefined;
    if (!sdk) {
      const values = SDKS.map((s) => s.value).join(" | ");
      console.error(
        `Usage: tsx src/workflows/fit-functional/steps/performers/check-performer.ts <${values}> [--root <dir>]`,
      );
      process.exit(2);
    }
    process.exit(checkPerformer(sdk, rootDir) ? 0 : 1);
  });
}
