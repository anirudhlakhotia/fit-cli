import * as core from "@actions/core";
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type SummaryTableCell = { data: string; header?: boolean; colspan?: string; rowspan?: string };
type SummaryTableRow = (SummaryTableCell | string)[];

interface RunSummary {
  path: { instanceIndex: number; clusterIndex?: number; sessionIndex?: number; runIndex?: number; clusterlessSession?: boolean };
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
  if (!process.env.GITHUB_STEP_SUMMARY) return;

  const { path, sdk, type, ok, summary } = result;
  const status = ok ? "✅ PASS" : "❌ FAIL";
  const pathLabel = path.clusterlessSession
    ? `Instance ${path.instanceIndex + 1} / Session ${(path.sessionIndex ?? 0) + 1} / Run ${(path.runIndex ?? 0) + 1}`
    : `Instance ${path.instanceIndex + 1} / Cluster ${(path.clusterIndex ?? 0) + 1} / Session ${(path.sessionIndex ?? 0) + 1} / Run ${(path.runIndex ?? 0) + 1}`;

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
  if (!summaryPath) return;

  const heading = `## ${description ?? "FIT run results"}\n\n`;

  try {
    const resp = await fetch(JUNIT_MARKDOWN_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const javaPath = join(runDir, "JunitMarkdown.java");
    writeFileSync(javaPath, await resp.text());

    const markdown = await new Promise<string>((resolve, reject) => {
      const child = spawn("java", [javaPath, runDir]);
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk));
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        // Exit 2 means "ran fine but found test failures" — still a valid markdown output.
        if (code === 0 || code === 2) resolve(stdout);
        else reject(new Error(`JunitMarkdown.java exited ${code}: ${stderr.trim()}`));
      });
    });

    appendFileSync(summaryPath, heading + markdown + "\n");
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
