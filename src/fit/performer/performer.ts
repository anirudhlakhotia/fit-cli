#!/usr/bin/env node
/**
 * fit performer — build performer images from an SDK repo ref.
 *
 *   fit performer build <family> <ref>
 *
 * build: dispatches that family's "build FIT performer" GitHub Actions workflow,
 *        waits for it to finish, and prints the resulting performer image names.
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import type { RunOutput } from "../../util/non-fit/artifacts.js";
import { runPerformerBuildMain } from "./build/build-performer.js";

function helpText(): string {
  return `Build and manage FIT performer images.

Usage:
  ${runScriptPrefix("performer")} build <family> <ref>
  ${runScriptPrefix("performer")} --help

Subcommands:
  build   Dispatch a performer image build on GitHub Actions, wait for it, and
          print the resulting image names. Run "${runScriptPrefix("performer")} build --help" for details.`;
}

export function runPerformerMain(): void {
  const [subcommand, ...rest] = process.argv.slice(2);

  runCli(async (): Promise<void | Partial<RunOutput>> => {
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      console.log(helpText());
      if (!subcommand) process.exit(2);
      return;
    }

    if (subcommand === "build") {
      return (await runPerformerBuildMain(rest)) ?? undefined;
    }

    console.error(`Unknown subcommand: ${subcommand}\n`);
    console.error(helpText());
    process.exit(2);
  });
}

if (isMain(import.meta.url)) {
  runPerformerMain();
}
