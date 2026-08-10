#!/usr/bin/env node
/**
 * Slack mini CLI — search a channel's recent history, post a message, or reply
 * in a thread, using a Slack bot token.
 *
 * Auth: SLACK_BOT_TOKEN (a xoxb-… bot token), read from the environment or ./.env.
 * Default channel: --channel, else SLACK_CHANNEL_ID. The bot must be a member of
 * any channel you search or post to (/invite @your-bot).
 *
 * Run directly (development):
 *   bun src/fit/slack/slack.ts --help
 *   bun src/fit/slack/slack.ts search "cxx failed" --channel C08FV3X1CCA
 *   bun src/fit/slack/slack.ts post "nightly is green" --channel C08FV3X1CCA
 *   bun src/fit/slack/slack.ts post-thread 1720000000.123456 "…and here are the details"
 *   # a permalink carries the channel, so --channel is optional there:
 *   bun src/fit/slack/slack.ts post-thread https://couchbase.slack.com/archives/C08FV3X1CCA/p1720000000123456 "reply"
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { loadDotenv } from "../../util/non-fit/dotenv.js";
import { runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import { matchMessages, parseArgs, parseSlackMessageRef } from "./util/slack-parse.js";
import { fetchChannelHistory, getPermalink, postMessage } from "./util/slack-api.js";
import { resolveSlackToken } from "../util/config.js";

const VALUE_FLAGS = ["channel", "limit"] as const;
const DEFAULT_SEARCH_LIMIT = 200;

/** Load ./.env (mini CLIs don't do this automatically), then resolve the bot token (env → AWS secret). */
async function resolveToken(): Promise<string> {
  loadDotenv();
  const token = await resolveSlackToken();
  if (!token) {
    throw new Error(
      "No Slack token found. Export SLACK_BOT_TOKEN (a xoxb-… bot token), add it to ./.env, " +
        "or store it in AWS Secrets Manager at fit-cli/slack/token.",
    );
  }
  return token;
}

/** Resolve the channel: explicit --channel, else one recovered from a permalink, else SLACK_CHANNEL_ID. */
function resolveChannel(explicit: string | undefined, fromRef?: string): string {
  const channel = (explicit || fromRef || process.env.SLACK_CHANNEL_ID)?.trim();
  if (!channel) {
    throw new Error(
      "No Slack channel. Pass --channel C0123, include a message permalink, or set SLACK_CHANNEL_ID.",
    );
  }
  return channel;
}

async function cmdSearch(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs(argv, VALUE_FLAGS);
  const query = positionals.join(" ").trim();
  if (!query) {
    throw new Error(`search needs a query, e.g. ${runScriptPrefix("slack")} search "cxx failed" --channel C0123.`);
  }
  const token = await resolveToken();
  const channel = resolveChannel(values.channel);
  const limit = values.limit ? Number(values.limit) : DEFAULT_SEARCH_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`--limit must be a positive number, got "${values.limit}".`);
  }

  let messages;
  try {
    messages = await fetchChannelHistory(token, channel, limit);
  } catch (err) {
    if (err instanceof Error && err.message.includes("not_in_channel")) {
      throw new Error(`The bot isn't in channel ${channel}. Invite it (/invite @your-bot) and retry.`, { cause: err });
    }
    if (err instanceof Error && err.message.includes("missing_scope")) {
      throw new Error(
        "The bot token lacks the scope needed to read history. Add channels:history (public) " +
          "or groups:history (private) to the Slack app and reinstall. Posting only needs chat:write.",
        { cause: err },
      );
    }
    throw err;
  }

  const matches = matchMessages(messages, query);
  if (matches.length === 0) {
    console.log(`No matches for "${query}" in the last ${messages.length} message(s) of ${channel}.`);
    return;
  }

  console.log(`${matches.length} of ${messages.length} recent message(s) match "${query}" in ${channel}:\n`);
  for (const message of matches) {
    const permalink = await getPermalink(token, channel, message.ts);
    const snippet = (message.text ?? "").replace(/\s+/g, " ").slice(0, 140);
    const thread = message.reply_count
      ? ` (thread, ${message.reply_count} repl${message.reply_count === 1 ? "y" : "ies"})`
      : "";
    console.log(`• ts=${message.ts}${thread}`);
    console.log(`  ${snippet}`);
    if (permalink) {
      console.log(`  ${permalink}`);
    }
    console.log(`  reply: ${runScriptPrefix("slack")} post-thread ${message.ts} "…" --channel ${channel}`);
    console.log("");
  }
}

async function cmdPost(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs(argv, VALUE_FLAGS);
  const text = positionals.join(" ").trim();
  if (!text) {
    throw new Error(`post needs a message, e.g. ${runScriptPrefix("slack")} post "hello" --channel C0123.`);
  }
  const token = await resolveToken();
  const channel = resolveChannel(values.channel);
  const ts = await postMessage(token, channel, text);
  console.log(`Posted to ${channel}.`);
  console.log(`Thread ts: ${ts}`);
  console.log(`Reply in thread: ${runScriptPrefix("slack")} post-thread ${ts} "…" --channel ${channel}`);
}

async function cmdPostThread(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs(argv, VALUE_FLAGS);
  const [ref, ...textParts] = positionals;
  if (!ref) {
    throw new Error("post-thread needs a thread reference (a ts, p-number, or message permalink) first.");
  }
  const text = textParts.join(" ").trim();
  if (!text) {
    throw new Error("post-thread needs a message after the thread reference.");
  }
  const parsed = parseSlackMessageRef(ref);
  const token = await resolveToken();
  const channel = resolveChannel(values.channel, parsed.channel);
  const ts = await postMessage(token, channel, text, parsed.ts);
  console.log(`Replied in thread ${parsed.ts} on ${channel} (new message ts ${ts}).`);
}

function helpText(): string {
  const p = runScriptPrefix("slack");
  return `fit-cli Slack helper — search a channel, post a message, reply in a thread.

Usage:
  ${p} search <query> [--channel C0123] [--limit ${DEFAULT_SEARCH_LIMIT}]
  ${p} post <message> [--channel C0123]
  ${p} post-thread <ts|p-number|permalink> <message> [--channel C0123]

Auth:  export SLACK_BOT_TOKEN (a xoxb-… bot token), or put it in ./.env.
       Default channel comes from --channel or SLACK_CHANNEL_ID.
       The bot must be a member of any channel you search or post to.

Notes:
  • search scans the channel's recent history (a "channel scan"); it is not a
    full workspace search — that would need a user token with search:read.
  • A thread is just its parent message's ts. 'post' prints the ts to reply to;
    'post-thread' also accepts a copied message permalink (which carries the
    channel, making --channel optional).`;
}

export function runSlackMain(): void {
  runCli(async () => {
    const [command, ...rest] = process.argv.slice(2);
    switch (command) {
      case "search":
        await cmdSearch(rest);
        return;
      case "post":
        await cmdPost(rest);
        return;
      case "post-thread":
        await cmdPostThread(rest);
        return;
      default:
        console.log(helpText());
        if (command !== undefined && command !== "--help" && command !== "-h") process.exit(2);
    }
  });
}

if (isMain(import.meta.url)) {
  runSlackMain();
}
