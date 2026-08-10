/**
 * Pure Block Kit renderer for a FIT run summary posted to a Slack thread. Takes a
 * plain, IO-free input shape (the orchestrator in ../post-run-summary.ts maps the
 * run's RunResultSummary[] + parsed JUnit data into it) so this stays unit
 * testable — see ../tests/slack-results.test.ts.
 *
 * Slack has no native multi-column table for chat.postMessage, so the failing-test
 * list uses a monospace code block (aligned columns); the rest is proper Block Kit
 * (header, section fields, context) so it reads as a polished message, not raw text.
 */

/** One run's outcome (one row of the definition's run matrix). */
export interface SlackRunResult {
  /** Rich path label, e.g. "aws1 / cbdino1 / java:main / func". */
  label: string;
  sdk: string;
  ok: boolean;
  testsRun?: number;
  failures?: number;
  errors?: number;
  skipped?: number;
  durationMs?: number;
  /** Failing test cases, most useful first; rendered as an aligned code block. */
  failingTests?: { name: string; detail?: string }[];
}

export interface SlackRunSummaryInput {
  /** Header label — the preset or definition name, e.g. "op-capella-sit-lite". */
  title: string;
  results: SlackRunResult[];
  /** Overall pass/fail across all results. */
  passed: boolean;
  /** Link back to the GitHub Actions run, when running under CI. */
  ghaRunUrl?: string;
}

const MAX_FAILING_TESTS = 15;

function fmtDuration(ms?: number): string {
  if (ms === undefined) return "";
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

/** One-line count summary for a single run, e.g. "412 run · 3 failed · 0 skipped · 16m41s". */
function countsLine(result: SlackRunResult): string {
  const parts: string[] = [];
  if (result.testsRun !== undefined) parts.push(`${result.testsRun} run`);
  const failed = (result.failures ?? 0) + (result.errors ?? 0);
  parts.push(`${failed} failed`);
  if (result.skipped) parts.push(`${result.skipped} skipped`);
  const dur = fmtDuration(result.durationMs);
  if (dur) parts.push(dur);
  return parts.join(" · ");
}

/** Render the failing tests of one result as an aligned monospace code block, or "" if none. */
function failingTestsBlock(result: SlackRunResult): string {
  const tests = result.failingTests ?? [];
  if (tests.length === 0) return "";
  const shown = tests.slice(0, MAX_FAILING_TESTS);
  const nameWidth = Math.max(...shown.map((t) => t.name.length));
  const lines = shown.map((t) => {
    const detail = t.detail ? `  ${t.detail.replace(/\s+/g, " ").slice(0, 80)}` : "";
    return `${t.name.padEnd(nameWidth)}${detail}`;
  });
  if (tests.length > shown.length) {
    lines.push(`… and ${tests.length - shown.length} more`);
  }
  return "```\n" + lines.join("\n") + "\n```";
}

/**
 * Build the Block Kit blocks + a plain-text fallback for a run summary. The
 * fallback text is what shows in notifications and in any client that can't
 * render blocks.
 */
export function renderSlackRunSummary(input: SlackRunSummaryInput): { text: string; blocks: unknown[] } {
  const overallEmoji = input.passed ? "✅" : "❌";
  const failedRuns = input.results.filter((r) => !r.ok).length;
  const fallback = input.passed
    ? `${overallEmoji} ${input.title} — passed (${input.results.length} run${input.results.length === 1 ? "" : "s"})`
    : `${overallEmoji} ${input.title} — ${failedRuns}/${input.results.length} run${input.results.length === 1 ? "" : "s"} failed`;

  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${overallEmoji} ${input.title}`.slice(0, 150), emoji: true },
    },
  ];

  for (const result of input.results) {
    const emoji = result.ok ? "✅" : "❌";
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `${emoji} *${result.sdk}* · \`${result.label}\`\n${countsLine(result)}` },
    });
    const failing = failingTestsBlock(result);
    if (failing) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: failing } });
    }
  }

  if (input.ghaRunUrl) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `🔗 <${input.ghaRunUrl}|GitHub Actions run>` }],
    });
  }

  return { text: fallback, blocks };
}
