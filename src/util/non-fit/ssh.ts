/**
 * ssh — run commands on, and copy files to/from, a remote host over SSH/SCP.
 * Host-agnostic transport (nothing AWS- or FIT-specific): give it a host, user
 * and key and it shells out to the system `ssh`/`scp`, reusing the `run`/
 * `capture` helpers in proc.ts. The argument building is pure (`buildSshArgs` /
 * `buildScpArgs`) so it can be unit tested (see tests/ssh.test.ts).
 *
 * Run a command on a host directly:
 *   npx tsx src/util/non-fit/ssh.ts --host <ip-or-dns> --key <path.pem> -- echo hello
 *   npx tsx src/util/non-fit/ssh.ts --host <ip> --user ec2-user --key k.pem -- uname -a
 */
import { isMain, runCli } from "./cli.js";
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
  /** Forward the local SSH agent to the remote host (`-A`). Needed when the remote must authenticate onwards (e.g. Gerrit). */
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
 */
function connectionOptions(host: RemoteHost, scp = false): string[] {
  const options = [
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    `ConnectTimeout=${host.connectTimeoutSeconds ?? 10}`,
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

/** Run a command on `host`, streaming its output to the terminal. */
export function sshRun(host: RemoteHost, command: string, args: readonly string[] = [], opts?: RunOptions): Promise<void> {
  return run("ssh", buildSshArgs(host, command, [...args]), undefined, opts);
}

/** Run a command on `host` and resolve with its captured stdout. */
export function sshCapture(host: RemoteHost, command: string, args: readonly string[] = [], opts?: RunOptions): Promise<string> {
  return capture("ssh", buildSshArgs(host, command, [...args]), undefined, opts);
}

/** Copy a local file up to `remotePath` on `host`. */
export function scpUp(host: RemoteHost, localPath: string, remotePath: string): Promise<void> {
  return run("scp", buildScpArgs(host, localPath, remotePath, "up"), undefined, {
    display: `scp ${localPath} -> ${loginTarget(host)}:${remotePath}`,
  });
}

/** Copy `remotePath` on `host` down to a local file. */
export function scpDown(host: RemoteHost, remotePath: string, localPath: string): Promise<void> {
  return run("scp", buildScpArgs(host, localPath, remotePath, "down"), undefined, {
    display: `scp ${loginTarget(host)}:${remotePath} -> ${localPath}`,
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
