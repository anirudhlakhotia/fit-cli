/**
 * Workflow: check whether a performer can be started in the background.
 *
 * Run this flow on its own:
 *   npx tsx src/workflows/performers/check-running-performer/index.ts
 */
import { createServer } from "node:net";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { confirm } from "../../../util/non-fit/prompts.js";
import { capture, run } from "../../../util/non-fit/proc.js";
import { type Sdk } from "../../../util/sdk/sdks.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import { askVersion } from "../build-performer/ask-version.js";
import { buildPerformerImageName } from "../build-performer/build-performer.js";
import { DEFAULT_PERFORMER_PORT } from "../performer-port.js";

export interface DockerContainerSummary {
  id: string;
  image: string;
  name: string;
  ports: string;
}

export type PerformerRunCheckResult =
  | { action: "start" }
  | { action: "reuse"; containers: DockerContainerSummary[] }
  | { action: "restart"; containers: DockerContainerSummary[] }
  // The port is in use by something we didn't start (e.g. a performer the user
  // launched by hand); test against it without managing a container.
  | { action: "external" }
  | { action: "abort" };

export interface PortAvailability {
  available: boolean | null;
  error?: string;
}

const DOCKER_PS_FORMAT = "{{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Ports}}";

export function runningPerformerPsArgs(imageName: string): string[] {
  return ["ps", "--filter", `ancestor=${imageName}`, "--format", DOCKER_PS_FORMAT];
}

export function parseDockerPs(output: string): DockerContainerSummary[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = "", image = "", name = "", ...ports] = line.split("\t");
      return { id, image, name, ports: ports.join("\t") };
    });
}

export async function checkPortAvailability(port: number = DEFAULT_PERFORMER_PORT): Promise<PortAvailability> {
  return await new Promise((resolve) => {
    const server = createServer();

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve({ available: false });
        return;
      }
      resolve({ available: null, error: err.message });
    });

    server.listen(port, () => {
      server.close((closeErr) => {
        if (closeErr) {
          resolve({ available: null, error: closeErr.message });
          return;
        }
        resolve({ available: true });
      });
    });
  });
}

export async function runningContainersForImage(imageName: string): Promise<DockerContainerSummary[] | null> {
  try {
    return parseDockerPs(await capture("docker", runningPerformerPsArgs(imageName)));
  } catch (err) {
    console.log(`→ Couldn't check whether ${imageName} is already running: ${(err as Error).message}`);
    return null;
  }
}

export async function checkRunningPerformer(sdk: Sdk, version?: string): Promise<PerformerRunCheckResult> {
  const imageName = buildPerformerImageName(sdk, version);
  const runningContainers = await runningContainersForImage(imageName);

  if (runningContainers && runningContainers.length > 0) {
    const shouldRestart = await confirm({
      promptId: "performer.run.restart-existing",
      message:
        runningContainers.length === 1
          ? `The ${sdk.name} performer is already running in container ${runningContainers[0].id}. Restart it?`
          : `The ${sdk.name} performer is already running in ${runningContainers.length} containers. Restart them?`,
    });

    if (!shouldRestart) {
      console.log(`→ Leaving the existing ${sdk.name} performer running.`);
      return { action: "reuse", containers: runningContainers };
    }

    return { action: "restart", containers: runningContainers };
  }

  const portAvailability = await checkPortAvailability();
  if (portAvailability.available === false) {
    return handlePortInUse(DEFAULT_PERFORMER_PORT);
  }

  if (portAvailability.available === null) {
    console.log(
      `→ Couldn't check whether port ${DEFAULT_PERFORMER_PORT} is available: ${portAvailability.error ?? "unknown error"}`,
    );
  }

  return { action: "start" };
}

/** Build the `lsof` args that list the PIDs listening on a TCP port. */
export function lsofPortArgs(port: number): string[] {
  return ["-t", "-i", `tcp:${port}`, "-sTCP:LISTEN"];
}

/** Parse the PIDs out of `lsof -t` output (one PID per line). */
export function parseLsofPids(output: string): number[] {
  const seen = new Set<number>();
  for (const line of output.split("\n")) {
    const pid = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(pid) && pid > 0) {
      seen.add(pid);
    }
  }
  return [...seen];
}

/** Build the `kill` args that terminate the given PIDs. */
export function killProcessArgs(pids: number[]): string[] {
  return pids.map((pid) => String(pid));
}

/** Find the PIDs of any process listening on the given port. */
export async function processesOnPort(port: number): Promise<number[]> {
  try {
    return parseLsofPids(await capture("lsof", lsofPortArgs(port)));
  } catch {
    // lsof exits non-zero when nothing is listening, or isn't installed.
    return [];
  }
}

