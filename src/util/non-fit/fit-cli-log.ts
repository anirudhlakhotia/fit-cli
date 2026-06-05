const RESET = "\u001b[0m";
const RED = "\u001b[31m";
const YELLOW = "\u001b[33m";

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

function formatFitCliMessage(label: "FitCliError" | "FitCliWarn", color: string, args: unknown[]): string {
  const message = args.map(stringify).join(" ").trimEnd();
  const leadingNewlines = message.match(/^\n*/)?.[0] ?? "";
  const body = message
    .slice(leadingNewlines.length)
    .replace(/^(?:FitCliError|FitCliWarn):\s*/, "")
    .replace(/^(?:✗|→)\s*/, "");
  return `${leadingNewlines}${label}: ${color}${body}${RESET}`;
}

export function formatFitCliError(...args: unknown[]): string {
  return formatFitCliMessage("FitCliError", RED, args);
}

export function formatFitCliWarn(...args: unknown[]): string {
  return formatFitCliMessage("FitCliWarn", YELLOW, args);
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
