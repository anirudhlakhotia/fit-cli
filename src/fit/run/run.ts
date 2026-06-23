#!/usr/bin/env node
/**
 * Top-level `fit run` — execute FIT tests. This is the most common end-user
 * entrypoint; authoring and inspecting definition files lives under
 * `fit definition`.
 *
 *   bun run run preset <preset> --performer-image-name <image> [resume flags] [--cbcollect]
 *   bun run run definition <file.json5> [--resume-at=<point>] [resume selectors] [--cbcollect]
 *
 * The subcommand says what kind of thing is being run: a named `preset`
 * template, or a `definition` file (path or URL).
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { extractCbcollectFlag, extractInteractiveFlag, extractReplayFlag, markNonInteractiveByDefault } from "../../util/non-fit/replay.js";
import { runFromDefinition, type RunFromDefinitionOptions } from "../functional/run-from-definition/run-from-definition.js";
import { definitionSummary, resolveAndLoadDefinition } from "../shared/definition/parse-definition.js";
import {
  extractResumeAt,
  extractResumeSelector,
  parseResumePoint,
} from "../functional/run-from-definition/resume.js";
import { generatePreset, isPresetType, PRESET_TYPES } from "../definition/generate-preset/generate-preset.js";
import { analysePerformerImage, performerImageShortName } from "../performers/util/performer-image.js";
import type { RunOutput } from "../../util/non-fit/artifacts.js";
import { printVersion } from "../version/version.js";

const SUBCOMMANDS = ["preset", "definition"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const HELP = `Run FIT tests from a preset or a definition file.

Usage:
  bun run run preset <preset> --performer-image-name <image> [resume flags] [--cbcollect]
  bun run run definition <file.json5> [--resume-at=<point>] [resume selectors] [--cbcollect]
  bun run run --help

Subcommands:
  preset      Generate a preset definition file and run it immediately.
  definition  Run an existing definition file (path or URL). Both .json5 and .yaml are accepted.

Known presets:
  ${PRESET_TYPES.join("\n  ")}

preset options:
  --performer-image-name <image>  SDK-specific performer image ref (e.g. java-fit-performer:refs-changes-67-246067-3 or ghcr.io/couchbase/java-fit-performer:refs-changes-67-246067-3).

Resume points:
  --resume-at=after-instance-creation   Reuse a running instance.
  --resume-at=after-remote-preparation  Reuse a prepared remote workspace.
  --resume-at=after-cluster-creation    Reuse an allocated cluster.
  --resume-at=after-performer           Reuse the cluster and a running performer.

Resume selectors (narrow a resume to one run; emitted by a left-up run):
  --resume-instance=<n>             Which instance to resume.
  --resume-cluster=<n>              Which cluster within the instance.
  --resume-session=<n>              Which session within the cluster.
  --resume-clusterless-session=<n>  Which clusterless (situational) session.
  --resume-run=<n>                  Which run within the session.

See available presets in detail with: bun run definition list-presets`;

/** Pull `--performer-image-name[=<image>]` out of an argv list. */
function extractPerformerImageName(argv: readonly string[]): { performerImageName?: string; positionals: string[] } {
  const positionals: string[] = [];
  let performerImageName: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--performer-image-name") {
      performerImageName = argv[++i];
    } else if (arg.startsWith("--performer-image-name=")) {
      performerImageName = arg.slice("--performer-image-name=".length);
    } else {
      positionals.push(arg);
    }
  }
  return { performerImageName, positionals };
}

/**
 * Extract the resume point/selector and `--cbcollect` shared by both run
 * subcommands, returning the parsed run options and the remaining positionals.
 */
