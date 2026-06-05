import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type Artifact, type Detail } from "../../util/non-fit/artifacts.js";
import { LocalTarget } from "../../util/non-fit/local-target.js";
import { streamToFile } from "../../util/non-fit/proc.js";
import { createRunFilePath } from "../../util/non-fit/replay.js";
import { posixQuote } from "../../util/non-fit/remote-target.js";
import type { ExecutionTarget } from "../../util/non-fit/target.js";
import { FIT_INSTANCE_USER } from "../../util/fit/aws/fit-instance.js";
import { resolveGithubToken } from "../../util/fit/config.js";
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
  collectJunitArtifacts(sourceDir: string, iteration?: number): Promise<Artifact[]>;
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

function uniqueRepos(repos: readonly Repo[]): Repo[] {
  return [...new Map(repos.map((repo) => [repo.dir, repo])).values()];
}

export function remoteWorkspaceRepos(sdk: Sdk): Repo[] {
  return uniqueRepos([FIT_PERFORMER, ...requiredReposForSdk(sdk)]);
}

export function remoteBuildWorkspaceRepos(sdk: Sdk): Repo[] {
  return uniqueRepos([FIT_PERFORMER, JENKINS_SDK, ...requiredReposForSdk(sdk)]);
}

export function remoteFitRepos(sdk: Sdk): Repo[] {
  return remoteBuildWorkspaceRepos(sdk);
}

export function remoteDockerWrapperScript(): string {
  return "#!/bin/sh\nexec sudo -n /usr/bin/docker \"$@\"\n";
}

/** Where the remote git credentials file lives, under the FIT workspace root. */
export function remoteGitCredentialsPath(rootDir: string): string {
  return join(rootDir, ".git-credentials");
}

async function remoteRepoExists(target: ExecutionTarget, rootDir: string, repo: Repo): Promise<boolean> {
  return target.run("test", ["-d", repoPath(repo, rootDir)]).then(() => true).catch(() => false);
}

async function ensureRemoteRepos(target: ExecutionTarget, rootDir: string, repos: readonly Repo[]): Promise<void> {
  await target.run("mkdir", ["-p", rootDir]);
  for (const repo of repos) {
    if (await remoteRepoExists(target, rootDir, repo)) {
      console.log(`✓ Found ${repo.name} on ${target.description} at ${repoPath(repo, rootDir)}`);
      continue;
    }
    console.log(`\nCloning ${repo.name} onto ${target.description}...\n`);
    await target.run("git", ["clone", repo.url, repo.dir], rootDir);
  }
}

/**
 * A line for git's `store` credential helper, granting HTTPS access to all of
 * github.com with the given token. `x-access-token` is GitHub's conventional
 * username for token auth (works for both classic and fine-grained PATs).
 */
export function gitCredentialsLine(token: string): string {
  return `https://x-access-token:${token}@github.com\n`;
}

/**
 * Put a git credentials file on the remote and point git's `store` helper at it,
 * so the private FIT repos clone over HTTPS without prompting. The token is
 * written via scp (not passed on a command line or baked into a clone URL), so
 * it never lands in process listings or the local session log; it does sit in
 * the credentials file on the box, which is fine — the instance is throwaway and
 * only reachable with the per-run SSH key.
 */
export async function configureRemoteGitCredentials(
  target: ExecutionTarget,
  rootDir: string,
  token: string,
): Promise<void> {
  const credentialsPath = remoteGitCredentialsPath(rootDir);
  const localCredentials = createRunFilePath("git-credentials");
  writeFileSync(localCredentials, gitCredentialsLine(token), { mode: 0o600 });
  await target.putFile(localCredentials, credentialsPath);
  await target.run("chmod", ["600", credentialsPath]);
  await target.run("git", ["config", "--global", "credential.helper", `store --file=${credentialsPath}`]);
  rmSync(localCredentials, { force: true });
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
      mkdirSync(dirname(localPath), { recursive: true, mode: 0o700 });
      if (targetPath !== localPath) {
        copyFileSync(targetPath, localPath);
      }
      return Promise.resolve();
    },
    removeTree: (path) => {
      rmSync(path, { recursive: true, force: true });
      return Promise.resolve();
    },
    collectJunitArtifacts: async (_sourceDir, iteration) => await collectJunitArtifacts(rootDir, iteration),
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

  console.log("\nInstalling the remote FIT dependencies...");
  // apt-get is noisy; run it quietly (-qq) and drop stdout, keeping stderr so
  // genuine failures still surface. DEBIAN_FRONTEND avoids interactive prompts.
  const aptEnv = "DEBIAN_FRONTEND=noninteractive";
  await target.run("sh", ["-lc", `sudo -n ${aptEnv} apt-get -qq update >/dev/null`]);
  await target.run("sh", [
    "-lc",
    // JDK 17+ needed for jenkins-sdk ./gradlew
    `sudo -n ${aptEnv} apt-get -qq install -y git docker.io openjdk-17-jdk-headless lsof >/dev/null`,
  ]);
  await target.run("sudo", ["-n", "systemctl", "enable", "--now", "docker"]);

  await target.run("mkdir", ["-p", binDir]);
  const localDockerWrapper = createRunFilePath("remote-docker-wrapper.sh");
  writeFileSync(localDockerWrapper, remoteDockerWrapperScript(), { mode: 0o700 });
  await target.putFile(localDockerWrapper, wrapperPath);
  await target.run("chmod", ["755", wrapperPath]);

  const githubToken = resolveGithubToken();
  if (githubToken) {
    await configureRemoteGitCredentials(target, rootDir, githubToken);
  } else {
    console.log(
      "\n⚠ No GitHub token found — the private FIT repos will fail to clone.\n" +
        "  Add one with `npm run init`, or set GITHUB_TOKEN / GH_TOKEN, then try again.",
    );
  }

  await ensureRemoteRepos(target, rootDir, remoteFitRepos(sdk));

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
    ensureWorkspace: async (sdk) => {
      await ensureRemoteRepos(target, rootDir, remoteWorkspaceRepos(sdk));
      return true;
    },
    ensureBuildWorkspace: async (sdk) => {
      await ensureRemoteRepos(target, rootDir, remoteBuildWorkspaceRepos(sdk));
      return true;
    },
    run: (command, args, cwd) => target.run("sh", ["-lc", pathPrefixedCommand(binDir, command, args)], cwd),
    capture: (command, args, cwd) => target.capture("sh", ["-lc", pathPrefixedCommand(binDir, command, args)], cwd),
    runToFile: (command, args, targetPath, cwd) =>
      target.run("sh", ["-lc", redirectShellCommand(pathPrefixedCommand(binDir, command, args), targetPath)], cwd),
    targetFilePath: (localPath) => join(rootDir, basename(localPath)),
    stageFile: (localPath, targetPath) => {
      const destination = targetPath ?? join(rootDir, basename(localPath));
      return target.putFile(localPath, destination).then(() => destination);
    },
    collectFile: (targetPath, localPath) => {
      mkdirSync(dirname(localPath), { recursive: true, mode: 0o700 });
      return target.getFile(targetPath, localPath);
    },
    removeTree: (path) => target.run("rm", ["-rf", path]),
    collectJunitArtifacts: async (sourceDir, iteration) =>
      await collectJunitArtifactsFromTarget(target, sourceDir, iteration),
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
