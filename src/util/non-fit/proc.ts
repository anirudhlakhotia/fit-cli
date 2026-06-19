import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { echoCommand, formatCommandLine, formatTimestampedChunk, startGreyIndentedOutput, stopGreyIndentedOutput } from "./fit-cli-log.js";
import { createRunFilePath } from "./replay.js";

/**
 * Where a process's *log output* goes, for the models that run a subprocess as a
 * logged step inside the session. This is the README's "Logging" section,
 * codified — see the ProcessExecModel table below for the function that
 * implements each one. Not every model is a logged step (CaptureValue,
 * CaptureValueSync and ReexecInherit are not), so a model maps to at most one
 * LogType.
 */
export enum LogType {
  /** L1: streamed straight to this process's stdout/stderr (and the session log). */
  Streamed = 1,
  /** L2: hidden as unimportant noise; shown only on failure; mirrored to the debug log. */
  HiddenUntilFailure = 2,
  /** L3: sent to its own artifact file; the last line is echoed every N seconds as proof-of-life. */
  Artifact = 3,
}

/**
 * The codified set of ways fit-cli runs a subprocess. Every process spawn in the
 * codebase should go through exactly one of these — there should be no raw
 * spawn/exec/spawnSync outside this file. Each model maps 1:1 to a function here:
 *
 *   Model              | function              | LogType | output is…
 *   -------------------|-----------------------|---------|------------------------------
 *   StreamToTerminal   | run                   | L1      | logged, live on the terminal
 *   HiddenUntilFailure | runHiddenUntilFailure | L2      | logged, hidden unless it fails
 *   StreamToArtifact   | streamToFile          | L3      | logged, to its own artifact file
 *   CaptureValue       | capture               | —       | a value we parse (mirrored to debug log)
 *   CaptureValueSync   | captureValueSync      | —       | a value we parse, synchronously
 *   ReexecInherit      | reexecInherit         | —       | the child owns the tty + signals
 *
 * The two CaptureValue models and ReexecInherit are deliberately *not* logged
 * steps: the first two run a process to obtain a value (a SHA, a username, a
 * file list) rather than to produce log noise, and ReexecInherit hands the
 * terminal to a replacement process. That's why they carry no LogType.
 */
export enum ProcessExecModel {
  StreamToTerminal = "StreamToTerminal",
  HiddenUntilFailure = "HiddenUntilFailure",
  StreamToArtifact = "StreamToArtifact",
  CaptureValue = "CaptureValue",
  CaptureValueSync = "CaptureValueSync",
  ReexecInherit = "ReexecInherit",
}

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
  /**
   * Opt out of grey-indented output mode for this command's stdout/stderr. Use
   * for proof-of-life / heartbeat output that should keep the full
   * `[HH:MM:SS ctx]` timestamp prefix so it's clearly timestamped.
   */
  noGreyOutput?: boolean;
}

/** Knobs for the CaptureValue models (capture / captureValueSync). */
export interface CaptureOptions extends RunOptions {
  /**
   * Exit codes to treat as success and resolve normally (default `[0]`). Use for
   * tools whose non-zero exits are meaningful rather than failures — e.g.
   * JunitMarkdown.java exits 2 for "ran fine but found test failures".
   */
  allowExitCodes?: readonly number[];
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
 *
 * @execModel ProcessExecModel.StreamToTerminal (LogType.Streamed / L1)
 */
export function run(command: string, args: string[], cwd: string = process.cwd(), opts?: RunOptions): Promise<void> {
  announce(command, args, opts);
  const grey = !opts?.noGreyOutput;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    if (grey) startGreyIndentedOutput();
    teeChildOutput(child.stdout, process.stdout);
    teeChildOutput(child.stderr, process.stderr);
    child.on("error", (err) => { if (grey) stopGreyIndentedOutput(); reject(err); });
    child.on("close", (code) => {
      if (grey) stopGreyIndentedOutput();
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
 *
 * @execModel ProcessExecModel.CaptureValue (no LogType — output is a parsed value)
 */
export function capture(command: string, args: string[], cwd: string = process.cwd(), opts?: CaptureOptions): Promise<string> {
  announce(command, args, opts);
  const okCodes = opts?.allowExitCodes ?? [0];
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
      if (code !== null && okCodes.includes(code)) {
        resolve(stdout);
      } else {
        const detail = stderr.trim();
        reject(new Error(`${command} exited with code ${code}${detail ? `: ${detail}` : ""}`));
      }
    });
  });
}

/**
 * Synchronous sibling of `capture` for the handful of value-reads that must run
 * outside the async session — e.g. `git rev-parse HEAD` while printing the
 * version, or a quiet `git config` / `gh config` probe for a username. Returns
 * the captured stdout.
 *
 * Throws on a disallowed exit code (see `allowExitCodes`) or a spawn error,
 * unless `allowFailure` is set, in which case any failure yields `""` — handy
 * for "give me the value, or nothing" metadata probes where a non-zero exit just
 * means "not configured". Captured output is mirrored to the debug log if one is
 * active.
 *
 * @execModel ProcessExecModel.CaptureValueSync (no LogType — output is a parsed value)
 */
