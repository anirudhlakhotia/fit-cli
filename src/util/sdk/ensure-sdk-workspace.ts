/**
 * Step: make sure any extra workspace repos an SDK needs are present.
 *
 * JVM SDKs (Java, Kotlin, Scala) now use prebuilt GHCR containers, so no
 * extra repos are needed for any SDK. This module is kept for forward
 * compatibility in case new requirements are added.
 *
 * Run on its own (add --root <dir> to point at another workspace):
 *   npx tsx src/util/sdk/ensure-sdk-workspace.ts java
 *
 * Exits 0 always (no extra repos are required).
 */
import { isMain, runCli } from "../non-fit/cli.js";
import type { Repo } from "../../fit/util/repos.js";
import { rootDirFromArgv } from "../../fit/util/root.js";
import { SDKS, sdkByValue, type Sdk } from "./sdks.js";

/** Additional repos an SDK needs under ROOT_DIR before FIT commands can run. */
export function requiredReposForSdk(_sdk: Sdk): Repo[] {
  return [];
}

/**
 * @returns true always — JVM SDKs now use prebuilt GHCR containers so no
 * extra workspace repos are needed.
 */
export function ensureSdkWorkspace(_sdk: Sdk, _rootDir: string): Promise<boolean> {
  return Promise.resolve(true);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir, positionals } = rootDirFromArgv(process.argv.slice(2));
    const value = positionals[0];
    const sdk = value ? sdkByValue(value) : undefined;
    if (!sdk) {
      const values = SDKS.map((s) => s.value).join(" | ");
      console.error(`Usage: tsx src/util/sdk/ensure-sdk-workspace.ts <${values}> [--root <dir>]`);
      process.exit(2);
    }
    process.exit((await ensureSdkWorkspace(sdk, rootDir)) ? 0 : 1);
  });
}
