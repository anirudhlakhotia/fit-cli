#!/usr/bin/env node
import { accessSync, constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { installFitCliConsoleFormatting } from "./fit-cli-log.js";
import { reexecInherit } from "./proc.js";
import { readPromptLog, extractReplayFlag, REPO_ROOT } from "./replay.js";
import { isMain } from "./cli.js";

interface ReplayDispatch {
  entrypoint: string;
  args: string[];
}

function ensureReadableFile(path: string): string {
  accessSync(path, constants.R_OK);
  return path;
}

export function buildReplayDispatch(
  argv: string[],
  cwd = process.cwd(),
): ReplayDispatch {
  const { replayRequested, replayDefaults, replayFile, positionals } = extractReplayFlag(argv);
  if (!replayRequested || !replayFile) {
    throw new Error(
      "Missing replay log file. Usage: bun run replay <logfile> or bun run replay --defaults <logfile>",
    );
  }

  const resolvedLogFile = resolve(cwd, replayFile);
  const log = readPromptLog(resolvedLogFile);
  const recordedEntrypoint = log.invocation?.entrypoint;
  // The recorded entrypoint is repo-relative (older/external logs may be
  // absolute); resolve it against this checkout's repo root so the replay runs
  // the same workflow regardless of where it was recorded.
  const entrypoint = ensureReadableFile(
    recordedEntrypoint
      ? isAbsolute(recordedEntrypoint)
        ? recordedEntrypoint
        : resolve(REPO_ROOT, recordedEntrypoint)
      : resolve(REPO_ROOT, "src/fit/main/main.ts"),
  );
  const forwardedArgs = positionals.length > 0 ? positionals : (log.invocation?.args ?? []);

  return {
    entrypoint,
    args: [
      "--replay",
      ...(replayDefaults ? ["--defaults"] : []),
      resolvedLogFile,
      ...forwardedArgs,
    ],
  };
}

export function main(argv: string[] = process.argv.slice(2)): void {
  installFitCliConsoleFormatting();
  const { entrypoint, args } = buildReplayDispatch(argv);
  reexecInherit(process.platform === "win32" ? "tsx.cmd" : "tsx", [entrypoint, ...args]);
}

export function shouldAutoRunReplayEntry(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) {
    return false;
  }
  return isMain(metaUrl);
}

if (shouldAutoRunReplayEntry(import.meta.url)) {
  main();
}
