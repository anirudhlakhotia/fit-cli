#!/usr/bin/env node
/**
 * Top-level dispatcher for the `preset` bun script and for the compiled
 * `fit preset [...]` subcommand. This namespace is for listing, expanding and
 * generating presets; to *run* one, use `fit run preset`.
 *
 * bun run preset list
 * bun run preset expand op-multi-lite
 * bun run preset generate op-onprem-func-lite --performer java-fit-performer:main
 *
 * The preset-related subcommands used to live under `fit definition`
 * (`list-presets`, `expand-preset-group`, `generate-preset`). Those still work
 * as hidden, deprecated aliases — see definition.ts.
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { extractInteractiveFlag, extractReplayFlag, markNonInteractiveByDefault } from "../../util/non-fit/replay.js";
import { generatePreset, parseGeneratePresetArgs, presetDescriptions } from "../definition/generate-preset/generate-preset.js";
import { expandPresetGroupNames, listPresetsAndGroups } from "../definition/generate-preset/preset-groups.js";
import type { RunOutput } from "../../util/non-fit/artifacts.js";
import { printWithoutTimestamps, runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";

const SUBCOMMANDS = ["list", "expand", "generate"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

/**
 * Subcommands whose stdout is machine-parseable and must therefore carry
 * nothing but the payload — CI pipes `expand --json` straight into things like
 * `$GITHUB_OUTPUT`, where a stray `Ran with:` banner or `[HH:MM:SS]` prefix is
 * not noise but a hard failure. `main.ts` consults this before it installs any
 * console formatting; see runRawExpand.
 */
const MACHINE_OUTPUT_SUBCOMMANDS: readonly string[] = ["expand"];

/** `args` is argv after the `preset` token, e.g. ["expand", "all-release"]. */
export function isMachineOutputPresetSubcommand(args: readonly string[]): boolean {
  return args.length > 0 && MACHINE_OUTPUT_SUBCOMMANDS.includes(args[0]);
}

function buildHelp(): string {
  const preset = runScriptPrefix("preset");
  const run = runScriptPrefix("run");
  return `List, expand and generate FIT presets.

A preset is a named template that expands into a ready-to-run definition file.
To run a preset, use \`${run} preset <preset>\` instead.

Usage:
  ${preset} list
  ${preset} expand <preset-or-group>[,<preset-or-group>...] [--json | --verbose]
  ${preset} generate <preset> --performer <image> [--output <path>] [--env-override <path>=<value>]
  ${preset} --help

Subcommands:
  list      List all available presets and preset groups, with descriptions.
  expand    Expand a comma-separated list of presets/preset groups into a flat, comma-separated preset list.
  generate  Emit a ready-to-run definition file from a preset template.

expand options:
  --json     Print the flat list as a JSON array instead of a comma-separated string.
  --verbose  Print one expanded preset per line, each with its own description (for humans; --json/machine output is the default).

generate options:
  --performer <image>           SDK-specific performer image ref (e.g. java-fit-performer:refs-changes-67-246067-3 or ghcr.io/couchbase/java-fit-performer:refs-changes-67-246067-3). Alias: --performer-image-name.
  --output <path>               Write to an explicit path instead of the default run dir.
  --override <dotpath>=<value>  Override a field in the generated definition (repeatable).
  --env-override <path>=<value> Override an environments.json5 value the preset templates in (repeatable),
                                keyed by the preset's {{environments.<path>}} placeholder.
                                e.g. --env-override defaults.clusterVersion=7.6-stable
  --push-gist [public|private]  Create a GitHub Gist after writing. Requires a GitHub token in the fit-cli config or GITHUB_TOKEN / GH_TOKEN.`;
}

/** Usage line for `expand`, shared with the deprecated `definition expand-preset-group` alias. */
export function expandUsage(command: string, subcommand: string): string {
  return `Usage: ${runScriptPrefix(command)} ${subcommand} <preset-or-group>[,<preset-or-group>...] [--json | --verbose]\n`;
}

/**
 * `expand` prints machine-parseable output meant for CI to consume directly
 * (e.g. building a GHA matrix). runCli's session setup unconditionally prints
 * timestamp-prefixed banners and a closing artifact table to stdout, which
 * would corrupt that output — so this runs before runCli is ever invoked, and
 * writes straight to the real stdout/stderr.
 *
 * `main.ts` keeps its side of that bargain by skipping console formatting for
 * this subcommand (see isMachineOutputPresetSubcommand); the raw writes below
 * are wrapped anyway so the payload survives even if some other entrypoint has
 * already installed the timestamped stdout wrapper.
 *
 * `rest` is argv after the subcommand token. Shared with the deprecated
 * `definition expand-preset-group` alias, which passes its own usage string.
 */
