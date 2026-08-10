/**
 * Pure parsing helpers for the Slack mini CLI. Kept free of IO so they can be
 * unit tested (see ../tests/slack-parse.test.ts).
 */

/** A Slack message as returned by conversations.history (the fields we use). */
export interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  thread_ts?: string;
  reply_count?: number;
}

/** A reference to a specific Slack message: its ts, and channel if we could recover it. */
export interface SlackMessageRef {
  ts: string;
  /** Present when the reference was a permalink, which carries the channel id. */
  channel?: string;
}

/**
 * Minimal argv parser: pulls out the given value-taking flags (`--channel C0123`
 * or `--channel=C0123`) and returns the rest as positionals. Deliberately tiny —
 * matching fit-cli's convention of each command parsing its own argv rather than
 * pulling in an options library.
 */
export function parseArgs(
  argv: readonly string[],
  valueFlags: readonly string[],
): { values: Record<string, string>; positionals: string[] } {
  const values: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      values[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (arg.startsWith("--") && valueFlags.includes(arg.slice(2))) {
      values[arg.slice(2)] = argv[i + 1] ?? "";
      i++;
    } else {
      positionals.push(arg);
    }
  }
  return { values, positionals };
}

/**
 * A Slack thread is identified by its parent message's `ts`. Accept the several
 * shapes a user is likely to have on hand:
 *   - a raw ts:        1720000000.123456
 *   - a "p-number":    p1720000000123456  (as it appears in a permalink path)
 *   - a permalink:     https://x.slack.com/archives/C0123/p1720000000123456
 * A permalink also carries the channel, so we return it too. If the permalink has
 * a `thread_ts` query param (Slack adds it for links to replies), that is the
 * parent-thread ts and wins over the message's own p-number.
 */
export function parseSlackMessageRef(input: string): SlackMessageRef {
  const trimmed = input.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error(`Not a valid Slack message URL: ${input}`);
    }
    const match = url.pathname.match(/\/archives\/([A-Z0-9]+)\/p(\d+)/i);
    if (!match) {
      throw new Error(`Could not find a channel/message id in Slack URL: ${input}`);
    }
    const threadTs = url.searchParams.get("thread_ts");
    return { channel: match[1], ts: threadTs ?? pNumberToTs(match[2]) };
  }

  // Compact "channel:ts" form, e.g. C08FV3X1CCA:1720000000.123456
  const colon = trimmed.match(/^([CGD][A-Z0-9]+):(\d+\.\d+)$/i);
  if (colon) {
    return { channel: colon[1], ts: colon[2] };
  }

  if (/^p\d{7,}$/i.test(trimmed)) {
    return { ts: pNumberToTs(trimmed.slice(1)) };
  }

  if (/^\d+\.\d+$/.test(trimmed)) {
    return { ts: trimmed };
  }

  throw new Error(
    `Not a recognised Slack message reference: "${input}". Expected a ts (1720000000.123456), ` +
      `a channel:ts (C0123:1720000000.123456), a p-number (p1720000000123456), or a message permalink.`,
  );
}

/** Convert a permalink p-number (no decimal) to a ts by restoring the 6-digit fraction. */
function pNumberToTs(digits: string): string {
  if (digits.length <= 6) {
    throw new Error(`Slack message id too short to be a timestamp: ${digits}`);
  }
  return `${digits.slice(0, -6)}.${digits.slice(-6)}`;
}

/** Case-insensitive substring match over message text — the "channel scan" search. */
export function matchMessages(messages: readonly SlackMessage[], query: string): SlackMessage[] {
  const needle = query.toLowerCase();
  return messages.filter((message) => (message.text ?? "").toLowerCase().includes(needle));
}
