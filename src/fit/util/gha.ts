import * as core from "@actions/core";
import { appendFileSync, existsSync, statSync } from "node:fs";
import { junitToMarkdownFromDir } from "../shared/run-test-driver/junit-to-markdown.js";
import { readSituationalResultsCsv, renderSituationalResultsMarkdown } from "../shared/run-test-driver/situational-results.js";

/** Current size of the $GITHUB_STEP_SUMMARY file in bytes, or -1 if missing/unset. */
function summaryFileSize(): number {
  const p = process.env.GITHUB_STEP_SUMMARY;
  if (!p || !existsSync(p)) return -1;
  try {
    return statSync(p).size;
  } catch {
    return -1;
  }
}
interface RunSummary {
  /** Rich path label (`aws1 / cbdino1 / java:main / func`), precomputed by the run loop. */
  pathLabel: string;
  sdk: string;
  ok: boolean;
  summary?: { testsRun: number; failures: number; errors: number; skipped: number };
  /** Local path to the surefire-reports dir for this run; appended as a JUnit table if present. */
  surefireDir?: string;
  /** Local path to the collected situational-results CSV; appended as a table below the JUnit one if present. */
  situationalResultsCsv?: string;
}

/**
 * Build the collapsed `<details>` block for one run: the always-visible
 * `<summary>` line is `pathLabel (sdk) — status`, with the Metric/Value table
 * and any pre-rendered JUnit/situational markdown collapsed inside it. Pure —
 * callers own the file I/O (reading surefireDir/situationalResultsCsv) and
 * pass already-rendered markdown in, so this stays unit-testable.
 */
export function renderRunSummaryBlock(args: {
  pathLabel: string;
  sdk: string;
  ok: boolean;
  summary?: { testsRun: number; failures: number; errors: number; skipped: number };
  /** Pre-rendered via junitToMarkdownFromDir. */
  junitMarkdown?: string;
  /** Pre-rendered via renderSituationalResultsMarkdown. */
  situationalMarkdown?: string;
}): string {
  const { pathLabel, sdk, ok, summary, junitMarkdown, situationalMarkdown } = args;
  const status = ok ? "✅ PASS" : "❌ FAIL";
  const lines: string[] = [];

  lines.push("<details>");
  lines.push(`<summary>${pathLabel} (${sdk}) — ${status}</summary>`);
  lines.push("");

  if (summary) {
    lines.push("| Metric | Value |");
    lines.push("|---|---|");
    lines.push(`| Tests run | ${summary.testsRun} |`);
    lines.push(`| Failures | ${summary.failures} |`);
    lines.push(`| Errors | ${summary.errors} |`);
    lines.push(`| Skipped | ${summary.skipped} |`);
    lines.push("");
  }

  // Situational-only: the authoritative pass/fail signal for these scenarios comes from
  // the performer's scoring, not JUnit assertions, so this table is the more meaningful
  // one — appended below the JUnit table, matching fit-app-deployment's ordering.
  for (const markdown of [junitMarkdown, situationalMarkdown]) {
    if (!markdown) continue;
    lines.push(markdown.trimEnd());
    lines.push("");
  }

  lines.push("</details>");
  lines.push("");

  return lines.join("\n");
}

/**
 * Append a per-run result block to $GITHUB_STEP_SUMMARY. No-ops outside GHA.
 * Collapsed by default — one `<details>` block per run, its `<summary>` line
 * showing the pass/fail status so it's visible without expanding.
 */
export function appendRunSummaryToGhaSummary(result: RunSummary): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    console.log(`[gha-summary] appendRunSummaryToGhaSummary: GITHUB_STEP_SUMMARY unset — skipping`);
    return;
  }

  const { pathLabel, sdk, ok, summary, surefireDir, situationalResultsCsv } = result;
  const sizeBefore = summaryFileSize();

  let junitMarkdown: string | undefined;
  if (surefireDir) {
    try {
      junitMarkdown = junitToMarkdownFromDir(surefireDir);
    } catch (err) {
      console.warn(`Warning: failed to render JUnit table for "${pathLabel}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let situationalMarkdown: string | undefined;
  if (situationalResultsCsv) {
    try {
      const rows = readSituationalResultsCsv(situationalResultsCsv);
      if (rows) situationalMarkdown = renderSituationalResultsMarkdown(rows);
    } catch (err) {
      console.warn(`Warning: failed to render situational results table for "${pathLabel}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const block = renderRunSummaryBlock({ pathLabel, sdk, ok, summary, junitMarkdown, situationalMarkdown });
  try {
    appendFileSync(summaryPath, "\n" + block + "\n");
    console.log(`[gha-summary] wrote per-run block for "${pathLabel}" to ${summaryPath} (file ${sizeBefore} → ${summaryFileSize()} bytes)`);
  } catch (err) {
    console.warn(`Warning: failed to append per-run GHA step summary block for "${pathLabel}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Append a "Run artifacts" section to $GITHUB_STEP_SUMMARY with the
 * `fit archive fetch` command so reviewers can pull the run down locally.
 * No-ops outside GHA or when GITHUB_STEP_SUMMARY is unset.
 */
export async function appendArtifactFetchToGhaSummary(s3Uri: string): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) return;

  await core.summary
    .addHeading("Run artifacts (S3)", 3)
    .addRaw(`<p>Artifacts uploaded — download locally with:</p>`)
    .addCodeBlock(`fit archive fetch ${s3Uri}`, "sh")
    .write({ overwrite: false });
}

/**
 * Emits a GHA notice annotation with a direct link to the artifact bundle for
 * this run. Links to the S3 zip when available (preferred — survives beyond the
 * GHA retention window), otherwise falls back to the GHA run page.
 */
export function emitGhaArtifactNotice(s3Uri?: string): void {
  const { GITHUB_RUN_ID, GITHUB_REPOSITORY } = process.env;
  if (!GITHUB_RUN_ID || !GITHUB_REPOSITORY) return;

  const url = s3Uri ?? `https://github.com/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
  const name = `fit-cli-run-${GITHUB_RUN_ID}`;
  // GHA workflow command: printed to stdout, parsed by the runner.
  console.log(`::notice title=Run artifacts (${name})::${url}`);
}
