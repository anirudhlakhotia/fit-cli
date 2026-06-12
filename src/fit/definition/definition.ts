#!/usr/bin/env node
/**
 * Top-level dispatcher for the `definition` npm script.
 *
 * npm run definition -- execute <file.yaml> [--resume-at=<point>] [resume selectors] [--root <dir>]
 * npm run definition -- validate <file.yaml>
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

const SUBCOMMANDS = ["execute", "validate", "generate-desc"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const HELP = `Manage FIT definition files.

Usage:
  npm run definition -- execute <file.json5> [--resume-at=<point>] [resume selectors] [--root <dir>]
  npm run definition -- validate <file.json5>
  npm run definition -- generate-desc <file.json5>
  npm run definition -- --help

Both .json5 and .yaml definition files are accepted.

Subcommands:
  execute        Run FIT tests from a definition file.
  validate       Parse and validate a definition file without running it.
  generate-desc  Print a compact description of a definition file (useful for CI labels).

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

if (isMain(import.meta.url)) {
  // generate-desc must run before runCli so console.log is never patched with
  // timestamps — the output needs to be machine-parseable.
  if (process.argv[2] === "generate-desc") {
    const path = process.argv[3];
    if (!path) {
      process.stderr.write("Usage: npm run definition -- generate-desc <file.json5>\n");
      process.exit(2);
    }
    (async () => {
      const resolvedPath = isDefinitionUrl(path) ? await cacheDefinition(path) : path;
      const definition = loadDefinition(resolvedPath);
      process.stdout.write(describeDefinition(definition) + "\n");
    })().catch((err) => {
      process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
      process.exit(1);
    });
  } else {
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
    const looksLikeDefinitionPath = /\.(ya?ml|json5)$/i.test(subcommand) || existsSync(subcommand) || isDefinitionUrl(subcommand);
    if (!isSubcommand && !looksLikeDefinitionPath) {
      console.error(`Unknown subcommand: ${subcommand}\n`);
      console.error(HELP);
      process.exit(2);
    }

    if (subcommand === "validate") {
      const [path] = rest;
      if (!path) {
        console.error("Usage: npm run definition -- validate <file.json5>");
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
    const executeArgs = isSubcommand ? rest : argv;
    const { rootDir, positionals } = rootDirFromArgv(executeArgs);
    const { resumeAt, positionals: afterResume } = extractResumeAt(positionals);
    const { selector: resumeSelector, positionals: afterSelector } = extractResumeSelector(afterResume);
    const [definitionPath, ...extra] = afterSelector;
    if (!definitionPath || extra.length > 0) {
      console.error(
        "Usage: npm run definition -- execute <file.yaml> [--resume-at=<point>] [resume selectors] [--root <dir>]\n" +
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
  });
  }
}
