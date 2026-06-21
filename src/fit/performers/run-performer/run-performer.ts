/**
 * The "Run performer" guided flow.
 *
 * Run this flow on its own (skipping the top-level menu):
 *   npx tsx src/fit/performers/run-performer/run-performer.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { type Sdk } from "../../../util/sdk/sdks.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import { createLocalFitExecutionContext } from "../../shared/util/remote-fit-run.js";
import { askPerformerTag } from "../util/ask-performer-image.js";
import { checkBuildAndRunPerformer } from "../check-build-and-run-performer/check-build-and-run-performer.js";

/** Run a performer Docker image, building it first if needed. */
export async function runPerformer(sdk: Sdk, version?: string): Promise<boolean> {
  const performer = await checkBuildAndRunPerformer(
    createLocalFitExecutionContext(),
    sdk,
    { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0 },
    version,
  );
  if (!performer) {
    return false;
  }

  if (performer.logFile) {
    console.log(`\nPerformer logs are streaming to:\n  ${performer.logFile}`);
  }
  return true;
}

/** Guided flow for choosing and running a performer Docker image. */
export async function runPerformerWorkflow(): Promise<void> {
  const sdk = await chooseSdk("Which SDK performer do you want to run?");
  const version = await askPerformerTag(sdk);
  await runPerformer(sdk, version);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    await runPerformerWorkflow();
  });
}
