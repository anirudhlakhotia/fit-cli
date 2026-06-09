#!/usr/bin/env node
/**
 * Top-level dispatcher for the `definition` npm script.
 *
 * npm run definition -- execute <file.yaml> [--resume-at=<point>] [--root <dir>]
 * npm run definition -- validate <file.yaml>
 */
import { existsSync } from "node:fs";
import { isMain, runCli } from "./util/non-fit/cli.js";
import { rootDirFromArgv } from "./util/fit/root.js";
import { extractInteractiveFlag, extractReplayFlag } from "./util/non-fit/replay.js";
import { runFromDefinition } from "./workflows/fit-functional/run-from-definition/run-from-definition.js";
import { loadDefinition } from "./workflows/fit-shared/definition/parse-definition.js";
import { FIT_DEFINITION_TYPE } from "./workflows/fit-shared/definition/types.js";
import {
  extractResumeAt,
  parseResumePoint,
} from "./workflows/fit-functional/run-from-definition/resume.js";

const SUBCOMMANDS = ["execute", "validate"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const HELP = `Manage FIT definition files.

Usage:
  npm run definition -- execute <file.yaml> [--resume-at=<point>] [--root <dir>]
  npm run definition -- validate <file.yaml>
  npm run definition -- --help

Subcommands:
  execute   Run FIT tests from a definition file.
  validate  Parse and validate a definition file without running it.

Resume points for execute:
  --resume-at=after-instance-creation   Reuse a running instance.
  --resume-at=after-remote-preparation  Reuse a prepared remote workspace.
  --resume-at=after-cluster-creation    Reuse an allocated cluster.
  --resume-at=after-performer           Reuse the cluster and a running performer.`;

if (isMain(import.meta.url)) {
  runCli(async () => {
    // The global --interactive / --replay flags are read straight from
    // process.argv by the prompt session, so strip them here before we pick the
    // subcommand off the front — otherwise `definition -- --interactive <file>`
    // would treat "--interactive" as the subcommand and bail. The execute path's
    // rootDirFromArgv strips them from its own positionals too, so this is safe.
    const argv = extractInteractiveFlag(extractReplayFlag(process.argv.slice(2)).positionals).positionals;
    const [subcommand, ...rest] = argv;

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
    const looksLikeDefinitionPath = /\.ya?ml$/i.test(subcommand) || existsSync(subcommand);
    if (!isSubcommand && !looksLikeDefinitionPath) {
      console.error(`Unknown subcommand: ${subcommand}\n`);
      console.error(HELP);
      process.exit(2);
    }

    if (subcommand === "validate") {
      const [path] = rest;
      if (!path) {
        console.error("Usage: npm run definition -- validate <file.yaml>");
        process.exit(2);
      }
      const definition = loadDefinition(path);
      const iterationCount = definition.cycles.reduce((total, cycle) => total + cycle.iterations.length, 0);
      console.log(
        `✓ Valid ${FIT_DEFINITION_TYPE} definition (version ${definition.version}, ` +
          `${definition.cycles.length} cycle(s), ${iterationCount} iteration(s)).`,
      );
      console.log(JSON.stringify(definition, null, 2));
      return;
    }

    // execute — either an explicit `execute ...` or an implicit bare path, in
    // which case the path itself is the first positional, so keep it.
    const executeArgs = isSubcommand ? rest : argv;
    const { rootDir, positionals } = rootDirFromArgv(executeArgs);
    const { resumeAt, positionals: afterResume } = extractResumeAt(positionals);
    const [definitionPath, ...extra] = afterResume;
    if (!definitionPath || extra.length > 0) {
      console.error(
        "Usage: npm run definition -- execute <file.yaml> [--resume-at=<point>] [--root <dir>]\n" +
          "  --resume-at: after-instance-creation | after-remote-preparation | after-cluster-creation | after-performer",
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
    return runFromDefinition(definitionPath, rootDir, { ...(resumePoint ? { resumeAt: resumePoint } : {}) });
  });
}
