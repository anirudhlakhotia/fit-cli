/**
 * ssh — run commands on, and copy files to/from, a remote host over SSH/SCP.
 * Host-agnostic transport (nothing AWS- or FIT-specific): give it a host, user
 * and key and it shells out to the system `ssh`/`scp`, reusing the `run`/
 * `capture` helpers in proc.ts. The argument building is pure (`buildSshArgs` /
 * `buildScpArgs`) so it can be unit tested (see tests/ssh.test.ts).
 *
 * Run a command on a host directly:
 *   bun src/util/non-fit/ssh.ts --host <ip-or-dns> --key <path.pem> -- echo hello
 *   bun src/util/non-fit/ssh.ts --host <ip> --user ec2-user --key k.pem -- uname -a
 */
import { isMain, runCli } from "./cli.js";
import { formatBytes } from "./fit-cli-log.js";
import { capture, run, type RunOptions } from "./proc.js";

/** A host reachable over SSH. */
export interface RemoteHost {
  /** IP address or DNS name. */
  host: string;
  /** Login user. Defaults to "ubuntu" (the stock Ubuntu AMI user). */
  user?: string;
  /** Path to a private key (`-i`). When set, only this key is offered. */
  identityFile?: string;
  /** SSH port. Defaults to 22. */
  port?: number;
  /** Per-connection timeout in seconds. Defaults to 10. */
  connectTimeoutSeconds?: number;
  /** Forward the local SSH agent to the remote host (`-A`). */
  agentForwarding?: boolean;
}

/** The default login user when a host doesn't specify one. */
export const DEFAULT_SSH_USER = "ubuntu";

function loginTarget(host: RemoteHost): string {
  return `${host.user ?? DEFAULT_SSH_USER}@${host.host}`;
}

/**
 * The connection options common to ssh and scp. We disable host-key checking
 * and known-hosts entirely: these are throwaway hosts whose key changes every
 * launch, so prompting or caching the key would only get in the way. The port
 * flag differs between the two tools (`-p` for ssh, `-P` for scp), hence `scp`.
 *
 * We also force connection multiplexing off. Otherwise a user's `~/.ssh/config`
 * with `ControlMaster auto` for `*.compute.amazonaws.com` makes every command
 * reuse one master connection opened at first contact — before `usermod -aG
 * docker ubuntu` runs. Later commands (notably `cbdinocluster init`, which pings
 * the Docker socket directly) then ride that stale session and never see the
 * docker group, so the deployer detection fails with "permission denied" and the
 * run dies with "no deployers configured". Fresh connections per command keep us
 * hermetic and reproducible — matching how CI (with no such config) behaves.
 */
function connectionOptions(host: RemoteHost, scp = false): string[] {
  const options = [
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    `ConnectTimeout=${host.connectTimeoutSeconds ?? 10}`,
    "-o",
    // A generous 2 hour timeout to allow for long-running processes
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=240",
    "-o",
    "LogLevel=ERROR",
  ];
  if (host.identityFile) {
    options.push("-i", host.identityFile, "-o", "IdentitiesOnly=yes");
  }
  if (host.port) {
    options.push(scp ? "-P" : "-p", String(host.port));
  }
  if (!scp && host.agentForwarding) {
    options.push("-A");
  }
  return options;
}

/** Build the argv for `ssh` to run `command args...` on `host`. */
export function buildSshArgs(host: RemoteHost, command: string, args: readonly string[] = []): string[] {
  return [...connectionOptions(host), loginTarget(host), "--", command, ...args];
}

/** Direction of an scp transfer relative to the local machine. */
export type ScpDirection = "up" | "down";

/** Build the argv for `scp` to move `localPath` <-> `remotePath` on `host`. */
export function buildScpArgs(
  host: RemoteHost,
  localPath: string,
  remotePath: string,
  direction: ScpDirection,
): string[] {
  const options = connectionOptions(host, true);
  const remote = `${loginTarget(host)}:${remotePath}`;
  return direction === "up" ? [...options, localPath, remote] : [...options, remote, localPath];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns true if `err` is a transient SSH transport failure. SSH uses exit
 * code 255 exclusively for its own transport-level errors (TCP reset, connection
 * refused, key-exchange failure) — it is never the remote command's exit code.
 * Exported so callers that catch SSH errors higher up can apply the same test.
 */
export function isTransientSshError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /^(ssh|scp) exited with code 255/.test(err.message);
}

