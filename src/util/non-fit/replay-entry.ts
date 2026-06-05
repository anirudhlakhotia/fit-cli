#!/usr/bin/env node
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installFitCliConsoleFormatting } from "./fit-cli-log.js";
import { readPromptLog, extractReplayFlag, REPO_ROOT } from "./replay.js";

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
      "Missing replay log file. Usage: npm run replay <logfile> or npm run replay --defaults <logfile>",
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
      : resolve(REPO_ROOT, "src/main.ts"),
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
  const child = spawn(process.platform === "win32" ? "tsx.cmd" : "tsx", [entrypoint, ...args], {
    stdio: "inherit",
  });

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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
