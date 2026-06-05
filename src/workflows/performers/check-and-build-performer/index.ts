/**
 * The "Check and build performer" guided flow.
 *
 * Run this flow on its own (skipping the top-level menu; add --root <dir> to
 * point at another workspace):
 *   npx tsx src/workflows/performers/check-and-build-performer/index.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { artifactFromPath, type RunOutput } from "../../../util/non-fit/artifacts.js";
import { fitCliError } from "../../../util/non-fit/fit-cli-log.js";
import { createLogFile } from "../../../util/non-fit/proc.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { type Sdk } from "../../../util/sdk/sdks.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import { createLocalFitExecutionContext, type FitExecutionContext } from "../../fit-shared/remote-fit-run.js";
import { askVersion } from "../build-performer/ask-version.js";
import { buildPerformerArgs, dockerImageComponent } from "../build-performer/build-performer.js";
import { performerStatus } from "../check-performer/check-performer.js";

export function performerBuildLogStem(iteration: number, sdk: Sdk, version?: string): string {
  return `${iteration}-${sdk.value}-${dockerImageComponent(version ?? "main")}-performer-build`;
}

function performerBuildLogFile(iteration: number, sdk: Sdk, version?: string): string {
  return createLogFile(performerBuildLogStem(iteration, sdk, version));
}

/** Check for a performer image and offer to build it if it is missing. */
export async function checkAndBuildPerformer(
  execution: FitExecutionContext,
  sdk: Sdk,
  version?: string,
  iteration: number = 0,
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
  const args = buildPerformerArgs(execution.rootDir, sdk, version);
  const logFile = performerBuildLogFile(iteration, sdk, version);
  const targetLogFile = execution.targetFilePath(logFile);
  console.log(`\nBuilding performer with:\n  cd ${execution.jenkinsDir} && ./gradlew ${args.join(" ")}\n`);
  console.log(`Streaming performer build output to:\n  ${targetLogFile}\n`);

  if (!(await execution.ensureBuildWorkspace(sdk))) {
    return false;
  }

  console.log("\nBuilding performer...\n");
  try {
    await execution.runToFile("./gradlew", args, targetLogFile, execution.jenkinsDir);
  } catch (err) {
    if (await execution.pathExists(targetLogFile)) {
      await execution.collectFile(targetLogFile, logFile);
      execution.artifacts.push(
        artifactFromPath(logFile, `${sdk.name} performer build stdout/stderr captured for this run`),
      );
    }
    fitCliError(`\nFailed to build the ${sdk.name} performer: ${(err as Error).message}`);
    return false;
  }

  await execution.collectFile(targetLogFile, logFile);
  execution.artifacts.push(
    artifactFromPath(logFile, `${sdk.name} performer build stdout/stderr captured for this run`),
  );

  const updatedStatus = await performerStatus(execution, sdk, version);
  if (!updatedStatus.imageExists) {
    fitCliError(`\nBuilt the ${sdk.name} performer, but ${updatedStatus.imageName} is still missing`);
    return false;
  }

  console.log(`\n✓ Built the ${sdk.name} performer Docker image ${updatedStatus.imageName}`);
  return true;
}

/** Guided flow for choosing a performer, checking it, and building it if needed. */
export async function runCheckAndBuildPerformer(rootDir: string): Promise<Partial<RunOutput>> {
  const sdk = await chooseSdk("Which SDK performer do you want to check?");
  const version = await askVersion();
  const execution = createLocalFitExecutionContext(rootDir);
  if (!(await execution.ensureWorkspace(sdk))) {
    return { artifacts: execution.artifacts, details: execution.details };
  }
  await checkAndBuildPerformer(execution, sdk, version);
  return { artifacts: execution.artifacts, details: execution.details };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    return await runCheckAndBuildPerformer(rootDir);
  });
}
