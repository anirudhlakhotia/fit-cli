/**
 * The "Check and build performer" guided flow.
 *
 * Run this flow on its own (skipping the top-level menu; add --root <dir> to
 * point at another workspace):
 *   npx tsx src/workflows/performers/check-and-build-performer/index.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { confirm } from "../../../util/non-fit/prompts.js";
import { JENKINS_SDK } from "../../../util/fit/repos.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { type Sdk } from "../../../util/sdk/sdks.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import { ensureRepo } from "../../../util/fit/ensure-repo.js";
import { ensureSdkWorkspace } from "../../../util/sdk/ensure-sdk-workspace.js";
import { askVersion } from "../build-performer/ask-version.js";
import { buildPerformer, describeBuildPerformerCommand } from "../build-performer/build-performer.js";
import { performerStatus } from "../check-performer/check-performer.js";

/** Check for a performer image and offer to build it if it is missing. */
export async function checkAndBuildPerformer(
  rootDir: string,
  sdk: Sdk,
  version?: string,
): Promise<boolean> {
  const status = await performerStatus(sdk, rootDir, version);

  if (status.pathExists) {
    console.log(`✓ Found the ${sdk.name} performer at ${status.path}`);
  } else {
    console.log(`✗ Could not find the ${sdk.name} performer at ${status.path}`);
    return false;
  }

  if (!status.dockerAvailable) {
    console.log("✗ Could not find docker on your PATH");
    return false;
  }

  if (status.imageExists) {
    console.log(`✓ Found the ${sdk.name} performer Docker image ${status.imageName}`);
    return true;
  }

  console.log(`✗ Could not find the ${sdk.name} performer Docker image ${status.imageName}`);
  console.log(`\nBuilding performer with:\n  ${describeBuildPerformerCommand(rootDir, sdk, version)}\n`);

  const shouldBuild = await confirm({
    promptId: "performer.build-now",
    message: `Build the ${sdk.name} performer Docker image now?`,
  });
  if (!shouldBuild) {
    return false;
  }

  if (!(await ensureRepo(JENKINS_SDK, rootDir))) {
    console.log("\nOnce jenkins-sdk is in place, run fit-cli again.");
    return false;
  }

  if (!(await ensureSdkWorkspace(sdk, rootDir))) {
    console.log("\nOnce the SDK workspace repos are in place, run fit-cli again.");
    return false;
  }

  console.log("\nBuilding performer...\n");
  try {
    await buildPerformer(rootDir, sdk, version);
  } catch (err) {
    console.error(`\n✗ Failed to build the ${sdk.name} performer: ${(err as Error).message}`);
    return false;
  }

  const updatedStatus = await performerStatus(sdk, rootDir, version);
  if (!updatedStatus.imageExists) {
    console.log(`\n✗ Built the ${sdk.name} performer, but ${updatedStatus.imageName} is still missing`);
    return false;
  }

  console.log(`\n✓ Built the ${sdk.name} performer Docker image ${updatedStatus.imageName}`);
  return true;
}

/** Guided flow for choosing a performer, checking it, and building it if needed. */
export async function runCheckAndBuildPerformer(rootDir: string): Promise<void> {
  const sdk = await chooseSdk("Which SDK performer do you want to check?");
  const version = await askVersion();
  await checkAndBuildPerformer(rootDir, sdk, version);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    await runCheckAndBuildPerformer(rootDir);
  });
}
