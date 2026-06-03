/**
 * The "Stop performer" guided flow.
 *
 * Run this flow on its own:
 *   npx tsx src/workflows/performers/stop-performer/index.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { type Sdk } from "../../../util/sdk/sdks.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import { askVersion } from "../build-performer/ask-version.js";
import { buildPerformerImageName } from "../build-performer/build-performer.js";
import {
  runningContainersForImage,
  stopPerformerContainers,
  type DockerContainerSummary,
} from "../check-running-performer/index.js";
export { stopPerformerContainers } from "../check-running-performer/index.js";

export interface StopPerformerDeps {
  runningContainersForImage: (imageName: string) => Promise<DockerContainerSummary[] | null>;
  stopPerformerContainers: (containerIds: string[]) => Promise<boolean>;
}

const DEFAULT_DEPS: StopPerformerDeps = {
  runningContainersForImage,
  stopPerformerContainers,
};

/** Stop any running containers for the chosen performer image. */
export async function stopPerformer(
  sdk: Sdk,
  version?: string,
  deps: StopPerformerDeps = DEFAULT_DEPS,
): Promise<boolean> {
  const imageName = buildPerformerImageName(sdk, version);
  const runningContainers = await deps.runningContainersForImage(imageName);
  if (runningContainers === null) {
    return false;
  }

  if (runningContainers.length === 0) {
    console.log(`→ The ${sdk.name} performer is not running.`);
    return true;
  }

  return deps.stopPerformerContainers(runningContainers.map((container) => container.id));
}

/** Guided flow for choosing and stopping a performer Docker image. */
export async function runStopPerformerWorkflow(): Promise<void> {
  const sdk = await chooseSdk("Which SDK performer do you want to stop?");
  const version = await askVersion();
  await stopPerformer(sdk, version);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    await runStopPerformerWorkflow();
  });
}