/** Terminate any process listening on the given port. */
export async function stopProcessesOnPort(port: number): Promise<boolean> {
  const pids = await processesOnPort(port);
  if (pids.length === 0) {
    console.log(
      `→ Couldn't find a local process listening on port ${port}. It may belong to another user or a container.`,
    );
    return false;
  }

  console.log(
    `\nStopping process${pids.length === 1 ? "" : "es"} on port ${port} with:\n  kill ${killProcessArgs(pids).join(" ")}\n`,
  );

  try {
    await run("kill", killProcessArgs(pids));
    console.log(`\n✓ Asked process${pids.length === 1 ? "" : "es"} ${pids.join(", ")} to stop.`);
    return true;
  } catch (err) {
    console.error(`\n✗ Failed to stop process${pids.length === 1 ? "" : "es"} ${pids.join(", ")}: ${(err as Error).message}`);
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface WaitForPortFreeOptions {
  intervalMs?: number;
  maxAttempts?: number;
  checkAvailability?: (port: number) => Promise<PortAvailability>;
  sleep?: (ms: number) => Promise<void>;
}

/** Poll until the port is free, resolving true once it is (or false on timeout). */
export async function waitForPortFree(port: number, options: WaitForPortFreeOptions = {}): Promise<boolean> {
  const intervalMs = options.intervalMs ?? 2000;
  const maxAttempts = options.maxAttempts ?? 150;
  const checkAvailability = options.checkAvailability ?? checkPortAvailability;
  const waitFor = options.sleep ?? sleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const availability = await checkAvailability(port);
    if (availability.available === true) {
      return true;
    }
    if (attempt < maxAttempts) {
      await waitFor(intervalMs);
    }
  }
  return false;
}

export interface PortInUseDeps {
  confirm: typeof confirm;
  stopProcessesOnPort: (port: number) => Promise<boolean>;
  waitForPortFree: (port: number) => Promise<boolean>;
}

const DEFAULT_PORT_IN_USE_DEPS: PortInUseDeps = {
  confirm,
  stopProcessesOnPort,
  waitForPortFree,
};

/**
 * Decide what to do when the performer port is already taken. Rather than
 * bailing out, offer to test against whatever is already there, or to stop it
 * and wait for the port to free up.
 */
export async function handlePortInUse(
  port: number,
  deps: PortInUseDeps = DEFAULT_PORT_IN_USE_DEPS,
): Promise<PerformerRunCheckResult> {
  console.error(`\n✗ Port ${port} is already in use.`);

  const testAgainst = await deps.confirm({
    promptId: "performer.run.port-in-use.assume-running",
    message: `Assume a performer is already running on port ${port} and test against it?`,
    default: true,
  });
  if (testAgainst) {
    return { action: "external" };
  }

  const shouldStop = await deps.confirm({
    promptId: "performer.run.port-in-use.stop-process",
    message: `Try to stop whatever is using port ${port}, then wait for it to free up?`,
    default: false,
  });
  if (!shouldStop) {
    console.log("\nOnce the performer is ready to run, run fit-cli again.");
    return { action: "abort" };
  }

  await deps.stopProcessesOnPort(port);

  console.log(`\nWaiting for port ${port} to become free… (press Ctrl+C to abort)`);
  if (await deps.waitForPortFree(port)) {
    console.log(`\n✓ Port ${port} is now free.`);
    return { action: "start" };
  }

  console.error(`\n✗ Port ${port} is still in use. Once it's free, run fit-cli again.`);
  return { action: "abort" };
}

export function stopPerformerContainerArgs(containerIds: string[]): string[] {
  return ["stop", ...containerIds];
}

export async function stopPerformerContainers(containerIds: string[]): Promise<boolean> {
  if (containerIds.length === 0) {
    return true;
  }

  console.log(
    `\nStopping performer container${containerIds.length === 1 ? "" : "s"} with:\n  docker stop ${containerIds.join(" ")}\n`,
  );

  try {
    await run("docker", stopPerformerContainerArgs(containerIds));
    console.log(
      `\n✓ Stopped performer container${containerIds.length === 1 ? "" : "s"} ${containerIds.join(", ")}`,
    );
    return true;
  } catch (err) {
    console.error(
      `\n✗ Failed to stop performer container${containerIds.length === 1 ? "" : "s"} ${containerIds.join(", ")}: ${(err as Error).message}`,
    );
    return false;
  }
}

export async function stopRunningPerformer(containers: DockerContainerSummary[]): Promise<boolean> {
  return stopPerformerContainers(containers.map((container) => container.id));
}

export async function runCheckRunningPerformerWorkflow(): Promise<void> {
  const sdk = await chooseSdk("Which SDK performer do you want to check?");
  const version = await askVersion();
  const result = await checkRunningPerformer(sdk, version);
  console.log(JSON.stringify(result, null, 2));
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    await runCheckRunningPerformerWorkflow();
  });
}
