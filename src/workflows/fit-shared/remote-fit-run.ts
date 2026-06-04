import { copyFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Artifact, type Detail } from "../../util/non-fit/artifacts.js";
import { LocalTarget } from "../../util/non-fit/local-target.js";
import { streamToFile } from "../../util/non-fit/proc.js";
import { createRunFilePath } from "../../util/non-fit/replay.js";
import { posixQuote } from "../../util/non-fit/remote-target.js";
import type { ExecutionTarget } from "../../util/non-fit/target.js";
import { FIT_INSTANCE_USER } from "../../util/fit/aws/fit-instance.js";
import { FIT_PERFORMER, JENKINS_SDK, repoPath, type Repo } from "../../util/fit/repos.js";
import { ensureRepo } from "../../util/fit/ensure-repo.js";
import { collectJunitArtifacts } from "./run-test-driver/collect-junit.js";
import { requiredReposForSdk } from "../../util/sdk/ensure-sdk-workspace.js";
import { ensureSdkWorkspace } from "../../util/sdk/ensure-sdk-workspace.js";
import type { Sdk } from "../../util/sdk/sdks.js";
import { DEFAULT_PERFORMER_PORT } from "../performers/performer-port.js";
import { collectJunitArtifactsFromTarget } from "./run-test-driver/collect-junit.js";

const REMOTE_FIT_WORKSPACE_DIR = "fit-workspace";
const REMOTE_DOCKER_WRAPPER_FILE = "docker";
export const REMOTE_DOCKER_HOST_ALIAS = "host.docker.internal:host-gateway";

export interface FitExecutionContext {
  readonly kind: "local" | "remote";
  readonly description: string;
  readonly target: ExecutionTarget;
  readonly rootDir: string;
  readonly fitPerformerDir: string;
  readonly jenkinsDir: string;
  readonly dockerCommand: string;
  readonly artifacts: Artifact[];
  details: Detail[];

  ensureWorkspace(sdk: Sdk): Promise<boolean>;
  ensureBuildWorkspace(sdk: Sdk): Promise<boolean>;
  run(command: string, args: string[], cwd?: string): Promise<void>;
  capture(command: string, args: string[], cwd?: string): Promise<string>;
  runToFile(command: string, args: string[], targetPath: string, cwd?: string): Promise<void>;
  targetFilePath(localPath: string): string;
  stageFile(localPath: string, targetPath?: string): Promise<string>;
  collectFile(targetPath: string, localPath: string): Promise<void>;
  removeTree(path: string): Promise<void>;
  collectJunitArtifacts(sourceDir: string): Promise<Artifact[]>;
  pathExists(path: string): Promise<boolean>;
  commandAvailable(command: string): Promise<boolean>;
  performerRunArgs(imageName: string, hostPort?: number, dockerNetwork?: string): string[];
}

export function remoteFitRootDir(user: string = FIT_INSTANCE_USER): string {
  return `/home/${user}/${REMOTE_FIT_WORKSPACE_DIR}`;
}

export function remoteFitBinDir(rootDir: string): string {
  return join(rootDir, "bin");
}

export function remoteDockerWrapperPath(rootDir: string): string {
  return join(remoteFitBinDir(rootDir), REMOTE_DOCKER_WRAPPER_FILE);
}

export function remoteFitRepos(sdk: Sdk): Repo[] {
  return [FIT_PERFORMER, JENKINS_SDK, ...requiredReposForSdk(sdk)];
}

export function remoteDockerWrapperScript(): string {
  return "#!/bin/sh\nexec sudo -n /usr/bin/docker \"$@\"\n";
}

function shellCommand(command: string, args: readonly string[] = []): string {
  return [command, ...args].map(posixQuote).join(" ");
}

export function pathPrefixedCommand(binDir: string, command: string, args: readonly string[] = []): string {
  return `export PATH=${posixQuote(binDir)}:$PATH; ${shellCommand(command, args)}`;
}

export function redirectToFileCommand(command: string, args: readonly string[], path: string): string {
  return `${shellCommand(command, args)} > ${posixQuote(path)} 2>&1`;
}

export function redirectShellCommand(command: string, path: string): string {
  return `${command} > ${posixQuote(path)} 2>&1`;
}

export function remotePerformerArgs(
  imageName: string,
  hostPort: number = DEFAULT_PERFORMER_PORT,
  dockerNetwork?: string,
): string[] {
  return [
    "run",
    "--detach",
    "--rm",
    "--add-host",
    REMOTE_DOCKER_HOST_ALIAS,
    ...(dockerNetwork ? ["--network", dockerNetwork] : []),
    "--publish",
    `${hostPort}:${DEFAULT_PERFORMER_PORT}`,
    imageName,
  ];
}

