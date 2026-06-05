/**
 * The "Run performer" guided flow.
 *
 * Run this flow on its own (skipping the top-level menu; add --root <dir> to
 * point at another workspace):
 *   npx tsx src/workflows/performers/run-performer/run-performer.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { type Sdk } from "../../../util/sdk/sdks.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import { createLocalFitExecutionContext } from "../../fit-shared/util/remote-fit-run.js";
import { askVersion } from "../build-performer/ask-version.js";
import { checkBuildAndRunPerformer } from "../check-build-and-run-performer/check-build-and-run-performer.js";

/** Run a performer Docker image, building it first if needed. */
export async function runPerformer(rootDir: string, sdk: Sdk, version?: string): Promise<boolean> {
  const performer = await checkBuildAndRunPerformer(createLocalFitExecutionContext(rootDir), sdk, version);
  if (!performer) {
    return false;
  }

  if (performer.logFile) {
    console.log(`\nPerformer logs are streaming to:\n  ${performer.logFile}`);
  }
  return true;
}

/** Guided flow for choosing and running a performer Docker image. */
export async function runPerformerWorkflow(rootDir: string): Promise<void> {
  const sdk = await chooseSdk("Which SDK performer do you want to run?");
  const version = await askVersion();
  await runPerformer(rootDir, sdk, version);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    await runPerformerWorkflow(rootDir);
  });
}
