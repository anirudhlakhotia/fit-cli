/**
 * The "Check and run performer" guided flow.
 *
 * Performers are always prebuilt images pulled from GHCR; fit-cli no longer
 * builds them from source.
 *
 * Run this flow on its own (skipping the top-level menu):
 *   bun src/fit/performers/check-build-and-run-performer/check-build-and-run-performer.ts
 */
import { join } from "node:path";
import { artifactFromPath, type RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { createLogFile } from "../../../util/non-fit/proc.js";
import type { DefinitionRunPath } from "../../../util/non-fit/replay.js";
import { type Sdk } from "../../../util/sdk/sdks.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import {
  createLocalFitExecutionContext,
  type FitExecutionContext,
} from "../../shared/util/remote-fit-run.js";
import { askPerformerTag } from "../util/ask-performer-image.js";
import { checkoutFitGerritRef } from "../checkout-fit-gerrit-ref/checkout-fit-gerrit-ref.js";
import { checkAndPullPerformer } from "../check-and-pull-performer/check-and-pull-performer.js";
import { performerImageName } from "../util/performer-image.js";
import { checkRunningPerformer, stopRunningPerformer } from "../check-running-performer/check-running-performer.js";
export { DEFAULT_PERFORMER_PORT } from "../util/performer-port.js";
import { DEFAULT_PERFORMER_PORT, type PortInUsePolicy } from "../util/performer-port.js";

/** Normalize a performer tag into a filesystem-safe log-file component. */
function tagLogComponent(version?: string): string {
  return (
    (version ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[._-]+|[._-]+$/g, "") || "main"
  );
}

export interface RunningPerformer extends RunOutput {
  // Absent when reusing a performer we didn't start (an external process on the
  // port), in which case there's no container for us to manage or log.
  containerId?: string;
  logFile?: string;
  // True when we're testing against a performer that was already running rather
  // than one we started, so we should leave it alone instead of stopping it.
  reused?: boolean;
}

export function performerLogStem(path: DefinitionRunPath, sdk: Sdk, version?: string): string {
  const base = path.clusterlessSession
    ? join("instances", String(path.instanceIndex), "clusterless-sessions", String(path.sessionIndex))
    : join("instances", String(path.instanceIndex), "clusters", String(path.clusterIndex), "sessions", String(path.sessionIndex));
  return join(base, `${sdk.value}-${tagLogComponent(version)}-performer`);
}

function performerLogFile(path: DefinitionRunPath, sdk: Sdk, version?: string): string {
  return createLogFile(performerLogStem(path, sdk, version));
}

/** Build the docker args needed to run a performer locally for FIT. */
export function checkBuildAndRunPerformerArgs(
  sdk: Sdk,
  version?: string,
  hostPort: number = DEFAULT_PERFORMER_PORT,
  dockerNetwork?: string,
): string[] {
  return [
    "run",
    "--detach",
    "--rm",
    ...(dockerNetwork ? ["--network", dockerNetwork] : []),
    "--publish",
    `${hostPort}:${DEFAULT_PERFORMER_PORT}`,
    performerImageName(sdk, version),
  ];
}

/**
 * Pull the prebuilt performer image from GHCR, then start it in Docker for FIT.
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
  path: DefinitionRunPath,
  version?: string,
  dockerNetwork?: string,
  onPortInUse?: PortInUsePolicy,
  hostPort: number = DEFAULT_PERFORMER_PORT,
  gerritRef?: string,
): Promise<RunningPerformer | undefined> {
  // A Gerrit ref checks out transactions-fit-performer (the FIT test driver) at a
  // specific patchset; the performer image itself is always a prebuilt GHCR image
  // and independent of the ref. The repo must be present before we can check it out.
  if (gerritRef) {
    if (!(await execution.ensureWorkspace())) {
      return undefined;
    }
    if (!(await checkoutFitGerritRef(execution, gerritRef))) {
      return undefined;
    }
  }

  // Check what's already running first: if a performer is up (a recognised
  // container, or just something on the port), we can test against it and skip
  // pulling the image entirely.
  const runCheck = await checkRunningPerformer(execution, sdk, version, onPortInUse, hostPort);
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
    const logFile = performerLogFile(path, sdk, version);
    return {
      containerId,
      logFile,
      reused: true,
      artifacts: [artifactFromPath(logFile, `${sdk.name} performer logs captured for this FIT run`)],
      details: [],
    };
  }

  // We're going to start (or restart) the performer ourselves, so pull the
  // prebuilt image from GHCR first.
  if (!(await checkAndPullPerformer(execution, sdk, version))) {
    return undefined;
  }

  if (runCheck.action === "restart" && !(await stopRunningPerformer(execution, runCheck.containers))) {
    return undefined;
  }

  const imageName = performerImageName(sdk, version);
  if (dockerNetwork) {
    console.log(`\n→ Starting the performer on Docker network ${dockerNetwork} so it can reach the cluster container.`);
  }
  const args = execution.performerRunArgs(imageName, hostPort, dockerNetwork);
  console.log(`\nStarting performer with:\n  docker ${args.join(" ")}\n`);

  try {
    const containerId = (await execution.capture(execution.dockerCommand, args)).trim();
    console.log(`\n✓ Started the ${sdk.name} performer in container ${containerId}`);
    const logFile = performerLogFile(path, sdk, version);
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
      await execution.streamToArtifactFile("docker", ["logs", "--timestamps", performer.containerId], targetLogFile);
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

/** Guided flow for choosing a performer, pulling it, and running it. */
export async function runCheckBuildAndRunPerformer(): Promise<void> {
  const sdk = await chooseSdk("Which SDK performer do you want to check and run?");
  const version = await askPerformerTag(sdk);
  const execution = createLocalFitExecutionContext();
  const performer = await checkBuildAndRunPerformer(execution, sdk, { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0 }, version);
  await stopManagedPerformer(execution, performer);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    await runCheckBuildAndRunPerformer();
  });
}