export function createLocalFitExecutionContext(rootDir: string): FitExecutionContext {
  const target = new LocalTarget();
  return {
    kind: "local",
    description: target.description,
    target,
    rootDir,
    fitPerformerDir: repoPath(FIT_PERFORMER, rootDir),
    jenkinsDir: repoPath(JENKINS_SDK, rootDir),
    dockerCommand: "docker",
    artifacts: [],
    details: [],
    ensureWorkspace: async (sdk: Sdk): Promise<boolean> => {
      if (!(await ensureRepo(FIT_PERFORMER, rootDir))) {
        console.log("\nOnce transactions-fit-performer is in place, run fit-cli again.");
        return false;
      }
      if (!(await ensureSdkWorkspace(sdk, rootDir))) {
        console.log("\nOnce the SDK workspace repos are in place, run fit-cli again.");
        return false;
      }
      return true;
    },
    ensureBuildWorkspace: async (sdk: Sdk): Promise<boolean> => {
      if (!(await ensureRepo(JENKINS_SDK, rootDir))) {
        console.log("\nOnce jenkins-sdk is in place, run fit-cli again.");
        return false;
      }
      return await ensureSdkWorkspace(sdk, rootDir);
    },
    run: (command, args, cwd) => target.run(command, args, cwd),
    capture: (command, args, cwd) => target.capture(command, args, cwd),
    runToFile: (command, args, targetPath, cwd) => streamToFile(command, args, targetPath, cwd),
    targetFilePath: (localPath) => localPath,
    stageFile: (localPath) => Promise.resolve(localPath),
    collectFile: (targetPath, localPath) => {
      if (targetPath !== localPath) {
        copyFileSync(targetPath, localPath);
      }
      return Promise.resolve();
    },
    removeTree: (path) => {
      rmSync(path, { recursive: true, force: true });
      return Promise.resolve();
    },
    collectJunitArtifacts: async () => await collectJunitArtifacts(rootDir),
    pathExists: async (path) => target.capture("test", ["-e", path]).then(() => true).catch(() => false),
    commandAvailable: async (command) =>
      target
        .capture("sh", ["-lc", `command -v ${posixQuote(command)} >/dev/null && printf yes || printf no`])
        .then((output) => output.trim() === "yes")
        .catch(() => false),
    performerRunArgs: (imageName, hostPort = DEFAULT_PERFORMER_PORT, dockerNetwork) => [
      "run",
      "--detach",
      "--rm",
      ...(dockerNetwork ? ["--network", dockerNetwork] : []),
      "--publish",
      `${hostPort}:${DEFAULT_PERFORMER_PORT}`,
      imageName,
    ],
  };
}

async function createRemoteFitExecutionContext(target: ExecutionTarget, sdk: Sdk): Promise<FitExecutionContext> {
  const rootDir = remoteFitRootDir();
  const binDir = remoteFitBinDir(rootDir);
  const wrapperPath = remoteDockerWrapperPath(rootDir);

  console.log(`\nPreparing a remote FIT workspace on ${target.description}...`);
  await target.run("mkdir", ["-p", rootDir]);

  console.log("\nInstalling the remote FIT dependencies...\n");
  await target.run("sudo", ["-n", "apt-get", "update"]);
  await target.run("sudo", ["-n", "apt-get", "install", "-y", "git", "docker.io", "default-jdk-headless", "lsof"]);
  await target.run("sudo", ["-n", "systemctl", "enable", "--now", "docker"]);

  await target.run("mkdir", ["-p", binDir]);
  const localDockerWrapper = createRunFilePath("remote-docker-wrapper.sh");
  writeFileSync(localDockerWrapper, remoteDockerWrapperScript(), { mode: 0o700 });
  await target.putFile(localDockerWrapper, wrapperPath);
  await target.run("chmod", ["755", wrapperPath]);

  for (const repo of remoteFitRepos(sdk)) {
    console.log(`\nCloning ${repo.name} onto ${target.description}...\n`);
    await target.run("git", ["clone", repo.url, repo.dir], rootDir);
  }

  return {
    kind: "remote",
    description: target.description,
    target,
    rootDir,
    fitPerformerDir: repoPath(FIT_PERFORMER, rootDir),
    jenkinsDir: repoPath(JENKINS_SDK, rootDir),
    dockerCommand: "docker",
    artifacts: [],
    details: [{ label: "Remote workspace", value: rootDir }],
    ensureWorkspace: () => Promise.resolve(true),
    ensureBuildWorkspace: () => Promise.resolve(true),
    run: (command, args, cwd) => target.run("sh", ["-lc", pathPrefixedCommand(binDir, command, args)], cwd),
    capture: (command, args, cwd) => target.capture("sh", ["-lc", pathPrefixedCommand(binDir, command, args)], cwd),
    runToFile: (command, args, targetPath, cwd) =>
      target.run("sh", ["-lc", redirectShellCommand(pathPrefixedCommand(binDir, command, args), targetPath)], cwd),
    targetFilePath: (localPath) => join(rootDir, basename(localPath)),
    stageFile: (localPath, targetPath) => {
      const destination = targetPath ?? join(rootDir, basename(localPath));
      return target.putFile(localPath, destination).then(() => destination);
    },
    collectFile: (targetPath, localPath) => target.getFile(targetPath, localPath),
    removeTree: (path) => target.run("rm", ["-rf", path]),
    collectJunitArtifacts: async (sourceDir) => await collectJunitArtifactsFromTarget(target, sourceDir),
    pathExists: (path) => target.run("test", ["-e", path]).then(() => true).catch(() => false),
    commandAvailable: (command) =>
      target
        .capture("sh", ["-lc", `command -v ${posixQuote(command)} >/dev/null && printf yes || printf no`])
        .then((output) => output.trim() === "yes")
        .catch(() => false),
    performerRunArgs: (imageName, hostPort = DEFAULT_PERFORMER_PORT, dockerNetwork) =>
      remotePerformerArgs(imageName, hostPort, dockerNetwork),
  };
}

export async function createFitExecutionContext(
  target: ExecutionTarget,
  rootDir: string,
  sdk: Sdk,
): Promise<FitExecutionContext> {
  return target.kind === "local"
    ? createLocalFitExecutionContext(rootDir)
    : await createRemoteFitExecutionContext(target, sdk);
}
