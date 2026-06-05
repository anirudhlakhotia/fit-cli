/**
 * The "Check, build, and run performer" guided flow.
 *
 * Run this flow on its own (skipping the top-level menu; add --root <dir> to
 * point at another workspace):
 *   npx tsx src/workflows/performers/check-build-and-run-performer/check-build-and-run-performer.ts
 */
import { join } from "node:path";
import { artifactFromPath, type RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { createLogFile } from "../../../util/non-fit/proc.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { type Sdk } from "../../../util/sdk/sdks.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import {
  createLocalFitExecutionContext,
  type FitExecutionContext,
} from "../../fit-shared/util/remote-fit-run.js";
import { askVersion } from "../build-performer/ask-version.js";
import {
  buildPerformerImageName,
  dockerImageComponent,
  performerBuildIdentity,
} from "../build-performer/build-performer.js";
import { checkoutFitGerritRef } from "../checkout-fit-gerrit-ref/checkout-fit-gerrit-ref.js";
import { checkAndBuildPerformer } from "../check-and-build-performer/check-and-build-performer.js";
import { checkRunningPerformer, stopRunningPerformer } from "../check-running-performer/check-running-performer.js";
export { DEFAULT_PERFORMER_PORT } from "../util/performer-port.js";
import { DEFAULT_PERFORMER_PORT, type PortInUsePolicy } from "../util/performer-port.js";

export interface RunningPerformer extends RunOutput {
  // Absent when reusing a performer we didn't start (an external process on the
  // port), in which case there's no container for us to manage or log.
  containerId?: string;
  logFile?: string;
  // True when we're testing against a performer that was already running rather
  // than one we started, so we should leave it alone instead of stopping it.
  reused?: boolean;
}

export function performerLogStem(iteration: number, sdk: Sdk, version?: string, gerritRef?: string): string {
  return join(
    `it${iteration}`,
    `${sdk.value}-${dockerImageComponent(performerBuildIdentity(version, gerritRef))}-performer`,
  );
}

function performerLogFile(iteration: number, sdk: Sdk, version?: string, gerritRef?: string): string {
  return createLogFile(performerLogStem(iteration, sdk, version, gerritRef));
}

/** Build the docker args needed to run a performer locally for FIT. */
export function checkBuildAndRunPerformerArgs(
  sdk: Sdk,
  version?: string,
  hostPort: number = DEFAULT_PERFORMER_PORT,
  dockerNetwork?: string,
  gerritRef?: string,
): string[] {
  return [
    "run",
    "--detach",
    "--rm",
    ...(dockerNetwork ? ["--network", dockerNetwork] : []),
    "--publish",
    `${hostPort}:${DEFAULT_PERFORMER_PORT}`,
    buildPerformerImageName(sdk, version, gerritRef),
  ];
}

/**
 * Check/build the performer image, then start it in Docker for FIT.
 *
 * @param onPortInUse When set, decide non-interactively what to do if the port
 *   is already taken (the definition-driven flow passes the file's policy);
 *   when omitted, the guided flow prompts.
 * @param hostPort The host port the performer listens on; defaults to
 *   {@link DEFAULT_PERFORMER_PORT}. The container always listens on
 *   {@link DEFAULT_PERFORMER_PORT} internally; this is the published host port
 *   that test-driver connects to.
 */
export async function checkBuildAndRunPerformer(
  execution: FitExecutionContext,
  sdk: Sdk,
  version?: string,
  dockerNetwork?: string,
  onPortInUse?: PortInUsePolicy,
  hostPort: number = DEFAULT_PERFORMER_PORT,
  iteration: number = 0,
  gerritRef?: string,
): Promise<RunningPerformer | undefined> {
  if (!(await execution.ensureWorkspace(sdk))) {
    return undefined;
  }

  if (gerritRef && !(await checkoutFitGerritRef(execution, gerritRef))) {
    return undefined;
  }

  // Check what's already running first: if a performer is up (a recognised
  // container, or just something on the port), we can test against it and skip
  // locating and building the image entirely.
  const runCheck = await checkRunningPerformer(execution, sdk, version, onPortInUse, hostPort, gerritRef);
  if (runCheck.action === "abort") {
    return undefined;
  }

  if (runCheck.action === "external") {
    console.log(
      `\n→ Testing against the performer already listening on port ${hostPort}; fit-cli won't manage or stop it.`,
    );
    return { artifacts: [], details: [] };
  }

  if (runCheck.action === "reuse") {
    const containerId = runCheck.containers[0]?.id;
    if (!containerId) {
      return undefined;
    }
    const logFile = performerLogFile(iteration, sdk, version, gerritRef);
    return {
      containerId,
      logFile,
      reused: true,
      artifacts: [artifactFromPath(logFile, `${sdk.name} performer logs captured for this FIT run`)],
      details: [],
    };
  }

  // We're going to start (or restart) the performer ourselves, so the image
  // must be located and built first.
  if (!(await checkAndBuildPerformer(execution, sdk, version, iteration, gerritRef))) {
    return undefined;
  }

  if (runCheck.action === "restart" && !(await stopRunningPerformer(execution, runCheck.containers))) {
    return undefined;
  }

  if (dockerNetwork) {
    console.log(`\n→ Starting the performer on Docker network ${dockerNetwork} so it can reach the cluster container.`);
  }
  const args = execution.performerRunArgs(buildPerformerImageName(sdk, version, gerritRef), hostPort, dockerNetwork);
  console.log(`\nStarting performer with:\n  docker ${args.join(" ")}\n`);

  try {
    const containerId = (await execution.capture(execution.dockerCommand, args)).trim();
    console.log(`\n✓ Started the ${sdk.name} performer in container ${containerId}`);
    const logFile = performerLogFile(iteration, sdk, version, gerritRef);
    return {
      containerId,
      logFile,
      artifacts: [artifactFromPath(logFile, `${sdk.name} performer logs captured for this FIT run`)],
      details: [],
    };
  } catch (err) {
    console.error(`\n✗ Failed to start the ${sdk.name} performer: ${(err as Error).message}`);
    return undefined;
  }
}

/** Stop a performer started by checkBuildAndRunPerformer, collecting logs when needed. */
export async function stopManagedPerformer(
  execution: FitExecutionContext,
  performer: RunningPerformer | undefined,
): Promise<void> {
  if (!performer?.containerId) {
    if (performer?.logFile) {
      console.log(`\nPerformer logs:\n  ${performer.logFile}`);
    }
    return;
  }

  // We didn't start this performer (we're reusing one that was already up), so
  // leave it running rather than stopping someone else's process.
  if (performer.reused) {
    console.log(`\n→ Leaving the reused performer container ${performer.containerId} running.`);
    return;
  }

  if (performer.logFile) {
    const targetLogFile = execution.targetFilePath(performer.logFile);
    try {
      await execution.runToFile("docker", ["logs", "--timestamps", performer.containerId], targetLogFile);
      await execution.collectFile(targetLogFile, performer.logFile);
      console.log(`\n✓ Saved performer logs to ${performer.logFile}`);
    } catch (err) {
      console.warn(`\nCould not collect performer logs from ${execution.description}: ${(err as Error).message}`);
    }
  }

  console.log(`\nStopping performer container with:\n  docker stop ${performer.containerId}\n`);
  try {
    await execution.run(execution.dockerCommand, ["stop", performer.containerId]);
    console.log(`\n✓ Stopped performer container ${performer.containerId}`);
  } catch (err) {
    console.error(`\n✗ Failed to stop performer container ${performer.containerId}: ${(err as Error).message}`);
  }

  if (performer.logFile) {
    console.log(`\nPerformer logs:\n  ${performer.logFile}`);
  }
}

/** Guided flow for choosing a performer, checking/building it, and running it. */
export async function runCheckBuildAndRunPerformer(rootDir: string): Promise<void> {
  const sdk = await chooseSdk("Which SDK performer do you want to check, build, and run?");
  const version = await askVersion();
  const execution = createLocalFitExecutionContext(rootDir);
  const performer = await checkBuildAndRunPerformer(execution, sdk, version);
  await stopManagedPerformer(execution, performer);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    await runCheckBuildAndRunPerformer(rootDir);
  });
}
