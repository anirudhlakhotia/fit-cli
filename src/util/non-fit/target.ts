/**
 * target — an execution target: somewhere commands run and files live. The point
 * of the abstraction is that a workflow can be handed a target and not care
 * whether it's the local machine or a remote box over SSH. Two implementations
 * live alongside this file: LocalTarget (local-target.ts) and RemoteTarget
 * (remote-target.ts).
 *
 * This is deliberately generic — nothing AWS- or FIT-specific. It mirrors the
 * shape of proc.ts (run / capture) plus file transfer, so a caller currently
 * using proc.ts directly can be moved onto a target with minimal change.
 */

/** Somewhere commands run and files can be put/fetched. */
export interface ExecutionTarget {
  /** "local" for this machine, "remote" for a box reached over SSH. */
  readonly kind: "local" | "remote";
  /** Short human-readable description, e.g. "this machine" or "ubuntu@1.2.3.4". */
  readonly description: string;

  /** Run a command, streaming its output, resolving when it finishes (rejects non-zero). */
  run(command: string, args: string[], cwd?: string): Promise<void>;

  /** Run a command and resolve with its captured stdout. */
  capture(command: string, args: string[], cwd?: string): Promise<string>;

  /** Copy a local file to `remotePath` on the target. */
  putFile(localPath: string, remotePath: string): Promise<void>;

  /** Copy `remotePath` on the target down to a local file. */
  getFile(remotePath: string, localPath: string): Promise<void>;
}
