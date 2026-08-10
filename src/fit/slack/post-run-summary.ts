/**
 * Post a FIT run summary to a Slack thread — the hook behind `fit run --slack-thread`.
 *
 * Hard rule: this NEVER throws and never affects the run's exit code. It is wired
 * into a shared GHA many SDK owners depend on, so a missing token, a bot that
 * isn't in the channel, a bad thread reference, or a network blip must warn and
 * continue, not fail the run. Every path here is best-effort.
 *
 * Run directly (development), posting a fake summary to a thread:
 *   SLACK_BOT_TOKEN=xoxb-… bun src/fit/slack/post-run-summary.ts <permalink|channel:ts>
 */
import type { RunResultSummary } from "../functional/run-from-definition/run-from-definition.js";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { loadDotenv } from "../../util/non-fit/dotenv.js";
import { resolveSlackToken } from "../util/config.js";
import { parseJunitDataFromDir } from "../shared/run-test-driver/junit-to-markdown.js";
import { parseSlackMessageRef } from "./util/slack-parse.js";
import { postMessage } from "./util/slack-api.js";
import { renderSlackRunSummary, type SlackRunResult } from "./util/slack-results.js";

/** The GitHub Actions run URL, when running under CI. */
function ghaRunUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const { GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID) return undefined;
  return `https://github.com/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

/** Map a run's RunResultSummary (with its surefire dir) to the Slack renderer's input. */
function toSlackResult(result: RunResultSummary): SlackRunResult {
  const summary = result.summary;
  const junit = result.surefireDir ? parseJunitDataFromDir(result.surefireDir) : undefined;
  const failingTests = junit?.failingCases.map((c) => ({
    name: `${c.classname.split(".").pop() ?? c.classname}.${c.name}`,
    ...(c.issues[0]?.message ? { detail: c.issues[0].message } : {}),
  }));
  return {
    label: result.pathLabel,
    sdk: result.sdk,
    ok: result.ok,
    ...(summary?.testsRun !== undefined ? { testsRun: summary.testsRun } : {}),
    ...(summary ? { failures: summary.failures, errors: summary.errors, skipped: summary.skipped } : {}),
    ...(summary?.durationMs !== undefined ? { durationMs: summary.durationMs } : {}),
    ...(failingTests && failingTests.length > 0 ? { failingTests } : {}),
  };
}

export interface PostRunSummaryOptions {
  /** Thread reference: a permalink, channel:ts, p-number, or bare ts. */
  slackThread: string;
  /** Header label — the preset or definition name. */
  title: string;
  results: RunResultSummary[];
  /** Overall pass (no run-failing failure). */
  passed: boolean;
}

/**
 * Post the run summary as a threaded reply. Resolves the bot token (env → AWS
 * secret) and the channel (from the reference, else SLACK_CHANNEL_ID, else the
 * environments.json5 default). Any problem is logged and swallowed.
 */
export async function postRunSummaryToSlack(options: PostRunSummaryOptions): Promise<void> {
  try {
    loadDotenv();
    const token = await resolveSlackToken();
    if (!token) {
      console.warn("Slack: no bot token (SLACK_BOT_TOKEN or fit-cli/slack/token); skipping run summary.");
      return;
    }

    let ref;
    try {
      ref = parseSlackMessageRef(options.slackThread);
    } catch (err) {
      console.warn(`Slack: ${(err as Error).message} — skipping run summary.`);
      return;
    }

    const channel = (ref.channel || process.env.SLACK_CHANNEL_ID)?.trim();
    if (!channel) {
      console.warn(
        "Slack: no channel for a bare thread ts. Use a permalink or channel:ts, or set SLACK_CHANNEL_ID " +
          "— skipping run summary.",
      );
      return;
    }

    const { text, blocks } = renderSlackRunSummary({
      title: options.title,
      results: options.results.map(toSlackResult),
      passed: options.passed,
      ...(ghaRunUrl() ? { ghaRunUrl: ghaRunUrl() } : {}),
    });

    await postMessage(token, channel, text, ref.ts, blocks);
    console.log(`Slack: posted run summary to thread ${ref.ts} in ${channel}.`);
  } catch (err) {
    // Includes not_in_channel / thread_not_found / network errors: warn, never throw.
    console.warn(`Slack: failed to post run summary (continuing): ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const [thread] = process.argv.slice(2);
    if (!thread) throw new Error("Usage: post-run-summary <permalink|channel:ts|ts>");
    await postRunSummaryToSlack({
      slackThread: thread,
      title: "demo-preset",
      passed: false,
      results: [
        { path: {} as RunResultSummary["path"], pathLabel: "aws1 / cbdino1 / java:main / func", sdk: "java:main", type: "functional", ok: false, summary: { testsRun: 388, failures: 3, errors: 0, skipped: 0, durationMs: 1001000 } },
      ],
    });
  });
}
