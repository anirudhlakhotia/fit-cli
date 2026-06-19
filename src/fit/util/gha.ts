import * as core from "@actions/core";
import { appendFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture } from "../../util/non-fit/proc.js";

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
  type: string;
  ok: boolean;
  summary?: { testsRun: number; failures: number; errors: number; skipped: number };
}

/**
 * Append a per-run result block to $GITHUB_STEP_SUMMARY. No-ops outside GHA.
 * The format mirrors the terminal Details table: label/value pairs rendered as
 * a GH-flavoured markdown table so each run gets its own block in the job summary.
 */
export async function appendRunSummaryToGhaSummary(result: RunSummary): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) {
    console.log(`[gha-summary] appendRunSummaryToGhaSummary: GITHUB_STEP_SUMMARY unset — skipping`);
    return;
  }

  const { pathLabel, sdk, type, ok, summary } = result;
  const status = ok ? "✅ PASS" : "❌ FAIL";
  const sizeBefore = summaryFileSize();

  const rows: SummaryTableRow[] = [
    [{ data: "Detail", header: true }, { data: "Value", header: true }],
    ["Path", pathLabel],
    ["SDK", sdk],
    ["Type", type],
    ...(summary
      ? ([
          ["Tests run", String(summary.testsRun)],
          ["Failures", String(summary.failures)],
          ["Errors", String(summary.errors)],
          ["Skipped", String(summary.skipped)],
        ] as SummaryTableRow[])
      : []),
    [{ data: "Result", header: true }, status],
  ];

  await core.summary
    .addHeading(`${pathLabel} (${sdk}) — ${status}`, 3)
    .addTable(rows)
    .write({ overwrite: false });

  console.log(
    `[gha-summary] wrote per-run block for "${pathLabel}" to ${process.env.GITHUB_STEP_SUMMARY} ` +
      `(file ${sizeBefore} → ${summaryFileSize()} bytes)`,
  );
}

/**
 * Emits a GHA notice annotation with a direct link to the artifact bundle for
 * this run. The notice surfaces in the step log as a highlighted callout, making
 * the artifacts easy to find without hunting through the run page.
 */
export function emitGhaArtifactNotice(): void {
  const { GITHUB_RUN_ID, GITHUB_REPOSITORY } = process.env;
  if (!GITHUB_RUN_ID || !GITHUB_REPOSITORY) return;

  const url = `https://github.com/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}#artifacts`;
  const name = `fit-cli-run-${GITHUB_RUN_ID}`;
  // GHA workflow command: printed to stdout, parsed by the runner.
  console.log(`::notice title=Run artifacts (${name})::${url}`);
}

const JUNIT_MARKDOWN_URL =
  "https://raw.githubusercontent.com/couchbaselabs/junit-markdown/refs/heads/main/JunitMarkdown.java";

/**
 * Append a JUnit test summary to $GITHUB_STEP_SUMMARY using JunitMarkdown.java.
 * Uses `description` (from the definition file) as the section heading.
 * Falls back to a plain heading-only entry if java is unavailable or the
 * download fails. Never throws — a broken summary is a warning, not a failure.
 */
export async function appendJunitStepSummary(runDir: string, description?: string): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    console.log(`[gha-summary] appendJunitStepSummary: GITHUB_STEP_SUMMARY unset — skipping`);
    return;
  }
  console.log(`[gha-summary] appendJunitStepSummary: target=${summaryPath} (currently ${summaryFileSize()} bytes)`);

  // Leading \n is load-bearing: appendRunSummaryToGhaSummary writes raw HTML
  // (<table> etc.) via @actions/core, and GFM only closes an HTML block on a
  // blank line. Without it this heading is swallowed into the open HTML block
  // and rendered as literal text instead of an <h2>.
  const heading = `\n## ${description ?? "FIT run results"}\n\n`;

  try {
    const resp = await fetch(JUNIT_MARKDOWN_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const javaPath = join(runDir, "JunitMarkdown.java");
    writeFileSync(javaPath, await resp.text());

    // Exit 2 means "ran fine but found test failures" — still a valid markdown output.
    const markdown = await capture("java", [javaPath, runDir], undefined, { allowExitCodes: [0, 2] });
    console.log(`[gha-summary] JunitMarkdown produced ${markdown.length} chars of markdown`);

    const sizeBefore = summaryFileSize();
    appendFileSync(summaryPath, heading + markdown + "\n");
    const sizeAfter = summaryFileSize();
    console.log(
      `[gha-summary] appended JUnit summary (${heading.length + markdown.length + 1} bytes); ` +
        `file ${sizeBefore} → ${sizeAfter} bytes. ` +
        // GitHub silently drops the whole step summary if the file exceeds 1 MiB.
        (sizeAfter > 1024 * 1024 ? `⚠ OVER 1 MiB cap — GitHub will drop the step summary!` : `(under 1 MiB cap)`),
    );
  } catch (err) {
    console.warn(`Warning: failed to generate JUnit step summary (${err}); writing plain summary`);
    try {
      appendFileSync(summaryPath, heading + "_JUnit summary unavailable._\n");
    } catch {
      // ignore — if we can't write the fallback, there's nothing more to do
    }
  }
}

/** Updates the GitHub Actions workflow run display title, if running inside GHA. */
export async function updateGhaRunTitle(title: string): Promise<void> {
  const { GITHUB_RUN_ID, GITHUB_REPOSITORY } = process.env;
  // PATCH /actions/runs/{id} requires the built-in run-scoped token, not a PAT — use GHA_RUN_TOKEN.
  const token = process.env.GHA_RUN_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!GITHUB_RUN_ID || !GITHUB_REPOSITORY || !token) return;

  try {
    const resp = await fetch(
      `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ display_title: title }),
      },
    );
    if (!resp.ok) {
      console.warn(`Warning: failed to update GHA run title (HTTP ${resp.status})`);
    }
  } catch (e) {
    console.warn(`Warning: failed to update GHA run title: ${e}`);
  }
}
