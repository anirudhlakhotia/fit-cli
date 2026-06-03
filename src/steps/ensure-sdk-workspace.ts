/**
 * Step: make sure any extra workspace repos an SDK needs are present.
 *
 * Right now that only means JVM SDKs, which build their FIT performers out of
 * couchbase-jvm-clients rather than transactions-fit-performer.
 *
 * Run on its own (add --root <dir> to point at another workspace):
 *   npx tsx src/steps/ensure-sdk-workspace.ts java
 *
 * Exits 0 if the SDK workspace is ready, 1 if the user chose to bail or the
 * clone failed.
 */
import { isMain, runCli } from "../lib/cli.js";
import { JVM_CLIENTS, type Repo } from "../lib/repos.js";
import { rootDirFromArgv } from "../lib/root.js";
import { SDKS, sdkByValue, type Sdk } from "../lib/sdks.js";
import { ensureRepo } from "./ensure-repo.js";

/** Additional repos an SDK needs under ROOT_DIR before FIT commands can run. */
export function requiredReposForSdk(sdk: Sdk): Repo[] {
  return sdk.jvm ? [JVM_CLIENTS] : [];
}

/**
 * @returns true if the SDK's workspace repos are ready, false if the user
 * chose to exit or a clone failed.
 */
export async function ensureSdkWorkspace(sdk: Sdk, rootDir: string): Promise<boolean> {
  for (const repo of requiredReposForSdk(sdk)) {
    console.log(`\n${sdk.name} is a JVM SDK, so it needs ${repo.name}.`);
    if (!(await ensureRepo(repo, rootDir))) {
      return false;
    }
  }
  return true;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir, positionals } = rootDirFromArgv(process.argv.slice(2));
    const value = positionals[0];
    const sdk = value ? sdkByValue(value) : undefined;
    if (!sdk) {
      const values = SDKS.map((s) => s.value).join(" | ");
      console.error(`Usage: tsx src/steps/ensure-sdk-workspace.ts <${values}> [--root <dir>]`);
      process.exit(2);
    }
    process.exit((await ensureSdkWorkspace(sdk, rootDir)) ? 0 : 1);
  });
}
