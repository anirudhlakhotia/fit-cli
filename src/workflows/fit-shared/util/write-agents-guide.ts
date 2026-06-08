/**
 * Step: write an AGENTS.md into the current run directory. It's a small guide
 * pointed at any agent (or person) dropped into the run folder to debug a FIT
 * functional failure: it lists every artifact produced this run and nudges
 * them at the main run log as a starting point.
 *
 * Run on its own (writes a guide describing a couple of sample artifacts):
 *   npx tsx src/workflows/fit-shared/util/write-agents-guide.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  artifactFromPath,
  formatArtifactsTable,
  type Artifact,
} from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { ensureRunDir } from "../../../util/non-fit/replay.js";

/** Absolute path to the AGENTS.md guide in the current run directory. */
export function agentsGuidePath(runDir: string = ensureRunDir()): string {
  return join(runDir, "AGENTS.md");
}

/**
 * Pick the artifact an agent should read first when hunting for a failure. The
 * FIT test-driver log is the most useful, so prefer it; otherwise fall back to
 * the first artifact we have.
 */
function mainRunLog(artifacts: readonly Artifact[]): Artifact | undefined {
  return (
    artifacts.find((artifact) => /test-driver stdout/i.test(artifact.explanation)) ??
    artifacts.find((artifact) => artifact.filename.endsWith(".log")) ??
    artifacts[0]
  );
}

/** Render the AGENTS.md body for the given artifacts. */
export function formatAgentsGuide(artifacts: readonly Artifact[]): string {
  const table = formatArtifactsTable(artifacts) ?? "(no artifacts were produced this run)";
  const mainLog = mainRunLog(artifacts);
  const mainLogName = mainLog ? `\`${mainLog.filename}\`` : "the main run log";

  return [
    "# AGENTS.md",
    "",
    "This is a guide for agents.",
    "",
    "If you've been pointed at this folder, it might be to help debug a failure. " +
      "Here are the various artifacts available to you:",
    "",
    "```",
    table,
    "```",
    "",
    `If you've been given no other instruction, consider looking through ${mainLogName} ` +
      "for an obvious failure, and then debug that.",
    "",
  ].join("\n");
}

export interface WriteAgentsGuideResult {
  /** Where the guide was written. */
  path: string;
  /** Artifact metadata for the written guide. */
  artifact: Artifact;
}

/**
 * Write the AGENTS.md guide describing `artifacts` into `runDir`. The guide
 * itself is included in the table so the folder fully describes itself.
 */
export function writeAgentsGuide(
  artifacts: readonly Artifact[],
  runDir: string = ensureRunDir(),
): WriteAgentsGuideResult {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const path = agentsGuidePath(runDir);
  const guideArtifact = artifactFromPath(path, "A guide for agents debugging the run", runDir);
  writeFileSync(path, formatAgentsGuide([...artifacts, guideArtifact]));
  return { path, artifact: guideArtifact };
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const samples: Artifact[] = [
      { filename: "it0/driver.log", explanation: "FIT test-driver stdout/stderr captured for this run" },
      { filename: "it0/FITConfiguration.json", explanation: "Generated FITConfiguration.json for the FIT test-driver" },
    ];
    const { path } = writeAgentsGuide(samples);
    console.log(`Wrote a sample AGENTS.md to:\n${path}`);
    return Promise.resolve();
  });
}
