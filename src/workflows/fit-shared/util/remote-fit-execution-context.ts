import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { commandOn, formatCommandLine } from "../../../util/non-fit/fit-cli-log.js";
import { cycleInternalRunDir } from "../../../util/non-fit/replay.js";
import { posixQuote } from "../../../util/non-fit/remote-target.js";
import { RemoteTarget } from "../../../util/non-fit/remote-target.js";
import type { ExecutionTarget } from "../../../util/non-fit/target.js";
import { resolveGithubToken } from "../../../util/fit/config.js";
import { FIT_PERFORMER, JENKINS_SDK, repoPath } from "../../../util/fit/repos.js";
import { SDKS, sdkByValue, type Sdk } from "../../../util/sdk/sdks.js";
import { DEFAULT_PERFORMER_PORT } from "../../performers/util/performer-port.js";
import { collectJunitArtifactsFromTarget } from "../run-test-driver/collect-junit.js";
import {
  configureRemoteGitCredentials,
  ensureRemoteRepos,
  pathPrefixedCommand,
  redirectShellCommand,
  remoteBuildWorkspaceRepos,
  remoteDockerWrapperPath,
  remoteDockerWrapperScript,
  remoteFitBinDir,
  remoteFitRepos,
  remoteFitRootDir,
  remotePerformerArgs,
  remoteWorkspaceRepos,
  type FitExecutionContext,
} from "./remote-fit-run.js";

/**
 * Build a FitExecutionContext that runs against a remote box over SSH. Preparing
 * the box installs the FIT dependencies (git, docker, JDK), wires a passwordless
 * `docker` wrapper, configures git credentials, and clones the FIT repos — unless
 * `skipPreparation` is set, in which case it reuses an already-prepared workspace
 * and only does the cheap, idempotent bin/wrapper/creds setup.
 */
export async function createRemoteFitExecutionContext(
  target: ExecutionTarget,
  sdk: Sdk,
  skipPreparation = false,
  cycleIndex = 0,
): Promise<FitExecutionContext> {
  const rootDir = remoteFitRootDir();
  const binDir = remoteFitBinDir(rootDir);
  const wrapperPath = remoteDockerWrapperPath(rootDir);

  console.log(`\nPreparing a remote FIT workspace on ${target.description}...`);
  await target.run("mkdir", ["-p", rootDir]);

  // Resuming onto a box a previous run already prepared: the slow apt install and
  // repo clones are done, so skip them. The cheap, idempotent bin/wrapper/creds
  // setup below still runs so the context is consistent.
  if (skipPreparation) {
    console.log("→ resume: reusing the already-prepared remote workspace (skipping apt install and repo clones).");
  } else {
    console.log("\nInstalling the remote FIT dependencies...");
    // apt-get is noisy; run it quietly (-qq) and drop stdout, keeping stderr so
    // genuine failures still surface. DEBIAN_FRONTEND avoids interactive prompts.
    const aptEnv = "DEBIAN_FRONTEND=noninteractive";
    await target.run("sh", ["-lc", `sudo -n ${aptEnv} apt-get -qq update >/dev/null`], undefined, {
      display: "apt-get update",
    });
    await target.run("sh", [
      "-lc",
      // JDK 17+ needed for jenkins-sdk ./gradlew
      `sudo -n ${aptEnv} apt-get -qq install -y git docker.io openjdk-17-jdk-headless lsof >/dev/null`,
    ], undefined, { display: "apt-get install git docker.io openjdk-17-jdk-headless lsof" });
    // Allow running Docker without sudo
    await target.run("sudo", ["usermod", "-aG", "docker", "ubuntu"]);
    await target.run("sudo", ["-n", "systemctl", "enable", "--now", "docker"]);
  }

  await target.run("mkdir", ["-p", binDir]);
  const internalDir = cycleInternalRunDir(cycleIndex);
  mkdirSync(internalDir, { recursive: true, mode: 0o700 });
  const localDockerWrapper = join(internalDir, "remote-docker-wrapper.sh");
  writeFileSync(localDockerWrapper, remoteDockerWrapperScript(), { mode: 0o700 });
  await target.putFile(localDockerWrapper, wrapperPath);
  await target.run("chmod", ["755", wrapperPath]);

  const githubToken = resolveGithubToken();
  if (githubToken) {
    await configureRemoteGitCredentials(target, rootDir, githubToken);
  } else if (!skipPreparation) {
    console.log(
      "\n⚠ No GitHub token found — the private FIT repos will fail to clone.\n" +
        "  Add one with `npm run init`, or set GITHUB_TOKEN / GH_TOKEN, then try again.",
    );
  }

  if (!skipPreparation) {
    await ensureRemoteRepos(target, rootDir, remoteFitRepos(sdk));
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
    ensureWorkspace: async (sdk) => {
      await ensureRemoteRepos(target, rootDir, remoteWorkspaceRepos(sdk));
      return true;
    },
    ensureBuildWorkspace: async (sdk) => {
      await ensureRemoteRepos(target, rootDir, remoteBuildWorkspaceRepos(sdk));
      return true;
    },
    run: (command, args, cwd, opts) =>
      target.run("sh", ["-lc", pathPrefixedCommand(binDir, command, args)], cwd, {
        display: commandOn(formatCommandLine(command, args), target.description),
        ...opts,
      }),
    capture: (command, args, cwd, opts) =>
      target.capture("sh", ["-lc", pathPrefixedCommand(binDir, command, args)], cwd, {
        display: commandOn(formatCommandLine(command, args), target.description),
        ...opts,
      }),
    runHiddenUntilFailure: (command, args, cwd, opts) =>
      target.runHiddenUntilFailure("sh", ["-lc", pathPrefixedCommand(binDir, command, args)], cwd, {
        display: commandOn(formatCommandLine(command, args), target.description),
        ...opts,
      }),
    runToFile: (command, args, targetPath, cwd) =>
      target.run("sh", ["-lc", redirectShellCommand(pathPrefixedCommand(binDir, command, args), targetPath)], cwd, {
        display: commandOn(formatCommandLine(command, args), target.description),
      }),
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
    pathExists: (path) => target.run("test", ["-e", path], undefined, { quiet: true }).then(() => true).catch(() => false),
    commandAvailable: (command) =>
      target
        .capture("sh", ["-lc", `command -v ${posixQuote(command)} >/dev/null && printf yes || printf no`], undefined, { quiet: true })
        .then((output) => output.trim() === "yes")
        .catch(() => false),
    performerRunArgs: (imageName, hostPort = DEFAULT_PERFORMER_PORT, dockerNetwork) =>
      remotePerformerArgs(imageName, hostPort, dockerNetwork),
  };
}

