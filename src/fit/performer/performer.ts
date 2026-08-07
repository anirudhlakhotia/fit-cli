#!/usr/bin/env node
/**
 * fit performer — build, list and run performer images from an SDK repo ref.
 *
 *   fit performer build <family> <ref>
 *   fit performer list [<sdk>]
 *   fit performer run <sdk> [version]
 *   fit performer metadata <sdk> [version]
 *
 * build:    dispatches that family's "build FIT performer" GitHub Actions workflow,
 *           waits for it to finish, and prints the resulting performer image names.
 * list:     prints the prebuilt performer container images published to GHCR for an SDK.
 * run:      pulls and starts a single prebuilt performer image, for manual testing.
 * metadata: pulls a performer image and prints all its metadata — Docker image
 *           labels and everything it reports over performerCapsFetch.
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import type { RunOutput } from "../../util/non-fit/artifacts.js";
import { runPerformerBuildMain } from "./build/build-performer.js";
import { runPerformerListMain } from "./list/list-performer.js";
import { runPerformerRunMain } from "./run/run-performer.js";
import { runPerformerMetadataMain } from "./metadata/metadata-performer.js";

function helpText(): string {
  return `Build and manage FIT performer images.

Usage:
  ${runScriptPrefix("performer")} build <family> <ref>
  ${runScriptPrefix("performer")} list [<sdk>]
  ${runScriptPrefix("performer")} run <sdk> [version]
  ${runScriptPrefix("performer")} metadata <sdk> [version]
  ${runScriptPrefix("performer")} --help

Subcommands:
  build     Dispatch a performer image build on GitHub Actions, wait for it, and
            print the resulting image names. Run "${runScriptPrefix("performer")} build --help" for details.
  list      List the prebuilt performer container images published to GHCR for an
            SDK. Run "${runScriptPrefix("performer")} list --help" for details.
  run       Pull and start a single prebuilt performer image, for manual testing.
            Run "${runScriptPrefix("performer")} run --help" for details.
  metadata  Show all metadata available for a performer image: Docker image
            labels and everything reported over performerCapsFetch.
            Run "${runScriptPrefix("performer")} metadata --help" for details.`;
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

    if (subcommand === "list") {
      return (await runPerformerListMain(rest)) ?? undefined;
    }

    if (subcommand === "run") {
      return (await runPerformerRunMain(rest)) ?? undefined;
    }

    if (subcommand === "metadata") {
      return (await runPerformerMetadataMain(rest)) ?? undefined;
    }

    console.error(`Unknown subcommand: ${subcommand}\n`);
    console.error(helpText());
    process.exit(2);
  });
}

if (isMain(import.meta.url)) {
  runPerformerMain();
}
