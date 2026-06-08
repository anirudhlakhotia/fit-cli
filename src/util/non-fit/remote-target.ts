/**
 * remote-target — an ExecutionTarget backed by SSH/SCP (ssh.ts). Commands run on
 * the remote host; files are moved with scp. To honour `cwd` (and to keep
 * arguments intact across the extra shell hop that ssh introduces) the command
 * and its arguments are POSIX-quoted into a single remote command string.
 */
import { commandOn, formatCommandLine } from "./fit-cli-log.js";
import type { RunOptions } from "./proc.js";
import type { RemoteHost } from "./ssh.js";
import { DEFAULT_SSH_USER, scpDown, scpUp, sshCapture, sshRun } from "./ssh.js";
import type { ExecutionTarget } from "./target.js";

/**
 * Quote a single token for a POSIX shell. Bare tokens made of safe characters
 * are left alone; anything else is wrapped in single quotes (with embedded
 * single quotes escaped). Exported for unit testing (see tests/remote-target.test.ts).
 */
export function posixQuote(token: string): string {
  if (token.length > 0 && /^[A-Za-z0-9_./:=@%+-]+$/.test(token)) {
    return token;
  }
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/** Build the remote command string for `command args...`, optionally inside `cwd`. */
export function buildRemoteCommand(command: string, args: readonly string[], cwd?: string): string {
  const cmdline = [command, ...args].map(posixQuote).join(" ");
  return cwd ? `cd ${posixQuote(cwd)} && ${cmdline}` : cmdline;
}

export class RemoteTarget implements ExecutionTarget {
  readonly kind = "remote" as const;
  readonly description: string;

  constructor(private readonly host: RemoteHost) {
    this.description = `${host.user ?? DEFAULT_SSH_USER}@${host.host}`;
  }

  /**
   * Echo the *logical* command and host, not the ssh transport. Callers that
   * already wrapped a command (e.g. in `sh -lc`) pass their own clean `display`,
   * which we leave untouched.
   */
  private displayFor(command: string, args: readonly string[], opts?: RunOptions): RunOptions {
    return { ...opts, display: opts?.display ?? commandOn(formatCommandLine(command, args), this.description) };
  }

  run(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<void> {
    return sshRun(this.host, buildRemoteCommand(command, args, cwd), [], this.displayFor(command, args, opts));
  }

  capture(command: string, args: string[], cwd?: string, opts?: RunOptions): Promise<string> {
    return sshCapture(this.host, buildRemoteCommand(command, args, cwd), [], this.displayFor(command, args, opts));
  }

  putFile(localPath: string, remotePath: string): Promise<void> {
    return scpUp(this.host, localPath, remotePath);
  }

  getFile(remotePath: string, localPath: string): Promise<void> {
    return scpDown(this.host, remotePath, localPath);
  }
}