/**
 * Mini CLI: prepare a remote FIT execution context against an SSH host and,
 * optionally, run one operation against it. Run with --help for the flags, or:
 *
 *   npx tsx src/workflows/fit-shared/util/remote-fit-execution-context.ts --help
 *   # Prepare (full flow): install deps + clone repos on the box.
 *   npx tsx src/workflows/fit-shared/util/remote-fit-execution-context.ts --host 1.2.3.4 --sdk python --key ~/.ssh/id
 *   # Reuse an already-prepared box, then run one command against the context.
 *   npx tsx src/workflows/fit-shared/util/remote-fit-execution-context.ts --host 1.2.3.4 --sdk python --skip-preparation capture -- ls
 *
 * Needs an SSH host you can already reach (e.g. an EC2 box left running). This is
 * for debugging/development of createRemoteFitExecutionContext, not end-users.
 */
const REMOTE_CLI_ACTIONS = ["run", "capture", "path-exists", "command-available", "remove-tree"] as const;
type RemoteCliAction = (typeof REMOTE_CLI_ACTIONS)[number];

function isRemoteCliAction(value: string | undefined): value is RemoteCliAction {
  return REMOTE_CLI_ACTIONS.includes(value as RemoteCliAction);
}

const REMOTE_CLI_HELP = `Prepare a remote FIT execution context (createRemoteFitExecutionContext) over SSH.

Usage:
  tsx src/workflows/fit-shared/util/remote-fit-execution-context.ts --host <ip> --sdk <sdk> [options] [<subcommand> [args]]

Required:
  --host <ip|dns>                  SSH host to prepare the FIT workspace on.
  --sdk <${SDKS.map((s) => s.value).join("|")}>
                                   Which SDK's repos to clone.

Options:
  --user <name>                    SSH login user (default: ubuntu).
  --key <path>                     Private key for SSH (-i).
  --skip-preparation               Reuse an already-prepared box (skip apt install + clones).
  --help, -h                       Show this help.

Subcommands (run after the context is prepared; omit to just prepare and report):
  run <command> [args...]          Run a command on the box, streaming its output.
  capture <command> [args...]      Run a command on the box and print its captured stdout.
  path-exists <path>               Print true/false for whether <path> exists on the box.
  command-available <command>      Print true/false for whether <command> is on the box's PATH.
  remove-tree <path>               Recursively remove <path> on the box (rm -rf).

Put a \`--\` before the forwarded command so its own flags aren't parsed by fit-cli, e.g.
  ... capture -- ls -la`;

/** Pull the named string flag (`--name <value>`) out of argv, returning the rest. */
function takeFlag(argv: string[], name: string): { value?: string; rest: string[] } {
  const i = argv.indexOf(name);
  if (i === -1) return { rest: argv };
  return { value: argv[i + 1], rest: [...argv.slice(0, i), ...argv.slice(i + 2)] };
}

/** Pull a boolean flag (`--name`) out of argv, returning the rest. */
function takeBoolFlag(argv: string[], name: string): { present: boolean; rest: string[] } {
  const i = argv.indexOf(name);
  if (i === -1) return { present: false, rest: argv };
  return { present: true, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const rawArgs = process.argv.slice(2);
    if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
      console.log(REMOTE_CLI_HELP);
      return;
    }

    const hostFlag = takeFlag(rawArgs, "--host");
    const sdkFlag = takeFlag(hostFlag.rest, "--sdk");
    const userFlag = takeFlag(sdkFlag.rest, "--user");
    const keyFlag = takeFlag(userFlag.rest, "--key");
    const skipFlag = takeBoolFlag(keyFlag.rest, "--skip-preparation");

    const host = hostFlag.value;
    const sdk = sdkFlag.value ? sdkByValue(sdkFlag.value) : undefined;
    if (!host || !sdk) {
      console.error(`Missing --host and/or a valid --sdk.\n\n${REMOTE_CLI_HELP}`);
      process.exit(2);
    }

    const target = new RemoteTarget({ host, user: userFlag.value, identityFile: keyFlag.value });
    const execution = await createRemoteFitExecutionContext(target, sdk, skipFlag.present);

    // Drop the optional `--` separator so its only job is shielding the inner
    // command's flags from fit-cli's argv parsing, not becoming an argument.
    const [action, ...rest] = skipFlag.rest;
    if (action === undefined) {
      console.log(`\n✓ Prepared remote FIT context on ${execution.description} (rootDir: ${execution.rootDir}).`);
      return;
    }
    if (!isRemoteCliAction(action)) {
      console.error(`Unknown subcommand "${action}".\n\n${REMOTE_CLI_HELP}`);
      process.exit(2);
    }

    const args = rest[0] === "--" ? rest.slice(1) : rest;
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
