import { basename } from "node:path";

const isTTY = process.stderr.isTTY ?? false;
const RESET = isTTY ? "\u001b[0m" : "";
const RED = isTTY ? "\u001b[31m" : "";
const YELLOW = isTTY ? "\u001b[33m" : "";

const baseConsoleError = console.error.bind(console);
const baseConsoleWarn = console.warn.bind(console);
const baseStdoutWrite = process.stdout.write.bind(process.stdout);
const baseStderrWrite = process.stderr.write.bind(process.stderr);

let consoleFormattingInstalled = false;
let timestampProvider = (): string => new Date().toTimeString().slice(0, 8);
let rawTerminalWriteDepth = 0;

type StreamWrite = typeof process.stdout.write;

export interface TimestampedChunk {
  text: string;
  atLineStart: boolean;
}

function advanceLineStart(text: string, atLineStart: boolean): boolean {
  let nextLineStart = atLineStart;
  for (const char of text) {
    if (char !== "\n") {
      nextLineStart = false;
      continue;
    }
    nextLineStart = true;
  }
  return nextLineStart;
}

function stringify(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack ?? arg.message;
  }
  return String(arg);
}

/**
 * Optional first argument to the warn/error helpers. When a `classification` is
 * given it's appended to the label so the line reads `FitCliWarn/FatalToCluster:`
 * (or `FitCliError/FatalToRun:`), making the failure's severity/scope visible at
 * a glance. Kept as a plain string so this FIT-agnostic logging layer doesn't
 * depend on the FIT `FailureClassification` type.
 */
export interface FitCliLogOptions {
  classification?: string;
}

function isLogOptions(arg: unknown): arg is FitCliLogOptions {
  return (
    typeof arg === "object" &&
    arg !== null &&
    !Array.isArray(arg) &&
    !(arg instanceof Error) &&
    "classification" in arg
  );
}

/** Peel an optional leading {@link FitCliLogOptions} off the variadic log args. */
function splitLogArgs(args: unknown[]): { classification?: string; rest: unknown[] } {
  if (args.length > 0 && isLogOptions(args[0])) {
    const { classification } = args[0];
    return { ...(classification ? { classification } : {}), rest: args.slice(1) };
  }
  return { rest: args };
}

function formatFitCliMessage(
  label: "FitCliError" | "FitCliWarn",
  color: string,
  args: unknown[],
  classification?: string,
): string {
  const message = args.map(stringify).join(" ").trimEnd();
  const leadingNewlines = message.match(/^\n*/)?.[0] ?? "";
  const body = message
    .slice(leadingNewlines.length)
    .replace(/^(?:FitCliError|FitCliWarn)(?:\/\w+)?:\s*/, "")
    .replace(/^(?:✗|→)\s*/, "");
  const fullLabel = classification ? `${label}/${classification}` : label;
  return `${leadingNewlines}${fullLabel}: ${color}${body}${RESET}`;
}

export function formatFitCliError(...args: unknown[]): string {
  const { classification, rest } = splitLogArgs(args);
  return formatFitCliMessage("FitCliError", RED, rest, classification);
}

export function formatFitCliWarn(...args: unknown[]): string {
  const { classification, rest } = splitLogArgs(args);
  return formatFitCliMessage("FitCliWarn", YELLOW, rest, classification);
}

export function formatTimestampedChunk(
  text: string,
  atLineStart: boolean = true,
  getTimestamp: () => string = timestampProvider,
): TimestampedChunk {
  let formatted = "";
  let nextLineStart = atLineStart;
  for (const char of text) {
    if (nextLineStart && char !== "\n") {
      formatted += `[${getTimestamp()}] `;
      nextLineStart = false;
    }
    formatted += char;
    if (char === "\n") {
      nextLineStart = true;
    }
  }
  return { text: formatted, atLineStart: nextLineStart };
}

function installTimestampedStreamWrite(stream: NodeJS.WriteStream, original: StreamWrite): void {
  let atLineStart = true;
  stream.write = function (
    chunk: Parameters<StreamWrite>[0],
    encoding?: Parameters<StreamWrite>[1],
    callback?: Parameters<StreamWrite>[2],
  ): boolean {
    const text = typeof chunk === "string"
      ? chunk
      : Buffer.from(chunk).toString(typeof encoding === "string" ? encoding : undefined);
    if (rawTerminalWriteDepth > 0) {
      atLineStart = advanceLineStart(text, atLineStart);
      if (typeof encoding === "function") {
        return original(chunk, encoding);
      }
      if (callback) {
        return original(chunk, encoding, callback);
      }
      if (encoding) {
        return original(chunk, encoding);
      }
      return original(chunk);
    }
    const formatted = formatTimestampedChunk(text, atLineStart);
    atLineStart = formatted.atLineStart;

    if (typeof encoding === "function") {
      return original(formatted.text, encoding);
    }
    if (callback) {
      return original(formatted.text, encoding, callback);
    }
    if (encoding) {
      return original(formatted.text, encoding);
    }
    return original(formatted.text);
  } as StreamWrite;
}

