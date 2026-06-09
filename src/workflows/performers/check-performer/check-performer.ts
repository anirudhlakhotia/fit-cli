/**
 * Step: check that an SDK's performer exists on disk and as a Docker image.
 *
 * Non-JVM SDKs live in transactions-fit-performer/performers/<performer>.
 * JVM SDKs (Java, Kotlin, Scala) use prebuilt GHCR containers; there is no
 * on-disk source to check.
 *
 * Run on its own (add --root <dir> to point at another workspace):
 *   npx tsx src/workflows/performers/check-performer/check-performer.ts dotnet
 *
 * Exits 0 if the performer path and Docker image both exist, 1 if either does
 * not (or the SDK is unknown).
 */
import { join } from "node:path";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { fitCliError } from "../../../util/non-fit/fit-cli-log.js";
import { FIT_PERFORMER, repoPath } from "../../../util/fit/repos.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { SDKS, sdkByValue, type Sdk } from "../../../util/sdk/sdks.js";
import { createLocalFitExecutionContext, type FitExecutionContext } from "../../fit-shared/util/remote-fit-run.js";
import { buildPerformerImageName } from "../build-performer/build-performer.js";

export interface PerformerStatus {
  /** Undefined for JVM SDKs, which use prebuilt GHCR containers with no on-disk source. */
  path: string | undefined;
  pathExists: boolean;
  imageName: string;
  dockerAvailable: boolean;
  imageExists: boolean;
}

/** Absolute path to an SDK's performer on disk, under ROOT_DIR. Undefined for JVM SDKs. */
export function performerPath(sdk: Sdk, rootDir: string): string | undefined {
  if (sdk.jvm) {
    return undefined;
  }
  return join(repoPath(FIT_PERFORMER, rootDir), "performers", sdk.performer);
}

/** Docker inspect args used to check whether an image exists locally. */
export function performerImageInspectArgs(imageName: string): string[] {
  return ["image", "inspect", "--format={{.Id}}", imageName];
}

/** Inspect the on-disk performer and its Docker image. */
export async function performerStatus(
  execution: FitExecutionContext,
  sdk: Sdk,
  version?: string,
  gerritRef?: string,
): Promise<PerformerStatus> {
  const path = performerPath(sdk, execution.rootDir);
  const imageName = buildPerformerImageName(sdk, version, gerritRef);
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

  return {
    path,
    pathExists: path === undefined ? true : await execution.pathExists(path),
    imageName,
    dockerAvailable,
    imageExists,
  };
}

/** Report whether the SDK's performer exists on disk and as a Docker image. */
export async function checkPerformer(
  execution: FitExecutionContext,
  sdk: Sdk,
  version?: string,
  gerritRef?: string,
): Promise<boolean> {
  const status = await performerStatus(execution, sdk, version, gerritRef);

  if (status.path === undefined) {
    console.log(`✓ ${sdk.name} uses a prebuilt GHCR container (no on-disk source to check)`);
  } else if (status.pathExists) {
    console.log(`✓ Found the ${sdk.name} performer at ${status.path}`);
  } else {
    fitCliError(`Could not find the ${sdk.name} performer at ${status.path}`);
  }

  if (!status.dockerAvailable) {
    fitCliError("Could not find docker on your PATH");
    return false;
  }

  if (status.imageExists) {
    console.log(`✓ Found the ${sdk.name} performer Docker image ${status.imageName}`);
  } else {
    fitCliError(`Could not find the ${sdk.name} performer Docker image ${status.imageName}`);
  }

  return status.pathExists && status.imageExists;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir, positionals } = rootDirFromArgv(process.argv.slice(2));
    const value = positionals[0];
    const sdk = value ? sdkByValue(value) : undefined;
    const version = positionals[1];
    if (!sdk) {
      const values = SDKS.map((s) => s.value).join(" | ");
      console.error(
        `Usage: tsx src/workflows/performers/check-performer.ts <${values}> [version] [--root <dir>]`,
      );
      process.exit(2);
    }
    process.exit((await checkPerformer(createLocalFitExecutionContext(rootDir), sdk, version)) ? 0 : 1);
  });
}
