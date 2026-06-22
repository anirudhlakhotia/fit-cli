/**
 * Step: check whether an SDK's prebuilt performer Docker image is present locally.
 *
 * Performers are always prebuilt GHCR images (couchbase/<sdk>-fit-performer);
 * there is no on-disk source to check.
 *
 * Run on its own:
 *   bun src/fit/performers/check-performer/check-performer.ts java
 *
 * Exits 0 if the Docker image exists locally, 1 if it does not (or the SDK is unknown).
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliError } from "../../../util/non-fit/fit-cli-log.js";
import { PREBUILT_PERFORMER_SDKS, sdkByValue, type Sdk } from "../../../util/sdk/sdks.js";
import { createLocalFitExecutionContext, type FitExecutionContext } from "../../shared/util/remote-fit-run.js";
import { performerImageName } from "../util/performer-image.js";

export interface PerformerStatus {
  /** The fully-qualified GHCR image reference for this performer. */
  imageName: string;
  dockerAvailable: boolean;
  imageExists: boolean;
}

/** Docker inspect args used to check whether an image exists locally. */
export function performerImageInspectArgs(imageName: string): string[] {
  return ["image", "inspect", "--format={{.Id}}", imageName];
}

/** Inspect whether the prebuilt performer Docker image is present locally. */
export async function performerStatus(
  execution: FitExecutionContext,
  sdk: Sdk,
  version?: string,
): Promise<PerformerStatus> {
  const imageName = performerImageName(sdk, version);
  const dockerAvailable = await execution.commandAvailable(execution.dockerCommand);
  let imageExists = false;

  if (dockerAvailable) {
    try {
      await execution.capture(execution.dockerCommand, performerImageInspectArgs(imageName));
      imageExists = true;
    } catch {
      imageExists = false;
    }
  }

  return { imageName, dockerAvailable, imageExists };
}

/** Report whether the SDK's prebuilt performer Docker image exists locally. */
export async function checkPerformer(
  execution: FitExecutionContext,
  sdk: Sdk,
  version?: string,
): Promise<boolean> {
  const status = await performerStatus(execution, sdk, version);

  if (!status.dockerAvailable) {
    fitCliError("Could not find docker on your PATH");
    return false;
  }

  if (status.imageExists) {
    console.log(`✓ Found the ${sdk.name} performer Docker image ${status.imageName}`);
  } else {
    fitCliError(`Could not find the ${sdk.name} performer Docker image ${status.imageName}`);
  }

  return status.imageExists;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const positionals = process.argv.slice(2);
    const value = positionals[0];
    const sdk = value ? sdkByValue(value) : undefined;
    const version = positionals[1];
    if (!sdk) {
      const values = PREBUILT_PERFORMER_SDKS.map((s) => s.value).join(" | ");
      console.error(
        `Usage: tsx src/fit/performers/check-performer/check-performer.ts <${values}> [tag]`,
      );
      process.exit(2);
    }
    process.exit((await checkPerformer(createLocalFitExecutionContext(), sdk, version)) ? 0 : 1);
  });
}
