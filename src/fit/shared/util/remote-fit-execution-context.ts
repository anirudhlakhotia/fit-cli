import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { commandOn, formatCommandLine } from "../../../util/non-fit/fit-cli-log.js";
import { instanceInternalRunDir } from "../../../util/non-fit/replay.js";
import { posixQuote } from "../../../util/non-fit/remote-target.js";
import { RemoteTarget } from "../../../util/non-fit/remote-target.js";
import type { ExecutionTarget } from "../../../util/non-fit/target.js";
import { resolveGithubToken } from "../../util/config.js";
import { FIT_PERFORMER, JENKINS_SDK, repoPath } from "../../util/repos.js";
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
  remoteGerritSshKeyPath,
  remotePerformerArgs,
  remoteRunArtifactsDir,
  remoteWorkspaceRepos,
  stageGerritSshKey,
  type FitExecutionContext,
} from "./remote-fit-run.js";
import { resolveGerritSshKey } from "../../util/config.js";

const REMOTE_APT_ENV = "DEBIAN_FRONTEND=noninteractive";

export function remoteAptWaitCommand(): string {
  return [
    "if command -v cloud-init >/dev/null 2>&1; then sudo -n cloud-init status --wait >/dev/null; fi",
    "for _ in $(seq 1 60); do",
    "  if ! pgrep -x apt >/dev/null 2>&1 && ! pgrep -x apt-get >/dev/null 2>&1 && ! pgrep -x dpkg >/dev/null 2>&1 && ! pgrep -f unattended-upgrade >/dev/null 2>&1; then",
    "    exit 0",
    "  fi",
    "  sleep 2",
    "done",
    "echo 'Timed out waiting for apt/dpkg activity to finish.' >&2",
    "pgrep -a -x apt >&2 || true",
    "pgrep -a -x apt-get >&2 || true",
    "pgrep -a -x dpkg >&2 || true",
    "pgrep -a -f unattended-upgrade >&2 || true",
    "exit 1",
  ].join("; ");
}

export function remoteAptCleanupCommand(): string {
  return [
    "sudo -n find /var/lib/apt/lists -mindepth 1 -maxdepth 1 ! -name lock -exec rm -rf -- {} +",
    "sudo -n install -d -m 755 /var/lib/apt/lists/partial",
  ].join("; ");
}

export function remoteAptGetCommand(args: string): string {
  return `sudo -n env ${REMOTE_APT_ENV} apt-get -o DPkg::Lock::Timeout=120 ${args}`;
}

/**
 * Build a FitExecutionContext that runs against a remote box over SSH. Preparing
 * the box installs the FIT dependencies (git, docker, JDK), wires a passwordless
 * `docker` wrapper, configures git credentials, and clones the FIT repos — unless
 * `skipPreparation` is set, in which case the box is assumed to be fully ready
 * from a previous run and the entire preparation step is skipped.
 */
