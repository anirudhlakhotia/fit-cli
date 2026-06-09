import { spawn } from "node:child_process";
import { closeSync, createWriteStream, mkdirSync, openSync, writeFileSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { echoCommand, formatCommandLine, formatTimestampedChunk } from "./fit-cli-log.js";
import { createRunFilePath } from "./replay.js";

/**
 * When set, every command's captured stdout/stderr (from `capture()`) is also
 * written here, giving a complete command I/O transcript alongside the terminal
 * mirror in session.info.log. Set by startDebugLog().
 */
let currentDebugLog: WriteStream | null = null;

/** Knobs shared by every command-runner for how the command is announced. */
export interface RunOptions {
  /**
   * A clean line to echo instead of the literal command+args — used when the
   * real command is wrapped (e.g. ssh/sh -lc), so the user sees the logical
   * command rather than the transport noise.
   */
  display?: string;
  /** Skip the pre-run echo entirely — for noisy probes/polls (e.g. ssh-wait, `command -v`). */
  quiet?: boolean;
}

/**
 * Echo what's about to run, once, before every spawn. This is the DRY point the
 * whole codebase relies on: if a command goes through proc.ts, it gets shown.
 */
function announce(command: string, args: readonly string[], opts?: RunOptions): void {
  if (opts?.quiet) {
    return;
  }
  echoCommand(opts?.display ?? formatCommandLine(command, args));
}

function teeChildOutput(stream: NodeJS.ReadableStream | null, target: NodeJS.WriteStream, onChunk?: (chunk: Buffer) => void): void {
  stream?.on("data", (chunk: Buffer) => {
    target.write(chunk);
    onChunk?.(chunk);
  });
}

/**
 * Run a command, streaming its output through the current stdout/stderr, and
 * resolve when it finishes. Rejects if the command can't start or exits
 * non-zero. This means session logging sees subprocess output by default, while
 * the user still gets live terminal feedback. `cwd` defaults to the current
 * working directory for commands that don't care where they run (e.g.
 * cbdinocluster, which takes absolute paths).
 */
export function run(command: string, args: string[], cwd: string = process.cwd(), opts?: RunOptions): Promise<void> {
  announce(command, args, opts);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    teeChildOutput(child.stdout, process.stdout);
    teeChildOutput(child.stderr, process.stderr);
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
 *
 * The captured output is invisible on the terminal but is written to the debug
 * log (if one has been started) so the full command I/O is available for
 * post-run diagnosis.
 */
export function capture(command: string, args: string[], cwd: string = process.cwd(), opts?: RunOptions): Promise<string> {
  announce(command, args, opts);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (currentDebugLog) {
        if (stdout) {
          const normalized = stdout.endsWith("\n") ? stdout : `${stdout}\n`;
          currentDebugLog.write(formatTimestampedChunk(normalized, true).text);
        }
        if (stderr) {
          const normalized = stderr.endsWith("\n") ? stderr : `${stderr}\n`;
          currentDebugLog.write(formatTimestampedChunk(normalized, true).text);
        }
      }
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
  opts?: RunOptions,
): Promise<string> {
  announce(command, args, opts);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    teeChildOutput(child.stdout, process.stdout, (chunk) => (stdout += chunk.toString()));
    teeChildOutput(child.stderr, process.stderr);
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
 * The default foreground subprocess helpers in this file write back through
 * process.stdout/process.stderr too, so their output is mirrored here as well.
 * Dedicated file-log helpers such as streamToFile intentionally bypass this and
 * write to their own artifact log instead.
 *
 * Returns a handle with the log path and a flush() to call before exiting.
 */
export function startSessionLog(logFile: string): SessionLog {
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
  const log = createWriteStream(logFile, { flags: "a", mode: 0o600 });
  log.write(`# ${new Date().toISOString()} fit-cli session\n`);

  const logLineStarts = new Map<NodeJS.WriteStream, boolean>();
  for (const stream of [process.stdout, process.stderr]) {
    logLineStarts.set(stream, true);
    const original: StreamWrite = stream.write.bind(stream);
    stream.write = function (...args: Parameters<StreamWrite>): boolean {
      const chunk = args[0];
      const text = typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString(typeof args[1] === "string" ? args[1] : undefined);
      const formatted = formatTimestampedChunk(text, logLineStarts.get(stream) ?? true);
      logLineStarts.set(stream, formatted.atLineStart);
      log.write(formatted.text);
      currentDebugLog?.write(formatted.text);
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
 * Start the debug log file. Once started, two things write to it:
 *
 * 1. Everything written to process.stdout/stderr (same as session.info.log) — picked
 *    up by the monkey-patch installed in startSessionLog, so startSessionLog
 *    must be called in the same session.
 * 2. The captured stdout/stderr from every capture() call — output that is
 *    consumed programmatically and never shown on the terminal.
 *
  * The result is a superset of session.info.log: every command echo AND its full
 * output in one file, useful for diagnosing failures after the fact.
 */
export function startDebugLog(logFile: string): SessionLog {
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
  const log = createWriteStream(logFile, { flags: "a", mode: 0o600 });
  log.write(`# ${new Date().toISOString()} fit-cli debug log\n`);
  currentDebugLog = log;

  const flush = (): Promise<void> =>
    new Promise((resolve) => {
      log.end(() => {
        currentDebugLog = null;
        resolve();
      });
    });

  return { path: logFile, flush };
}

/**
 * Run a command, capturing stdout and stderr into a buffer without showing it on
 * the terminal. On success the buffer is discarded silently; on failure the
 * buffer is dumped to stderr before rejecting. In both cases the captured output
 * is written to the debug log (if one has been started), so the full I/O is
 * available for post-run diagnosis.
 *
 * This is the "hidden as unimportant noise, only shown on failure" mode from the
 * README — ideal for noisy but seldom-interesting commands like docker pull.
 */
export function runHiddenUntilFailure(
  command: string,
  args: string[],
  cwd: string = process.cwd(),
  opts?: RunOptions,
): Promise<void> {
  announce(command, args, opts);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", (code) => {
      if (currentDebugLog && output) {
        const normalized = output.endsWith("\n") ? output : `${output}\n`;
        currentDebugLog.write(formatTimestampedChunk(normalized, true).text);
      }
      if (code === 0) {
        resolve();
      } else {
        if (output) {
          process.stderr.write(output.endsWith("\n") ? output : `${output}\n`);
        }
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
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
  opts?: RunOptions,
): Promise<void> {
  announce(command, args, opts);
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
  opts?: RunOptions,
): Promise<void> {
  announce(command, args, opts);
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