const SSH_RETRY_ATTEMPTS = 3;
const SSH_RETRY_DELAY_MS = 3_000;

async function withSshRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= SSH_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientSshError(err) || attempt === SSH_RETRY_ATTEMPTS) throw err;
      console.error(`[ssh] transient connection error (attempt ${attempt}/${SSH_RETRY_ATTEMPTS}), retrying in ${SSH_RETRY_DELAY_MS / 1000}s…`);
      await sleep(SSH_RETRY_DELAY_MS);
    }
  }
  // Unreachable — the loop always throws or returns first.
  throw new Error("withSshRetry: unreachable");
}

/** Run a command on `host`, streaming its output to the terminal. */
export function sshRun(host: RemoteHost, command: string, args: readonly string[] = [], opts?: RunOptions): Promise<void> {
  return withSshRetry(() => run("ssh", buildSshArgs(host, command, [...args]), undefined, opts));
}

/** Run a command on `host` and resolve with its captured stdout. */
export function sshCapture(host: RemoteHost, command: string, args: readonly string[] = [], opts?: RunOptions): Promise<string> {
  return withSshRetry(() => capture("ssh", buildSshArgs(host, command, [...args]), undefined, opts));
}

/** Copy a local file up to `remotePath` on `host`. */
export function scpUp(host: RemoteHost, localPath: string, remotePath: string): Promise<void> {
  return withSshRetry(() => run("scp", buildScpArgs(host, localPath, remotePath, "up"), undefined, {
    display: `scp ${localPath} -> ${loginTarget(host)}:${remotePath}`,
  }));
}

/**
 * Copy `remotePath` on `host` down to a local file. `sizeBytes`, when known
 * ahead of time, is shown in the echoed command so large transfers (e.g.
 * compressed logs) make clear how much data is about to move.
 */
export function scpDown(host: RemoteHost, remotePath: string, localPath: string, sizeBytes?: number): Promise<void> {
  const size = sizeBytes !== undefined ? ` (${formatBytes(sizeBytes)})` : "";
  return withSshRetry(() => run("scp", buildScpArgs(host, localPath, remotePath, "down"), undefined, {
    display: `scp ${loginTarget(host)}:${remotePath}${size} -> ${localPath}`,
  }));
}

/**
 * Poll until `host` accepts an SSH connection (by running `true` on it), or
 * until `timeoutMs` elapses. Freshly launched cloud instances take a little
 * while before sshd is up, so callers use this before their first real command.
 * Resolves true once connected, false on timeout.
 */
export async function waitForSsh(
  host: RemoteHost,
  { timeoutMs = 180_000, intervalMs = 5_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // Polling for sshd to come up — don't echo every probe.
      await sshCapture(host, "true", [], { quiet: true });
      return true;
    } catch {
      if (Date.now() >= deadline) {
        return false;
      }
      await sleep(intervalMs);
    }
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    const flag = (name: string): string | undefined => {
      const index = argv.indexOf(`--${name}`);
      return index !== -1 ? argv[index + 1] : undefined;
    };
    const host = flag("host");
    if (!host) {
      throw new Error("Usage: ssh.ts --host <ip> [--user <user>] [--key <path>] [--port <n>] -- <command> [args...]");
    }
    const separator = argv.indexOf("--");
    const [command, ...args] = separator !== -1 ? argv.slice(separator + 1) : [];
    const remote: RemoteHost = {
      host,
      user: flag("user"),
      identityFile: flag("key"),
      port: flag("port") ? Number(flag("port")) : undefined,
    };
    if (!command) {
      console.log(`Waiting for SSH on ${host}...`);
      console.log((await waitForSsh(remote)) ? "✓ reachable" : "✗ timed out");
      return;
    }
    await sshRun(remote, command, args);
  });
}
