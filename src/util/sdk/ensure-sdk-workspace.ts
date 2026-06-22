/**
 * Step: make sure any extra workspace repos an SDK needs are present.
 *
 * JVM SDKs (Java, Kotlin, Scala) now use prebuilt GHCR containers, so no
 * extra repos are needed for any SDK. This module is kept for forward
 * compatibility in case new requirements are added.
 *
 * Run on its own:
 *   bun src/util/sdk/ensure-sdk-workspace.ts java
 *
 * Exits 0 always (no extra repos are required).
 */
import { isMain, runCli } from "../non-fit/cli.js";
import type { Repo } from "../../fit/util/repos.js";
import { SDKS, sdkByValue, type Sdk } from "./sdks.js";

/** Additional repos an SDK needs locally before FIT commands can run. */
export function requiredReposForSdk(_sdk: Sdk): Repo[] {
  return [];
}

/**
 * @returns true always — JVM SDKs now use prebuilt GHCR containers so no
 * extra workspace repos are needed.
 */
export function ensureSdkWorkspace(_sdk: Sdk): Promise<boolean> {
  return Promise.resolve(true);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const value = process.argv[2];
    const sdk = value ? sdkByValue(value) : undefined;
    if (!sdk) {
      const values = SDKS.map((s) => s.value).join(" | ");
      console.error(`Usage: tsx src/util/sdk/ensure-sdk-workspace.ts <${values}>`);
      process.exit(2);
    }
    process.exit((await ensureSdkWorkspace(sdk)) ? 0 : 1);
  });
}
