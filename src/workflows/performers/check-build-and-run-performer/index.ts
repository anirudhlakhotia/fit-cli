/**
 * The "Check, build, and run performer" guided flow.
 *
 * Run this flow on its own (skipping the top-level menu; add --root <dir> to
 * point at another workspace):
 *   npx tsx src/workflows/performers/check-build-and-run-performer/index.ts
 */
import { artifactFromPath, type Artifact } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { capture, createLogFile, run, streamToFileInBackground } from "../../../util/non-fit/proc.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { type Sdk } from "../../../util/sdk/sdks.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import { askVersion } from "../build-performer/ask-version.js";
import { buildPerformerImageName } from "../build-performer/build-performer.js";
import { checkAndBuildPerformer } from "../check-and-build-performer/index.js";
import { checkRunningPerformer, stopRunningPerformer } from "../check-running-performer/index.js";
export { DEFAULT_PERFORMER_PORT } from "../performer-port.js";
import { DEFAULT_PERFORMER_PORT } from "../performer-port.js";

export interface RunningPerformer {
  // Absent when reusing a performer we didn't start (an external process on the
  // port), in which case there's no container for us to manage or log.
  containerId?: string;
  logFile?: string;
  artifacts: Artifact[];
}

function performerLogFile(sdk: Sdk, version?: string): string {
  void sdk;
  void version;
  return createLogFile("performer");
}

async function startPerformerLogCapture(
  containerId: string,
  sdk: Sdk,
  version?: string,
): Promise<string> {
  const logFile = performerLogFile(sdk, version);
  await streamToFileInBackground("docker", ["logs", "--follow", "--timestamps", containerId], logFile);
  return logFile;
}

/** Build the docker args needed to run a performer locally for FIT. */
export function checkBuildAndRunPerformerArgs(
  sdk: Sdk,
  version?: string,
  hostPort: number = DEFAULT_PERFORMER_PORT,
): string[] {
  return [
    "run",
    "--detach",
    "--rm",
    "--publish",
    `${hostPort}:${DEFAULT_PERFORMER_PORT}`,
    buildPerformerImageName(sdk, version),
  ];
}

/** Check/build the performer image, then start it in Docker for local FIT. */
export async function checkBuildAndRunPerformer(
  rootDir: string,
  sdk: Sdk,
  version?: string,
): Promise<RunningPerformer | undefined> {
  // Check what's already running first: if a performer is up (a recognised
  // container, or just something on the port), we can test against it and skip
  // locating and building the image entirely.
  const runCheck = await checkRunningPerformer(sdk, version);
  if (runCheck.action === "abort") {
    return undefined;
  }

  if (runCheck.action === "external") {
    console.log(
      `\n→ Testing against the performer already listening on port ${DEFAULT_PERFORMER_PORT}; fit-cli won't manage or stop it.`,
    );
    return { artifacts: [] };
  }

  if (runCheck.action === "reuse") {
    const containerId = runCheck.containers[0]?.id;
    if (!containerId) {
      return undefined;
    }

    try {
      const logFile = await startPerformerLogCapture(containerId, sdk, version);
      console.log(`\n✓ Streaming ${sdk.name} performer logs to ${logFile}`);
      return {
        containerId,
        logFile,
        artifacts: [artifactFromPath(logFile, `${sdk.name} performer logs captured for this FIT run`)],
      };
    } catch (err) {
      console.error(`\n✗ Failed to capture ${sdk.name} performer logs: ${(err as Error).message}`);
      return undefined;
    }
  }

  // We're going to start (or restart) the performer ourselves, so the image
  // must be located and built first.
  if (!(await checkAndBuildPerformer(rootDir, sdk, version))) {
    return undefined;
  }

  if (runCheck.action === "restart" && !(await stopRunningPerformer(runCheck.containers))) {
    return undefined;
  }

  const args = checkBuildAndRunPerformerArgs(sdk, version);
  console.log(`\nStarting performer with:\n  docker ${args.join(" ")}\n`);

  try {
    const containerId = (await capture("docker", args)).trim();
    console.log(`\n✓ Started the ${sdk.name} performer in container ${containerId}`);

    try {
      const logFile = await startPerformerLogCapture(containerId, sdk, version);
      console.log(`\n✓ Streaming ${sdk.name} performer logs to ${logFile}`);
      return {
        containerId,
        logFile,
        artifacts: [artifactFromPath(logFile, `${sdk.name} performer logs captured for this FIT run`)],
      };
    } catch (err) {
      console.error(`\n✗ Failed to capture ${sdk.name} performer logs: ${(err as Error).message}`);
      await stopPerformerContainer(containerId);
      return undefined;
    }
  } catch (err) {
    console.error(`\n✗ Failed to start the ${sdk.name} performer: ${(err as Error).message}`);
    return undefined;
  }
}

/** Stop a performer container that was started for FIT. */
export async function stopPerformerContainer(containerId: string): Promise<boolean> {
  console.log(`\nStopping performer container with:\n  docker stop ${containerId}\n`);

  try {
    await run("docker", ["stop", containerId]);
    console.log(`\n✓ Stopped performer container ${containerId}`);
    return true;
  } catch (err) {
    console.error(`\n✗ Failed to stop performer container ${containerId}: ${(err as Error).message}`);
    return false;
  }
}

/** Guided flow for choosing a performer, checking/building it, and running it. */
export async function runCheckBuildAndRunPerformer(rootDir: string): Promise<void> {
  const sdk = await chooseSdk("Which SDK performer do you want to check, build, and run?");
  const version = await askVersion();
  await checkBuildAndRunPerformer(rootDir, sdk, version);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    await runCheckBuildAndRunPerformer(rootDir);
  });
}