export function runRawExpand(rest: string[], usage: string): void {
  const json = rest.includes("--json");
  const verbose = rest.includes("--verbose");
  const [namesCsv, ...extra] = rest.filter((a) => a !== "--json" && a !== "--verbose");
  if (!namesCsv || extra.length > 0 || (json && verbose)) {
    process.stderr.write(usage);
    process.exit(2);
  }
  let expanded: string[];
  try {
    expanded = expandPresetGroupNames(namesCsv);
  } catch (err) {
    process.stderr.write((err as Error).message + "\n");
    process.exit(2);
  }
  if (verbose) {
    const descriptionByType = new Map(presetDescriptions().map((p) => [p.type, p.description]));
    const col = expanded.reduce((max, type) => Math.max(max, type.length), 0);
    printWithoutTimestamps(
      expanded.map((type) => `${type.padEnd(col)}  ${descriptionByType.get(type) ?? "(no description)"}`).join("\n"),
    );
    return;
  }
  printWithoutTimestamps(json ? JSON.stringify(expanded) : expanded.join(","));
}

/**
 * `fit preset generate <preset>` takes the preset as a positional, matching
 * `fit run preset <preset>`, and accepts `--performer` as an alias for
 * `--performer-image-name`, matching `fit run`. The underlying parser predates
 * both and wants `--type <preset>` and the long flag, so normalise here.
 */
export function normaliseGenerateArgs(rest: readonly string[]): string[] {
  /** Flags whose value is a separate argv entry, so it must not be mistaken for the positional. */
  const VALUE_FLAGS = new Set(["--type", "--performer", "--performer-image-name", "--output", "--override", "--env-override"]);
  const out: string[] = [];
  let type: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--performer") {
      out.push("--performer-image-name", rest[++i]);
    } else if (arg.startsWith("--performer=")) {
      out.push(`--performer-image-name=${arg.slice("--performer=".length)}`);
    } else if (VALUE_FLAGS.has(arg)) {
      out.push(arg, rest[++i]);
    } else if (arg === "--push-gist") {
      // Optional value: --push-gist [public|private]. Consume it here too, so a
      // bare `public` isn't mistaken for the preset positional below.
      out.push(arg);
      const next = rest[i + 1];
      if (next === "public" || next === "private") {
        out.push(next);
        i++;
      }
    } else if (arg.startsWith("-")) {
      out.push(arg); // --flag=value forms
    } else if (type === undefined) {
      type = arg;
    } else {
      out.push(arg); // an extra positional — let the parser reject it
    }
  }
  return type !== undefined ? ["--type", type, ...out] : out;
}

/**
 * Dispatcher for preset subcommands. Called either from the `bun run preset`
 * entrypoint (via runCli) or from the compiled `fit` binary's `main.ts` when
 * the user runs `fit preset [...]`.
 *
 * `argv` is the slice of args after the `preset` keyword (i.e. the subcommand
 * and its flags/positionals).
 */
export async function presetDispatch(argv: string[]): Promise<RunOutput | void> {
  // The global --interactive / --replay flags are read straight from
  // process.argv by the prompt session, so strip them here before we pick the
  // subcommand off the front.
  const cleaned = extractInteractiveFlag(extractReplayFlag(argv).positionals).positionals;
  const [subcommand, ...rest] = cleaned;

  const HELP_FLAGS = new Set(["-h", "--help", "help"]);
  if (!subcommand || HELP_FLAGS.has(subcommand) || rest.some((a) => HELP_FLAGS.has(a))) {
    console.log(buildHelp());
    if (!subcommand) process.exit(2);
    return;
  }

  if (!SUBCOMMANDS.includes(subcommand as Subcommand)) {
    console.error(`Unknown subcommand: ${subcommand}\n`);
    console.error(buildHelp());
    process.exit(2);
  }

  if (subcommand === "list") {
    listPresetsAndGroups();
    return;
  }

  if (subcommand === "generate") {
    let args;
    try {
      args = parseGeneratePresetArgs(normaliseGenerateArgs(rest));
    } catch (err) {
      console.error((err as Error).message);
      process.exit(2);
    }
    await generatePreset(args);
    return;
  }

  // `expand` is machine-output and never reaches here — runPresetMain routes it
  // to runRawExpand before runCli can install any console formatting.
  throw new Error(`Unhandled preset subcommand: ${subcommand}`);
}

export function runPresetMain(): void {
  // The `preset` command runs CI-style with default answers unless
  // `--interactive` is passed. This is the single entrypoint for every launch
  // form — `fit preset` and `bun run preset` — so declaring it here covers them
  // all, and it runs before runCli creates the prompt session below.
  markNonInteractiveByDefault();
  const argv = process.argv.slice(2);
  // Handle help before runCli creates the artifact directory.
  const positionals = extractInteractiveFlag(extractReplayFlag(argv).positionals).positionals;
  const helpFlags = new Set(["-h", "--help", "help"]);
  if (positionals.length === 0 || helpFlags.has(positionals[0]) || positionals.some((a) => helpFlags.has(a))) {
    console.log(buildHelp());
    process.exit(positionals.length === 0 ? 2 : 0);
  }
  if (isMachineOutputPresetSubcommand(argv)) {
    try {
      runRawExpand(argv.slice(1), expandUsage("preset", "expand"));
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }
  runCli(() => presetDispatch(argv));
}

if (isMain(import.meta.url)) {
  runPresetMain();
}
