import { spawn } from "node:child_process";
import { closeSync, createWriteStream, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRunFilePath } from "./replay.js";

/**
 * Run a command, streaming its output straight to the console, and resolve when
 * it finishes. Rejects if the command can't start or exits non-zero. Used for
 * the long-running external tools FIT shells out to (git, mvn, cbdinocluster).
 * `cwd` defaults to the current working directory for commands that don't care
 * where they run (e.g. cbdinocluster, which takes absolute paths).
 */
export function run(command: string, args: string[], cwd: string = process.cwd()): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

/**
 * Run a command and resolve with its captured stdout, instead of streaming it.
 * Rejects (with any stderr included) if the command can't start or exits
 * non-zero. Used when we need to parse a tool's output — e.g. reading the list
 * of clusters out of `cbdinocluster ps` — rather than just show it.
 */
export function capture(command: string, args: string[], cwd: string = process.cwd()): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        const detail = stderr.trim();
        reject(new Error(`${command} exited with code ${code}${detail ? `: ${detail}` : ""}`));
      }
    });
  });
}

/**
 * Run a command, streaming stderr (and any progress logs) to the terminal while
 * capturing — and echoing — its stdout, then resolve with the captured stdout.
 * Rejects if the command can't start or exits non-zero. Used for long-running
 * tools whose progress we want the user to see but whose stdout result we also
 * need to parse — e.g. `cbdinocluster allocate`, which logs to stderr and prints
 * the new cluster's id on stdout.
 */
export function runAndCapture(
  command: string,
  args: string[],
  cwd: string = process.cwd(),
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["inherit", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      stdout += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

/** Create a log file path under the shared fit-cli temp directory. */
export function createLogFile(name: string, extension: string = "log"): string {
  return createRunFilePath(`${name}.${extension}`);
}

type StreamWrite = typeof process.stdout.write;

/**
 * Tee everything fit-cli writes to stdout/stderr into a log file, so the run
 * directory holds a full transcript of the session alongside the per-step logs.
 * Output still appears on the terminal as normal. Returns the log file path.
 *
 * This captures fit-cli's own output; child processes we run with stdio
 * "inherit" (and the FIT test-driver, which streams to its own log) write
 * straight to their fds and aren't mirrored here.
 *
 * Returns a handle with the log path and a flush() to call before exiting.
 */
export function startSessionLog(logFile: string): SessionLog {
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
  const log = createWriteStream(logFile, { flags: "a", mode: 0o600 });
  log.write(`# ${new Date().toISOString()} fit-cli session\n`);

  for (const stream of [process.stdout, process.stderr]) {
    const original: StreamWrite = stream.write.bind(stream);
    stream.write = function (...args: Parameters<StreamWrite>): boolean {
      log.write(args[0]);
      return original(...args);
    } as StreamWrite;
  }

  // The tee'd writes are buffered, so a bare process.exit() can truncate the log
  // — losing exactly the final error line a failed run most needs. Callers that
  // are about to exit should await flush() first.
  const flush = (): Promise<void> =>
    new Promise((resolve) => {
      log.end(() => resolve());
    });

  return { path: logFile, flush };
}

/** A started session log: where it lives, and how to flush it before exiting. */
export interface SessionLog {
  /** Path to the log file. */
  path: string;
  /** Flush and close the log stream; resolves once writes have hit disk. */
  flush: () => Promise<void>;
}

/**
 * Start a command in the background and stream stdout/stderr directly to a log
 * file as output is produced.
 */
export function streamToFileInBackground(
  command: string,
  args: string[],
  logFile: string,
  cwd: string = process.cwd(),
): Promise<void> {
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });

  return new Promise((resolve, reject) => {
    const logFd = openSync(logFile, "a", 0o600);
    writeFileSync(logFd, `# ${new Date().toISOString()} ${command} ${args.join(" ")}\n`);

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      closeSync(logFd);
      fn();
    };

    try {
      const child = spawn(command, args, {
        cwd,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });

      child.once("error", (err) => finish(() => reject(err)));
      child.once("spawn", () =>
        finish(() => {
          child.unref();
          resolve();
        }),
      );
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}

/**
 * Run a command in the foreground, streaming stdout/stderr to a log file as
 * output is produced — without echoing it to the terminal. Resolves when the
 * command finishes; rejects if it can't start or exits non-zero. Used for noisy
 * tools (e.g. the FIT test-driver) whose full output belongs in a log file, not
 * scrolling past in the terminal.
 */
export function streamToFile(
  command: string,
  args: string[],
  logFile: string,
  cwd: string = process.cwd(),
): Promise<void> {
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });

  return new Promise((resolve, reject) => {
    const log = createWriteStream(logFile, { flags: "a", mode: 0o600 });
    log.write(`# ${new Date().toISOString()} ${command} ${args.join(" ")}\n`);

    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

    child.stdout.on("data", (chunk: Buffer) => log.write(chunk));
    child.stderr.on("data", (chunk: Buffer) => log.write(chunk));

    child.on("error", (err) => {
      log.end(() => reject(err));
    });
    child.on("close", (code) => {
      log.end(() => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${command} exited with code ${code}`));
        }
      });
    });
  });
}