export async function createRemoteFitExecutionContext(
  target: ExecutionTarget,
  sdk: Sdk,
  skipPreparation = false,
  instanceIndex = 0,
): Promise<FitExecutionContext> {
  const rootDir = remoteFitRootDir();
  const binDir = remoteFitBinDir(rootDir);

  if (skipPreparation) {
    console.log(`\n→ resume: reusing existing remote FIT workspace on ${target.description} (skipping preparation).`);
  } else {
    console.log(`\nPreparing a remote FIT workspace on ${target.description}...`);
    await target.run("mkdir", ["-p", rootDir]);

    console.log("\nInstalling the remote FIT dependencies...");
    // Clear stale/corrupt apt lists baked into the AMI before updating — a malformed
    // InRelease file causes GPG signature splitting to fail even on a fresh instance.
    await target.runHiddenUntilFailure("sh", ["-lc", remoteAptWaitCommand()], undefined, {
      display: "wait for cloud-init/apt",
    });
    await target.runHiddenUntilFailure("sh", ["-lc", remoteAptCleanupCommand()], undefined, {
      display: "clear /var/lib/apt/lists contents",
    });
    await target.runHiddenUntilFailure("sh", ["-lc", remoteAptGetCommand("update")], undefined, {
      display: "apt-get update",
    });
    await target.runHiddenUntilFailure("sh", [
      "-lc",
      // JDK 17+ needed for jenkins-sdk ./gradlew
      remoteAptGetCommand("install -y git docker.io openjdk-17-jdk-headless lsof"),
    ], undefined, { display: "apt-get install git docker.io openjdk-17-jdk-headless lsof" });
    // Allow running Docker without sudo
    await target.run("sudo", ["usermod", "-aG", "docker", "ubuntu"]);
    await target.run("sudo", ["-n", "systemctl", "enable", "--now", "docker"]);

    await target.run("mkdir", ["-p", binDir]);
    const internalDir = instanceInternalRunDir(instanceIndex);
    mkdirSync(internalDir, { recursive: true, mode: 0o700 });
    const localDockerWrapper = join(internalDir, "remote-docker-wrapper.sh");
    writeFileSync(localDockerWrapper, remoteDockerWrapperScript(), { mode: 0o700 });
    const wrapperPath = remoteDockerWrapperPath(rootDir);
    await target.putFile(localDockerWrapper, wrapperPath);
    await target.run("chmod", ["755", wrapperPath]);

    const githubToken = resolveGithubToken();
    if (githubToken) {
      await configureRemoteGitCredentials(target, rootDir, githubToken);
    } else {
      console.log(
        "\n⚠ No GitHub token found — the private FIT repos will fail to clone.\n" +
          "  Add one with `bun run config -- edit`, or set GITHUB_TOKEN / GH_TOKEN, then try again.",
      );
    }

    await ensureRemoteRepos(target, rootDir, remoteFitRepos(sdk));

    const localGerritKey = resolveGerritSshKey();
    if (localGerritKey) {
      console.log(`\n→ Staging Gerrit SSH key to remote instance...`);
      await stageGerritSshKey(target, rootDir, localGerritKey);
    }
  }

  const gerritSshKeyPath = resolveGerritSshKey() ? remoteGerritSshKeyPath(rootDir) : undefined;

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
    gerritSshKeyPath,
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
    runToFile: async (command, args, targetPath, cwd) => {
      // The redirect (`> targetPath`) won't create parent dirs, and per-run
      // targets now nest under artifacts/instances/.../runs/N — so ensure the dir.
      await target.run("mkdir", ["-p", dirname(targetPath)]);
      return target.run("sh", ["-lc", redirectShellCommand(pathPrefixedCommand(binDir, command, args), targetPath)], cwd, {
        display: commandOn(formatCommandLine(command, args), target.description),
      });
    },
    targetFilePath: (localPath) => join(rootDir, basename(localPath)),
    stageFile: async (localPath, targetPath) => {
      const destination = targetPath ?? join(rootDir, basename(localPath));
      // scp won't create intermediate dirs; per-run targets nest, so ensure the dir.
      await target.run("mkdir", ["-p", dirname(destination)]);
      await target.putFile(localPath, destination);
      return destination;
    },
    runArtifactsDir: (path) => remoteRunArtifactsDir(rootDir, path),
    collectFile: (targetPath, localPath) => {
      mkdirSync(dirname(localPath), { recursive: true, mode: 0o700 });
      return target.getFile(targetPath, localPath);
    },
    removeTree: (path) => target.run("rm", ["-rf", path]),
    collectJunitArtifacts: async (sourceDir, path) =>
      await collectJunitArtifactsFromTarget(target, sourceDir, path),
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
 *   npx tsx src/fit/shared/util/remote-fit-execution-context.ts --help
 *   # Prepare (full flow): install deps + clone repos on the box.
 *   npx tsx src/fit/shared/util/remote-fit-execution-context.ts --host 1.2.3.4 --sdk python --key ~/.ssh/id
 *   # Reuse an already-prepared box, then run one command against the context.
 *   npx tsx src/fit/shared/util/remote-fit-execution-context.ts --host 1.2.3.4 --sdk python --skip-preparation capture -- ls
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
