import * as core from "@actions/core";
import { appendFileSync, existsSync, statSync } from "node:fs";
import { junitToMarkdownFromDir } from "../shared/run-test-driver/junit-to-markdown.js";

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
type SummaryTableCell = { data: string; header?: boolean; colspan?: string; rowspan?: string };
type SummaryTableRow = (SummaryTableCell | string)[];

interface RunSummary {
  /** Rich path label (`aws1 / cbdino1 / java:main / func`), precomputed by the run loop. */
  pathLabel: string;
  sdk: string;
  ok: boolean;
  summary?: { testsRun: number; failures: number; errors: number; skipped: number };
  /** Local path to the surefire-reports dir for this run; appended as a JUnit table if present. */
  surefireDir?: string;
}

/**
 * Append a per-run result block to $GITHUB_STEP_SUMMARY. No-ops outside GHA.
 * Writes a heading, a label/value details table, and (if surefireDir is set) the
 * full per-package JUnit results table — one block per run.
 */
export async function appendRunSummaryToGhaSummary(result: RunSummary): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    console.log(`[gha-summary] appendRunSummaryToGhaSummary: GITHUB_STEP_SUMMARY unset — skipping`);
    return;
  }

  const { pathLabel, sdk, ok, summary, surefireDir } = result;
  const status = ok ? "✅ PASS" : "❌ FAIL";
  const sizeBefore = summaryFileSize();

  let s = core.summary.addHeading(`${pathLabel} (${sdk}) — ${status}`, 3);
  if (summary) {
    const rows: SummaryTableRow[] = [
      [{ data: "Metric", header: true }, { data: "Value", header: true }],
      ["Tests run", String(summary.testsRun)],
      ["Failures", String(summary.failures)],
      ["Errors", String(summary.errors)],
      ["Skipped", String(summary.skipped)],
    ];
    s = s.addTable(rows);
  }
  await s.write({ overwrite: false });

  // Append the per-package JUnit table directly to the summary file.
  // appendFileSync is used here rather than core.summary because core.summary
  // writes raw HTML blocks whose GFM parsing requires a blank line before the
  // next markdown element — we inject that leading \n to close the HTML block.
  if (surefireDir) {
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
      try {
        const markdown = junitToMarkdownFromDir(surefireDir);
        appendFileSync(summaryPath, "\n" + markdown + "\n");
      } catch (err) {
        console.warn(`Warning: failed to append JUnit table for "${pathLabel}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  console.log(
    `[gha-summary] wrote per-run block for "${pathLabel}" to ${process.env.GITHUB_STEP_SUMMARY} ` +
      `(file ${sizeBefore} → ${summaryFileSize()} bytes)`,
  );
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
