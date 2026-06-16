#!/usr/bin/env node
/**
 * Top-level dispatcher for the `definition` bun script and for the compiled
 * `fit definition [...]` subcommand.
 *
 * bun run definition -- execute <file.yaml> [--resume-at=<point>] [resume selectors] [--root <dir>]
 * bun run definition -- validate <file.yaml>
 */
import { existsSync } from "node:fs";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { rootDirFromArgv } from "../util/root.js";
import { extractInteractiveFlag, extractReplayFlag } from "../../util/non-fit/replay.js";
import { runFromDefinition } from "../functional/run-from-definition/run-from-definition.js";
import { cacheDefinition, isDefinitionUrl, loadDefinition } from "../shared/definition/parse-definition.js";
import { FIT_DEFINITION_TYPE } from "../shared/definition/types.js";
import {
  extractResumeAt,
  extractResumeSelector,
  parseResumePoint,
} from "../functional/run-from-definition/resume.js";
import { describeDefinition } from "../shared/definition/generate-desc.js";
import { generatePreset, parseGeneratePresetArgs, PRESET_TYPES } from "./generate-preset/generate-preset.js";
import type { RunOutput } from "../../util/non-fit/artifacts.js";

const SUBCOMMANDS = ["execute", "validate", "generate-desc", "generate-preset"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const HELP = `Manage FIT definition files.

Usage:
  bun run definition -- execute <file.json5> [--resume-at=<point>] [resume selectors] [--root <dir>]
  bun run definition -- validate <file.json5>
  bun run definition -- generate-desc <file.json5>
  bun run definition -- generate-preset --type <preset> --performer-image-name <image> [--output <path>]
  bun run definition -- --help

Both .json5 and .yaml definition files are accepted.

Subcommands:
  execute         Run FIT tests from a definition file.
  validate        Parse and validate a definition file without running it.
  generate-desc   Print a compact description of a definition file (useful for CI labels).
  generate-preset Emit a ready-to-run definition file from a preset template.

generate-preset options:
  --type <preset>               Preset to generate. Known presets: ${PRESET_TYPES.join(", ")}
  --performer-image-name <image>  SDK-specific performer image ref (e.g. java-fit-performer:refs-changes-67-246067-3 or ghcr.io/couchbase/java-fit-performer:refs-changes-67-246067-3).
  --output <path>               Write the generated definition to an explicit path instead of the default run dir.
  --push-gist [public|private]  After writing the file, create a GitHub Gist (default: public). Requires a GitHub token in the fit-cli config or GITHUB_TOKEN / GH_TOKEN.

Resume points for execute:
  --resume-at=after-instance-creation   Reuse a running instance.
  --resume-at=after-remote-preparation  Reuse a prepared remote workspace.
  --resume-at=after-cluster-creation    Reuse an allocated cluster.
  --resume-at=after-performer           Reuse the cluster and a running performer.

Resume selectors for execute (narrow a resume to one run; emitted by a left-up run):
  --resume-instance=<n>             Which instance to resume.
  --resume-cluster=<n>              Which cluster within the instance.
  --resume-session=<n>              Which session within the cluster.
  --resume-clusterless-session=<n>  Which clusterless (situational) session.
  --resume-run=<n>                  Which run within the session.`;

function countRuns(definition: ReturnType<typeof loadDefinition>): number {
  return definition.instances.reduce(
    (total, instance) =>
      total +
      instance.clusters.reduce(
        (clusterTotal, cluster) => clusterTotal + cluster.sessions.reduce((sessionTotal, session) => sessionTotal + session.runs.length, 0),
        0,
      ) +
      (instance.clusterlessSessions?.reduce((sessionTotal, session) => sessionTotal + session.runs.length, 0) ?? 0),
    0,
  );
}

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
      process.stderr.write("Usage: bun run definition -- generate-desc <file.json5>\n");
      process.exit(2);
    }
    const resolvedPath = isDefinitionUrl(path) ? await cacheDefinition(path) : path;
    const definition = loadDefinition(resolvedPath);
    process.stdout.write(describeDefinition(definition) + "\n");
    return;
  }

  // The global --interactive / --replay flags are read straight from
  // process.argv by the prompt session, so strip them here before we pick the
  // subcommand off the front — otherwise `definition -- --interactive <file>`
  // would treat "--interactive" as the subcommand and bail. The execute path's
  // rootDirFromArgv strips them from its own positionals too, so this is safe.
  const cleaned = extractInteractiveFlag(extractReplayFlag(argv).positionals).positionals;
  const [subcommand, ...rest] = cleaned;

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(HELP);
    if (!subcommand) process.exit(2);
    return;
  }

  // Be forgiving when no subcommand is given: `definition -- <file.yaml>`
  // (and so `definition -- --interactive <file.yaml>`, once the flag is
  // stripped above) is treated as an implicit `execute <file.yaml>`, which is
  // what people reach for. Anything that's neither a subcommand nor a plausible
  // definition file is a genuine mistake.
  const isSubcommand = SUBCOMMANDS.includes(subcommand as Subcommand);
  const looksLikeDefinitionPath = /\.(ya?ml|json5)$/i.test(subcommand) || existsSync(subcommand) || isDefinitionUrl(subcommand);
  if (!isSubcommand && !looksLikeDefinitionPath) {
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

  if (subcommand === "validate") {
    const [path] = rest;
    if (!path) {
      console.error("Usage: bun run definition -- validate <file.json5>");
      process.exit(2);
    }
    if (isDefinitionUrl(path)) {
      console.log(`Fetching definition from ${path}...`);
    }
    const resolvedPath = isDefinitionUrl(path) ? await cacheDefinition(path) : path;
    const definition = loadDefinition(resolvedPath);
    console.log(
      `✓ Valid ${FIT_DEFINITION_TYPE} definition (version ${definition.version}, ` +
        `${definition.instances.length} instance(s), ${countRuns(definition)} run(s)).`,
    );
    return;
  }

  // execute — either an explicit `execute ...` or an implicit bare path, in
  // which case the path itself is the first positional, so keep it.
  const executeArgs = isSubcommand ? rest : cleaned;
  const { rootDir, positionals } = rootDirFromArgv(executeArgs);
  const { resumeAt, positionals: afterResume } = extractResumeAt(positionals);
  const { selector: resumeSelector, positionals: afterSelector } = extractResumeSelector(afterResume);
  const [definitionPath, ...extra] = afterSelector;
  if (!definitionPath || extra.length > 0) {
    console.error(
      "Usage: bun run definition -- execute <file.yaml> [--resume-at=<point>] [resume selectors] [--root <dir>]\n" +
        "  --resume-at: after-instance-creation | after-remote-preparation | after-cluster-creation | after-performer\n" +
        "  resume selectors: --resume-instance=<n> --resume-cluster=<n> --resume-session=<n> --resume-clusterless-session=<n> --resume-run=<n>",
    );
    process.exit(2);
  }
  let resumePoint;
  try {
    resumePoint = parseResumePoint(resumeAt);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  if (isDefinitionUrl(definitionPath)) {
    console.log(`Fetching definition from ${definitionPath}...`);
  }
  const resolvedDefinitionPath = isDefinitionUrl(definitionPath)
    ? await cacheDefinition(definitionPath)
    : definitionPath;
  const definition = loadDefinition(resolvedDefinitionPath);
  console.log(
    `✓ Valid ${FIT_DEFINITION_TYPE} definition (version ${definition.version}, ` +
      `${definition.instances.length} instance(s), ${countRuns(definition)} run(s)).`,
  );
  return runFromDefinition(resolvedDefinitionPath, rootDir, {
    ...(resumePoint ? { resumeAt: resumePoint } : {}),
    resumeSelector,
  });
}

if (isMain(import.meta.url)) {
  runCli(() => definitionDispatch(process.argv.slice(2)));
}
