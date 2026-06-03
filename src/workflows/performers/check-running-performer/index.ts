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
    console.error(`✗ Port ${DEFAULT_PERFORMER_PORT} is already in use.`);
    return { action: "abort" };
  }

  if (portAvailability.available === null) {
    console.log(
      `→ Couldn't check whether port ${DEFAULT_PERFORMER_PORT} is available: ${portAvailability.error ?? "unknown error"}`,
    );
  }

  return { action: "start" };
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