export async function withRawTerminalWrites<T>(operation: () => Promise<T>): Promise<T> {
  rawTerminalWriteDepth++;
  try {
    return await operation();
  } finally {
    rawTerminalWriteDepth--;
  }
}

/**
 * Write text to stdout verbatim, without the per-line `[HH:MM:SS]` timestamp
 * prefix — for dumping file contents (e.g. a generated definition) into the
 * terminal, where the timestamps would just be noise in front of the file.
 */
export function printWithoutTimestamps(text: string): void {
  rawTerminalWriteDepth++;
  try {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  } finally {
    rawTerminalWriteDepth--;
  }
}

/**
 * Quote a single token for display so the echoed command line stays readable and
 * unambiguous: bare tokens are left alone, anything with whitespace or quotes is
 * wrapped in single quotes. This is for *display only* — use posixQuote when the
 * string is actually going to a shell.
 */
function displayQuote(token: string): string {
  if (token !== "" && !/[\s'"\\]/.test(token)) {
    return token;
  }
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/** Render a command and its args as one readable, shell-ish line. */
export function formatCommandLine(command: string, args: readonly string[] = []): string {
  return [command, ...args].map(displayQuote).join(" ");
}

/** Tag a command line with where it runs, e.g. `cbdinocluster ps  (on ubuntu@1.2.3.4)`. */
export function commandOn(line: string, where: string): string {
  return `${line}  (on ${where})`;
}

/**
 * Echo the command about to run, as `$ <line>`. The single place fit-cli prints
 * "here's what I'm about to do" — every command-runner funnels through here so
 * the behaviour (and the format) lives in exactly one spot.
 */
export function echoCommand(line: string): void {
  console.log(`$ ${line}`);
}

export function setFitCliTimestampProvider(provider: (() => string) | undefined): void {
  timestampProvider = provider ?? (() => new Date().toTimeString().slice(0, 8));
}

export function fitCliError(...args: unknown[]): void {
  baseConsoleError(formatFitCliError(...args));
}

export function fitCliWarn(...args: unknown[]): void {
  baseConsoleWarn(formatFitCliWarn(...args));
}

export function installFitCliConsoleFormatting(): void {
  if (consoleFormattingInstalled) {
    return;
  }
  installTimestampedStreamWrite(process.stdout, baseStdoutWrite);
  installTimestampedStreamWrite(process.stderr, baseStderrWrite);
  console.error = (...args: unknown[]) => baseConsoleError(formatFitCliError(...args));
  console.warn = (...args: unknown[]) => baseConsoleWarn(formatFitCliWarn(...args));
  consoleFormattingInstalled = true;
}

/**
 * True when running as the compiled `fit` binary (bun build --compile).
 * The compiled binary's argv[0] is the binary path itself (ending in "fit" or
 * "fit-linux-x64" etc.), not the bun runtime. Use this to tailor guidance
 * messages that tell the user how to re-run a command.
 */
export function isFitBinary(): boolean {
  const bin = basename(process.argv[0] ?? "");
  return bin === "fit" || bin.startsWith("fit-");
}

/**
 * Return the prefix for a `definition execute` command, adjusted for whether
 * the user is running as the compiled `fit` binary or via `bun run definition`.
 * When using `fit`, a definition file path is passed directly to the binary:
 *   fit [flags] <file>   ≡   bun run definition -- execute [flags] <file>
 */
export function definitionExecutePrefix(): string {
  return isFitBinary() ? "fit" : "bun run definition -- execute";
}

/**
 * Return the invocation prefix for a `fit run <script>` sub-command, adjusted
 * for whether the user is running as the compiled `fit` binary or via bun.
 *   fit run config edit   ≡   bun run config -- edit
 */
export function runScriptPrefix(script: string): string {
  return isFitBinary() ? `fit run ${script}` : `bun run ${script} --`;
}