function extractRunOptions(argv: readonly string[]): { runOpts: RunFromDefinitionOptions; positionals: string[] } {
  const { resumeAt, positionals: afterResume } = extractResumeAt(argv);
  const { selector: resumeSelector, positionals: afterSelector } = extractResumeSelector(afterResume);
  const { cbcollect, positionals } = extractCbcollectFlag(afterSelector);
  let resumePoint;
  try {
    resumePoint = parseResumePoint(resumeAt);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  const runOpts = { ...(resumePoint ? { resumeAt: resumePoint } : {}), resumeSelector, ...(cbcollect ? { cbcollect } : {}) };
  return { runOpts, positionals };
}

/**
 * Dispatcher for `fit run`. Called from the `bun run run` entrypoint (via
 * runCli) or from the compiled `fit` binary's `main.ts` when the user runs
 * `fit run [...]`. `argv` is the slice of args after the `run` keyword.
 */
export async function runDispatch(argv: string[]): Promise<RunOutput | void> {
  // The global --interactive / --replay flags are read straight from
  // process.argv by the prompt session; strip them before parsing positionals.
  const cleaned = extractInteractiveFlag(extractReplayFlag(argv).positionals).positionals;
  const [subcommand, ...rest] = cleaned;

  const HELP_FLAGS = new Set(["-h", "--help", "help"]);
  if (!subcommand || HELP_FLAGS.has(subcommand) || rest.some((a) => HELP_FLAGS.has(a))) {
    console.log(HELP);
    if (!subcommand) process.exit(2);
    return;
  }

  if (!SUBCOMMANDS.includes(subcommand as Subcommand)) {
    console.error(`Unknown subcommand: ${subcommand}\n`);
    console.error(HELP);
    process.exit(2);
  }

  printVersion();
  console.log();

  if (subcommand === "preset") {
    const { runOpts, positionals: afterRunOpts } = extractRunOptions(rest);
    const { performerImageName, positionals } = extractPerformerImageName(afterRunOpts);
    const [type, ...extra] = positionals;
    if (!type || extra.length > 0) {
      console.error(`Usage: bun run run preset <preset> --performer-image-name <image>\nKnown presets: ${PRESET_TYPES.join(", ")}`);
      process.exit(2);
    }
    if (!isPresetType(type)) {
      console.error(`Unknown preset: ${type}\nKnown presets: ${PRESET_TYPES.join(", ")}`);
      process.exit(2);
    }
    if (!performerImageName) {
      console.error("--performer-image-name is required, e.g. java-fit-performer:main");
      process.exit(2);
    }
    const parsed = analysePerformerImage(performerImageName);
    if ("error" in parsed) {
      console.error(`--performer-image-name: ${parsed.error}`);
      process.exit(2);
    }
    const { path: definitionPath } = await generatePreset({
      type,
      image: performerImageShortName(parsed.sdk, parsed.tag),
      skipGuidance: true,
    });
    return runFromDefinition(definitionPath, runOpts);
  }

  // definition
  const { runOpts, positionals } = extractRunOptions(rest);
  const [definitionPath, ...extra] = positionals;
  if (!definitionPath || extra.length > 0) {
    console.error(
      "Usage: bun run run definition <file.json5> [--resume-at=<point>] [resume selectors]\n" +
        "  --resume-at: after-instance-creation | after-remote-preparation | after-cluster-creation | after-performer\n" +
        "  resume selectors: --resume-instance=<n> --resume-cluster=<n> --resume-session=<n> --resume-clusterless-session=<n> --resume-run=<n>",
    );
    process.exit(2);
  }
  const { resolvedPath, definition } = await resolveAndLoadDefinition(definitionPath);
  console.log(definitionSummary(definition));
  return runFromDefinition(resolvedPath, runOpts);
}

export function runRunMain(): void {
  // `fit run` runs CI-style with default answers unless `--interactive` is
  // passed. Declare it before runCli creates the prompt session below.
  markNonInteractiveByDefault();
  const argv = process.argv.slice(2);
  // Handle help before runCli creates the artifact directory.
  const positionals = extractInteractiveFlag(extractReplayFlag(argv).positionals).positionals;
  const helpFlags = new Set(["-h", "--help", "help"]);
  if (positionals.length === 0 || helpFlags.has(positionals[0]) || positionals.some((a) => helpFlags.has(a))) {
    console.log(HELP);
    process.exit(positionals.length === 0 ? 2 : 0);
  }
  runCli(() => runDispatch(argv));
}

if (isMain(import.meta.url)) {
  runRunMain();
}
