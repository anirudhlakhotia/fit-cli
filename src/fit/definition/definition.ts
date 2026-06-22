#!/usr/bin/env node
/**
 * Top-level dispatcher for the `definition` bun script and for the compiled
 * `fit definition [...]` subcommand. This namespace is for authoring and
 * inspecting definition files; to *run* one (or a preset), use `fit run`.
 *
 * bun run definition validate <file.yaml>
 * bun run definition generate-desc <file.yaml>
 * bun run definition generate-preset --type <preset> --performer-image-name <image>
 * bun run definition list-presets
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { extractInteractiveFlag, extractReplayFlag, markNonInteractiveByDefault } from "../../util/non-fit/replay.js";
import { cacheDefinition, definitionSummary, isDefinitionUrl, loadDefinition, resolveAndLoadDefinition } from "../shared/definition/parse-definition.js";
import { describeDefinition } from "../shared/definition/generate-desc.js";
import { generatePreset, listPresets, parseGeneratePresetArgs, PRESET_TYPES } from "./generate-preset/generate-preset.js";
import type { RunOutput } from "../../util/non-fit/artifacts.js";

const SUBCOMMANDS = ["validate", "generate-desc", "generate-preset", "list-presets"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const HELP = `Author and inspect FIT definition files.

To run a definition file or a preset, use \`fit run\` instead.

Usage:
  bun run definition validate <file.json5>
  bun run definition generate-desc <file.json5>
  bun run definition generate-preset --type <preset> --performer-image-name <image> [--output <path>]
  bun run definition list-presets
  bun run definition --help

Both .json5 and .yaml definition files are accepted.

Subcommands:
  validate        Parse and validate a definition file without running it.
  generate-desc   Print a compact description of a definition file (useful for CI labels).
  generate-preset Emit a ready-to-run definition file from a preset template.
  list-presets    List all available preset types with descriptions.

generate-preset options:
  --type <preset>               Preset to generate. Known presets: ${PRESET_TYPES.join(", ")}
  --performer-image-name <image>  SDK-specific performer image ref (e.g. java-fit-performer:refs-changes-67-246067-3 or ghcr.io/couchbase/java-fit-performer:refs-changes-67-246067-3).
  --output <path>               Write to an explicit path instead of the default run dir.
  --push-gist [public|private]  Create a GitHub Gist after writing. Requires a GitHub token in the fit-cli config or GITHUB_TOKEN / GH_TOKEN.`;

/**
 * Dispatcher for definition subcommands. Called either from the `bun run
 * definition` entrypoint (via runCli) or from the compiled `fit` binary's
 * `main.ts` when the user runs `fit definition [...]`.
 *
 * `argv` is the slice of args after the `definition` keyword (i.e. the
 * subcommand and its flags/positionals).
 */
export async function definitionDispatch(argv: string[]): Promise<RunOutput | void> {
  // generate-desc output must be machine-parseable — use process.stdout.write
  // directly so it is never affected by console.log timestamp formatting.
  if (argv[0] === "generate-desc") {
    const path = argv[1];
    if (!path) {
      process.stderr.write("Usage: bun run definition generate-desc <file.json5>\n");
      process.exit(2);
    }
    const resolvedPath = isDefinitionUrl(path) ? await cacheDefinition(path) : path;
    const definition = loadDefinition(resolvedPath);
    process.stdout.write(describeDefinition(definition) + "\n");
    return;
  }

  // The global --interactive / --replay flags are read straight from
  // process.argv by the prompt session, so strip them here before we pick the
  // subcommand off the front.
  const cleaned = extractInteractiveFlag(extractReplayFlag(argv).positionals).positionals;
  const [subcommand, ...rest] = cleaned;

  const HELP_FLAGS = new Set(["-h", "--help", "help"]);
  if (!subcommand || HELP_FLAGS.has(subcommand) || rest.some(a => HELP_FLAGS.has(a))) {
    console.log(HELP);
    if (!subcommand) process.exit(2);
    return;
  }

  if (!SUBCOMMANDS.includes(subcommand as Subcommand)) {
    console.error(`Unknown subcommand: ${subcommand}\n`);
    console.error(HELP);
    process.exit(2);
  }

  if (subcommand === "generate-preset") {
    let args;
    try {
      args = parseGeneratePresetArgs(rest);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(2);
    }
    await generatePreset(args);
    return;
  }

  if (subcommand === "list-presets") {
    await listPresets();
    return;
  }

  // validate
  const [path, ...extra] = rest;
  if (!path || extra.length > 0) {
    console.error("Usage: bun run definition validate <file.json5>");
    process.exit(2);
  }
  const { definition } = await resolveAndLoadDefinition(path);
  console.log(definitionSummary(definition));
}

export function runDefinitionMain(): void {
  // The `definition` command runs CI-style with default answers unless
  // `--interactive` is passed. This is the single entrypoint for every launch
  // form — `fit definition` and `bun run definition` — so declaring it here
  // covers them all, and it runs before runCli creates the prompt session below.
  markNonInteractiveByDefault();
  const argv = process.argv.slice(2);
  // Handle help before runCli creates the artifact directory.
  const positionals = extractInteractiveFlag(extractReplayFlag(argv).positionals).positionals;
  const helpFlags = new Set(["-h", "--help", "help"]);
  if (positionals.length === 0 || helpFlags.has(positionals[0]) || positionals.some(a => helpFlags.has(a))) {
    console.log(HELP);
    process.exit(positionals.length === 0 ? 2 : 0);
  }
  runCli(() => definitionDispatch(argv));
}

if (isMain(import.meta.url)) {
  runDefinitionMain();
}
