/**
 * Renders the cap matrix: capabilities down the side, SDKs across the top.
 *
 * Pure formatting — takes already-fetched results and returns strings. The colour
 * decision is made once, via the shared `colourEnabled()`, so the table is plain
 * text when piped or redirected.
 */
import { colourEnabled } from "../../../util/non-fit/fit-cli-log.js";
import type { Sdk } from "../../../util/sdk/sdks.js";
import { CAP_GROUPS, type Cap, type CapGroup, type CapsFile, capsByNumber, capsInGroup } from "./caps-metadata.js";
import type { PerformerCaps } from "./performer-caps-rpc.js";

/** What happened when we asked one SDK's performer for its caps. */
export type CapsFetchResult =
  | { sdk: Sdk; status: "ok"; caps: PerformerCaps }
  /** The performer ran but doesn't implement performerCapsFetch (pre-ExtSDKIntegration). */
  | { sdk: Sdk; status: "unimplemented" }
  /** The image wouldn't pull, the container wouldn't start, or the RPC failed. */
  | { sdk: Sdk; status: "error"; error: string };

const colour = colourEnabled();
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[90m";
const BOLD = "\x1b[1m";

function paint(text: string, code: string): string {
  return colour ? `${code}${text}${RESET}` : text;
}

export const TICK = "✓";
export const CROSS = "✗";
/** Shown where we have no answer at all — distinct from a definite "not supported". */
export const UNKNOWN = "?";

/** The cell for one cap × one SDK. */
export function capCell(result: CapsFetchResult, group: CapGroup, capNumber: number): string {
  if (result.status !== "ok") return UNKNOWN;
  const reported = reportedNumbers(result.caps, group);
  return reported.includes(capNumber) ? TICK : CROSS;
}

/** The cap numbers a performer reported for one group. */
export function reportedNumbers(caps: PerformerCaps, group: CapGroup): number[] {
  switch (group) {
    case "sdk":
      return caps.sdkCaps;
    case "transactions":
      return caps.transactionCaps;
    case "performer":
      return caps.performerCaps;
  }
}

function paintCell(cell: string): string {
  if (cell === TICK) return paint(TICK, GREEN);
  if (cell === CROSS) return paint(CROSS, RED);
  return paint(cell, DIM);
}

/**
 * Caps reported by some performer but absent from caps.json5 — i.e. the protos have
 * moved on. Rendered as extra rows so a new cap can never silently vanish from the
 * table just because nobody has catalogued it yet.
 */
export function unknownCapNumbers(results: readonly CapsFetchResult[], known: Map<number, Cap>, group: CapGroup): number[] {
  const unknown = new Set<number>();
  for (const result of results) {
    if (result.status !== "ok") continue;
    for (const number of reportedNumbers(result.caps, group)) {
      if (!known.has(number)) unknown.add(number);
    }
  }
  return [...unknown].sort((a, b) => a - b);
}

/** Column header for an SDK — short, because there can be ten of them. */
export function sdkColumnLabel(sdk: Sdk): string {
  return sdk.value;
}

const GROUP_TITLES: Record<CapGroup, string> = {
  sdk: "SDK capabilities (sdk.Caps) — features of the SDK under test",
  transactions: "Transactions capabilities (transactions.Caps) — features of the transactions library under test",
  performer: "Performer capabilities (performer.Caps) — features of the performer harness itself",
};

/** Visible width of a string, ignoring any ANSI colour codes wrapped around it. */
function visibleWidth(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function centreVisible(text: string, width: number): string {
  const pad = Math.max(0, width - visibleWidth(text));
  const left = Math.floor(pad / 2);
  return " ".repeat(left) + text + " ".repeat(pad - left);
}

/** Render one group's table. Returns undefined if the group has no caps at all. */
export function formatCapGroupTable(
  group: CapGroup,
  capsFile: CapsFile,
  results: readonly CapsFetchResult[],
): string | undefined {
  const known = capsByNumber(capsFile, group);
  const rows: Array<{ label: string; number: number }> = capsInGroup(capsFile, group).map((cap) => ({
    label: cap.name,
    number: cap.number,
  }));
  for (const number of unknownCapNumbers(results, known, group)) {
    rows.push({ label: `#${number} (not in caps.json5)`, number });
  }
  // Most recently added first: enum numbers only ever grow, so a higher number is a
  // newer cap. Uncatalogued caps have the highest numbers, so they float to the top.
  rows.sort((a, b) => b.number - a.number);
  if (rows.length === 0) return undefined;

  const capColumnWidth = Math.max(10, ...rows.map((row) => row.label.length));
  const columnWidths = results.map((result) => Math.max(3, sdkColumnLabel(result.sdk).length));

  const lines: string[] = [paint(GROUP_TITLES[group], BOLD), ""];

  const header = [
    padVisible("Capability", capColumnWidth),
    ...results.map((result, i) => centreVisible(sdkColumnLabel(result.sdk), columnWidths[i])),
  ].join("  ");
  lines.push(header);
  lines.push(paint(["-".repeat(capColumnWidth), ...columnWidths.map((w) => "-".repeat(w))].join("  "), DIM));

  for (const row of rows) {
    const cells = results.map((result, i) => centreVisible(paintCell(capCell(result, group, row.number)), columnWidths[i]));
    lines.push([padVisible(row.label, capColumnWidth), ...cells].join("  "));
  }

  return lines.join("\n");
}

/** A per-SDK legend: what we actually talked to, and what went wrong where it did. */
export function formatSdkLegend(results: readonly CapsFetchResult[]): string {
  const lines: string[] = [paint("Performers", BOLD), ""];
  const labelWidth = Math.max(...results.map((r) => sdkColumnLabel(r.sdk).length));

  for (const result of results) {
    const label = padVisible(sdkColumnLabel(result.sdk), labelWidth);
    if (result.status === "ok") {
      const { userAgent, libraryVersion, transactionsProtocolVersion } = result.caps;
      const bits = [
        userAgent ? `user agent ${userAgent}` : undefined,
        libraryVersion ? `library ${libraryVersion}` : undefined,
        transactionsProtocolVersion ? `txn protocol ${transactionsProtocolVersion}` : undefined,
      ].filter(Boolean);
      lines.push(`  ${paint(TICK, GREEN)} ${label}  ${bits.join(", ")}`);
    } else if (result.status === "unimplemented") {
      lines.push(`  ${paint(UNKNOWN, DIM)} ${label}  ${paint("does not implement performerCapsFetch", DIM)}`);
    } else {
      lines.push(`  ${paint(CROSS, RED)} ${label}  ${paint(result.error, RED)}`);
    }
  }

  return lines.join("\n");
}

/** The whole report: a legend, then one table per cap group. */
export function formatCapsReport(capsFile: CapsFile, results: readonly CapsFetchResult[]): string {
  const sections = [formatSdkLegend(results)];
  for (const group of CAP_GROUPS) {
    const table = formatCapGroupTable(group, capsFile, results);
    if (table) sections.push(table);
  }
  sections.push(
    paint(`${TICK} supported   ${CROSS} not supported   ${UNKNOWN} no answer from this performer`, DIM),
  );
  return sections.join("\n\n");
}

/**
 * The same matrix as Markdown, written out as an artifact.
 *
 * This is where the Jira column lives: it's far too wide for the terminal grid, but
 * it's the main reason caps.json5 exists, so it belongs in the file you keep.
 */
export function formatCapsMarkdown(capsFile: CapsFile, results: readonly CapsFetchResult[]): string {
  const lines: string[] = ["# FIT capabilities by SDK", ""];

  lines.push("| SDK | Status | User agent | Library | Txn protocol |", "| --- | --- | --- | --- | --- |");
  for (const result of results) {
    if (result.status === "ok") {
      const c = result.caps;
      lines.push(
        `| ${result.sdk.name} | ok | ${c.userAgent ?? ""} | ${c.libraryVersion ?? ""} | ${c.transactionsProtocolVersion ?? ""} |`,
      );
    } else {
      const detail = result.status === "unimplemented" ? "does not implement performerCapsFetch" : result.error;
      lines.push(`| ${result.sdk.name} | ${result.status} | ${detail.replace(/\|/g, "\\|")} | | |`);
    }
  }
  lines.push("");

  for (const group of CAP_GROUPS) {
    const known = capsByNumber(capsFile, group);
    const rows: Array<{ label: string; number: number; jira: string; description: string }> = capsInGroup(
      capsFile,
      group,
    ).map((cap) => ({
      label: cap.name,
      number: cap.number,
      jira: cap.jira ?? "",
      description: cap.description ?? "",
    }));
    for (const number of unknownCapNumbers(results, known, group)) {
      rows.push({ label: `#${number}`, number, jira: "", description: "Not in caps.json5 — run 'fit caps sync'" });
    }
    // Most recently added first — see formatCapGroupTable.
    rows.sort((a, b) => b.number - a.number);
    if (rows.length === 0) continue;

    lines.push(`## ${GROUP_TITLES[group]}`, "");
    lines.push(`| Capability | # | Jira | ${results.map((r) => r.sdk.name).join(" | ")} | Description |`);
    lines.push(`| --- | --- | --- | ${results.map(() => "---").join(" | ")} | --- |`);
    for (const row of rows) {
      const cells = results.map((result) => capCell(result, group, row.number));
      lines.push(
        `| ${row.label} | ${row.number} | ${row.jira} | ${cells.join(" | ")} | ${row.description.replace(/\|/g, "\\|")} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
