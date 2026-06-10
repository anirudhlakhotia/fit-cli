import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type Artifact, type Detail } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { LocalTarget } from "../../../util/non-fit/local-target.js";
import { streamToFile, type RunOptions } from "../../../util/non-fit/proc.js";
import { createRunFilePath, type DefinitionRunPath } from "../../../util/non-fit/replay.js";
import { posixQuote } from "../../../util/non-fit/remote-target.js";
import type { ExecutionTarget } from "../../../util/non-fit/target.js";
import { rootDirFromArgv } from "../../util/root.js";
import { FIT_INSTANCE_USER } from "../../util/aws/fit-instance.js";
import { FIT_PERFORMER, JENKINS_SDK, repoPath, type Repo } from "../../util/repos.js";
import { ensureRepo } from "../../util/ensure-repo.js";
import { collectJunitArtifacts } from "../run-test-driver/collect-junit.js";
import { requiredReposForSdk } from "../../../util/sdk/ensure-sdk-workspace.js";
import { ensureSdkWorkspace } from "../../../util/sdk/ensure-sdk-workspace.js";
import type { Sdk } from "../../../util/sdk/sdks.js";
import type { AwsCredentials } from "../../../util/non-fit/aws/identity.js";
import { DEFAULT_PERFORMER_PORT } from "../../performers/util/performer-port.js";
import { createRemoteFitExecutionContext } from "./remote-fit-execution-context.js";
import { resolveFitGerritKey } from "../../performers/checkout-fit-gerrit-ref/checkout-fit-gerrit-ref.js";

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
  /**
   * Path (on the execution target) to the SSH private key for Gerrit, or undefined
   * if none was configured. Set on local contexts from resolveFitGerritKey(); set on
   * remote contexts after the key has been staged to the remote machine.
   */
  gerritSshKeyPath?: string;

  ensureWorkspace(sdk: Sdk): Promise<boolean>;
  ensureBuildWorkspace(sdk: Sdk): Promise<boolean>;
  run(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<void>;
  capture(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<string>;
  runHiddenUntilFailure(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<void>;
  runToFile(command: string, args: string[], targetPath: string, cwd?: string): Promise<void>;
  targetFilePath(localPath: string): string;
  stageFile(localPath: string, targetPath?: string): Promise<string>;
  collectFile(targetPath: string, localPath: string): Promise<void>;
  removeTree(path: string): Promise<void>;
  collectJunitArtifacts(sourceDir: string, path: DefinitionRunPath): Promise<Artifact[]>;
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
  return target.run("test", ["-d", repoPath(repo, rootDir)], undefined, { quiet: true }).then(() => true).catch(() => false);
}

export async function ensureRemoteRepos(target: ExecutionTarget, rootDir: string, repos: readonly Repo[]): Promise<void> {
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

const REMOTE_GERRIT_SSH_KEY_FILENAME = "gerrit-ssh-key";

export function remoteGerritSshKeyPath(rootDir: string): string {
  return join(rootDir, REMOTE_GERRIT_SSH_KEY_FILENAME);
}

/**
 * Copy the local Gerrit SSH private key to the remote instance with chmod 600.
 * Returns the path on the remote machine where the key was written.
 */
export async function stageGerritSshKey(
  target: ExecutionTarget,
  rootDir: string,
  localKeyPath: string,
): Promise<string> {
  const remotePath = remoteGerritSshKeyPath(rootDir);
  await target.putFile(localKeyPath, remotePath);
  await target.run("chmod", ["600", remotePath]);
  return remotePath;
}

const REMOTE_AWS_CREDENTIALS_FILENAME = "fit-aws-credentials.sh";

function remoteAwsCredentialsPath(rootDir: string): string {
  return join(rootDir, REMOTE_AWS_CREDENTIALS_FILENAME);
}

function awsCredentialsScript(creds: AwsCredentials): string {
  return [
    `export AWS_ACCESS_KEY_ID=${posixQuote(creds.accessKeyId)}`,
    `export AWS_SECRET_ACCESS_KEY=${posixQuote(creds.secretAccessKey)}`,
    ...(creds.sessionToken ? [`export AWS_SESSION_TOKEN=${posixQuote(creds.sessionToken)}`] : []),
  ].join("\n") + "\n";
}

/**
 * Write AWS credentials to the remote instance as a sourced env file so every
 * login-shell command (including the Maven test-driver process) inherits the
 * AWS env vars the cbdinocluster cloud deployer needs. The file is written via
 * SCP (never on a command line) and sourced from `~/.profile` idempotently.
 */
export async function uploadRemoteAwsCredentials(
  target: ExecutionTarget,
  rootDir: string,
  creds: AwsCredentials,
): Promise<void> {
  const remotePath = remoteAwsCredentialsPath(rootDir);
  const localFile = createRunFilePath(REMOTE_AWS_CREDENTIALS_FILENAME);
  writeFileSync(localFile, awsCredentialsScript(creds), { mode: 0o600 });
  console.log(
    `→ setup-aws-credentials: uploading AWS credentials to ${remotePath} on ${(target as { description?: string }).description ?? "remote"}`,
  );
  await target.putFile(localFile, remotePath);
  rmSync(localFile, { force: true });
  await target.run("chmod", ["600", remotePath]);
  // Source from ~/.profile idempotently so every login shell inherits the vars.
  await target.run(
    "sh",
    ["-lc",
      `grep -qF ${posixQuote(basename(remotePath))} ~/.profile 2>/dev/null` +
      ` || printf '\\n. ${posixQuote(remotePath)}\\n' >> ~/.profile`],
    undefined,
    { display: `add AWS credentials to ~/.profile (idempotent)` },
  );
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
    gerritSshKeyPath: resolveFitGerritKey(),
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
    run: (command, args, cwd, opts) => target.run(command, args, cwd, opts),
    capture: (command, args, cwd, opts) => target.capture(command, args, cwd, opts),
    runHiddenUntilFailure: (command, args, cwd, opts) => target.runHiddenUntilFailure(command, args, cwd, opts),
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
    collectJunitArtifacts: async (_sourceDir, path) => await collectJunitArtifacts(rootDir, path),
    pathExists: async (path) => target.capture("test", ["-e", path], undefined, { quiet: true }).then(() => true).catch(() => false),
    commandAvailable: async (command) =>
      target
        .capture("sh", ["-lc", `command -v ${posixQuote(command)} >/dev/null && printf yes || printf no`], undefined, { quiet: true })
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

export async function createFitExecutionContext(
  target: ExecutionTarget,
  rootDir: string,
  sdk: Sdk,
  options: { skipRemotePreparation?: boolean; instanceIndex?: number } = {},
): Promise<FitExecutionContext> {
  return target.kind === "local"
    ? createLocalFitExecutionContext(rootDir)
    : await createRemoteFitExecutionContext(target, sdk, options.skipRemotePreparation, options.instanceIndex);
}

/**
 * Mini CLI: run a local FIT execution context on its own, to poke at its
 * operations during development. Run with --help for the subcommands, or:
 *
 *   npx tsx src/fit/shared/util/remote-fit-run.ts --help
 *   npx tsx src/fit/shared/util/remote-fit-run.ts run -- ls -la
 *   npx tsx src/fit/shared/util/remote-fit-run.ts capture -- git status
 *   npx tsx src/fit/shared/util/remote-fit-run.ts path-exists /tmp
 *   npx tsx src/fit/shared/util/remote-fit-run.ts command-available docker
 *
 * The `--` separates the action from the command/args it should forward, so flags
 * meant for the inner command aren't eaten by fit-cli's own argv parsing.
 */
const LOCAL_CLI_ACTIONS = ["run", "capture", "path-exists", "command-available", "remove-tree"] as const;
type LocalCliAction = (typeof LOCAL_CLI_ACTIONS)[number];

function isLocalCliAction(value: string | undefined): value is LocalCliAction {
  return LOCAL_CLI_ACTIONS.includes(value as LocalCliAction);
}

const LOCAL_CLI_HELP = `Drive a local FIT execution context (createLocalFitExecutionContext) directly.

Usage:
  tsx src/workflows/fit-shared/util/remote-fit-run.ts <subcommand> [args] [--root <dir>]

Subcommands:
  run <command> [args...]          Run a command locally, streaming its output.
  capture <command> [args...]      Run a command locally and print its captured stdout.
  path-exists <path>               Print true/false for whether <path> exists.
  command-available <command>      Print true/false for whether <command> is on PATH.
  remove-tree <path>               Recursively remove <path> (rm -rf).

Put a \`--\` before the forwarded command so its own flags aren't parsed by fit-cli, e.g.
  ... run -- ls -la

Options:
  --root <dir>, -r <dir>           Workspace ROOT_DIR (default: parent of cwd; or FIT_ROOT).
  --help, -h                       Show this help.`;

if (isMain(import.meta.url)) {
  runCli(async () => {
    const rawArgs = process.argv.slice(2);
    if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
      console.log(LOCAL_CLI_HELP);
      return;
    }

    const { rootDir, positionals } = rootDirFromArgv(rawArgs);
    const [action, ...rest] = positionals;
    if (!isLocalCliAction(action)) {
      console.error(`Unknown or missing subcommand.\n\n${LOCAL_CLI_HELP}`);
      process.exit(2);
    }

    // Drop the optional `--` separator so its only job is shielding the inner
    // command's flags from fit-cli's argv parsing, not becoming an argument.
    const args = rest[0] === "--" ? rest.slice(1) : rest;
    const execution = createLocalFitExecutionContext(rootDir);
    switch (action) {
      case "run":
        await execution.run(args[0], args.slice(1));
        return;
      case "capture":
        console.log(await execution.capture(args[0], args.slice(1)));
        return;
      case "path-exists":
        console.log(await execution.pathExists(args[0]));
        return;
      case "command-available":
        console.log(await execution.commandAvailable(args[0]));
        return;
      case "remove-tree":
        await execution.removeTree(args[0]);
        return;
    }
  });
}