export function captureValueSync(
  command: string,
  args: string[],
  opts?: CaptureOptions & { allowFailure?: boolean; env?: NodeJS.ProcessEnv },
): string {
  announce(command, args, opts);
  const result = spawnSync(command, args, { encoding: "utf8", env: opts?.env });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (currentDebugLog) {
    for (const chunk of [stdout, stderr]) {
      if (chunk) {
        const normalized = chunk.endsWith("\n") ? chunk : `${chunk}\n`;
        currentDebugLog.write(formatTimestampedChunk(normalized, true).text);
      }
    }
  }
  if (opts?.allowFailure) {
    return result.status === 0 ? stdout : "";
  }
  if (result.error) {
    throw result.error;
  }
  const okCodes = opts?.allowExitCodes ?? [0];
  if (result.status === null || !okCodes.includes(result.status)) {
    const detail = stderr.trim();
    throw new Error(`${command} exited with code ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return stdout;
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
  log.write(`# $ ${formatCommandLine(process.argv[0], process.argv.slice(1))}\n`);

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
  log.write(`# $ ${formatCommandLine(process.argv[0], process.argv.slice(1))}\n`);
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
 * Write content to the current debug log (if one has been started). Used to
 * surface captured file output — e.g. the cbdinocluster allocate stdout
 * collected from a remote machine — so the full command I/O ends up in one
 * place even when it couldn't flow through process.stdout/stderr.
 */
export function writeToDebugLog(content: string): void {
  if (!currentDebugLog || !content) {
    return;
  }
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  currentDebugLog.write(formatTimestampedChunk(normalized, true).text);
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
 *
 * @execModel ProcessExecModel.HiddenUntilFailure (LogType.HiddenUntilFailure / L2)
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
 * Run a command in the foreground, streaming stdout/stderr to a log file as
 * output is produced — without echoing it to the terminal. Resolves when the
 * command finishes; rejects if it can't start or exits non-zero. Used for noisy
 * tools (e.g. the FIT test-driver) whose full output belongs in a log file, not
 * scrolling past in the terminal.
 *
 * @execModel ProcessExecModel.StreamToArtifact (LogType.Artifact / L3)
 */
export const HEARTBEAT_INTERVAL_SECS = 30;

export function streamToFile(
  command: string,
  args: string[],
  logFile: string,
  cwd: string = process.cwd(),
  opts?: RunOptions,
): Promise<void> {
  announce(command, args, opts);
  process.stdout.write(`This may be a long-running process. The last log line will be printed every ${HEARTBEAT_INTERVAL_SECS}s as proof-of-life.\n`);
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });

  return new Promise((resolve, reject) => {
    const log = createWriteStream(logFile, { flags: "a", mode: 0o600 });
    log.write(`# ${new Date().toISOString()} ${command} ${args.join(" ")}\n`);

    let partial = '';
    let lastLine = '';
    const trackLine = (chunk: Buffer) => {
      const str = partial + chunk.toString();
      const lines = str.split('\n');
      partial = lines.pop() ?? '';
      const last = lines.findLast((l) => l.trim()) ?? (partial.trim() ? partial : '');
      if (last) lastLine = last;
    };

    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

    child.stdout.on("data", (chunk: Buffer) => { log.write(chunk); trackLine(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { log.write(chunk); trackLine(chunk); });

    const heartbeat = setInterval(() => {
      const line = lastLine || partial.trim();
      if (line) process.stdout.write(`[${new Date().toISOString()}] ${line}\n`);
    }, HEARTBEAT_INTERVAL_SECS * 1000);

    const finish = (fn: () => void) => {
      clearInterval(heartbeat);
      fn();
    };

    child.on("error", (err) => {
      log.end(() => finish(() => reject(err)));
    });
    child.on("close", (code) => {
      log.end(() =>
        finish(() => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`${command} exited with code ${code}`));
          }
        }),
      );
    });
  });
}

/**
 * Re-exec into a replacement process, handing it this process's stdio directly
 * (`stdio: "inherit"`) and mirroring its fate back: forward signals, and exit
 * with the child's exit code. Used by the replay bootstrap, which relaunches the
 * real entrypoint under tsx and then exists only to be that process.
 *
 * This is not a logged step — the child owns the terminal — so it carries no
 * LogType, and it deliberately does not echo a command line (the child produces
 * its own output). It does not return: the process exits via the child's
 * exit/signal or an error.
 *
 * @execModel ProcessExecModel.ReexecInherit (no LogType — the child owns the tty)
 */
export function reexecInherit(command: string, args: string[]): void {
  const child = spawn(command, args, { stdio: "inherit" });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  child.on("error", (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
