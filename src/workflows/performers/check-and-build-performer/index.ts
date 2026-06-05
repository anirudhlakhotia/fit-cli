/**
 * The "Check and build performer" guided flow.
 *
 * Run this flow on its own (skipping the top-level menu; add --root <dir> to
 * point at another workspace):
 *   npx tsx src/workflows/performers/check-and-build-performer/index.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliError } from "../../../util/non-fit/fit-cli-log.js";
import { confirm } from "../../../util/non-fit/prompts.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { type Sdk } from "../../../util/sdk/sdks.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import { createLocalFitExecutionContext, type FitExecutionContext } from "../../fit-shared/remote-fit-run.js";
import { askVersion } from "../build-performer/ask-version.js";
import { buildPerformerArgs } from "../build-performer/build-performer.js";
import { performerStatus } from "../check-performer/check-performer.js";

/** Check for a performer image and offer to build it if it is missing. */
export async function checkAndBuildPerformer(
  execution: FitExecutionContext,
  sdk: Sdk,
  version?: string,
): Promise<boolean> {
  const status = await performerStatus(execution, sdk, version);

  if (status.pathExists) {
    console.log(`✓ Found the ${sdk.name} performer at ${status.path}`);
  } else {
    fitCliError(`Could not find the ${sdk.name} performer at ${status.path}`);
    return false;
  }

  if (!status.dockerAvailable) {
    fitCliError("Could not find docker on your PATH");
    return false;
  }

  if (status.imageExists) {
    console.log(`✓ Found the ${sdk.name} performer Docker image ${status.imageName}`);
    return true;
  }

  fitCliError(`Could not find the ${sdk.name} performer Docker image ${status.imageName}`);
  console.log(`\nBuilding performer with:\n  cd ${execution.jenkinsDir} && ./gradlew ${buildPerformerArgs(execution.rootDir, sdk, version).join(" ")}\n`);

  const shouldBuild = await confirm({
    promptId: "performer.build-now",
    message: `Build the ${sdk.name} performer Docker image now?`,
  });
  if (!shouldBuild) {
    return false;
  }

  if (!(await execution.ensureBuildWorkspace(sdk))) {
    return false;
  }

  console.log("\nBuilding performer...\n");
  try {
    await execution.run("./gradlew", buildPerformerArgs(execution.rootDir, sdk, version), execution.jenkinsDir);
  } catch (err) {
    fitCliError(`\nFailed to build the ${sdk.name} performer: ${(err as Error).message}`);
    return false;
  }

  const updatedStatus = await performerStatus(execution, sdk, version);
  if (!updatedStatus.imageExists) {
    fitCliError(`\nBuilt the ${sdk.name} performer, but ${updatedStatus.imageName} is still missing`);
    return false;
  }

  console.log(`\n✓ Built the ${sdk.name} performer Docker image ${updatedStatus.imageName}`);
  return true;
}

/** Guided flow for choosing a performer, checking it, and building it if needed. */
export async function runCheckAndBuildPerformer(rootDir: string): Promise<void> {
  const sdk = await chooseSdk("Which SDK performer do you want to check?");
  const version = await askVersion();
  const execution = createLocalFitExecutionContext(rootDir);
  if (!(await execution.ensureWorkspace(sdk))) {
    return;
  }
  await checkAndBuildPerformer(execution, sdk, version);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    await runCheckAndBuildPerformer(rootDir);
  });
}
