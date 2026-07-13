/**
 * Parse and render the situational test-results CSV the FIT test-driver writes
 * (transactions-fit-performer's RunnerUtils.writeCsvRow): one row per situational
 * scenario — timestamp, test case name, Passed/Failed status, and a link to the
 * detailed results viewer. Mirrors fit-app-deployment's scripts/generate_sit_table.sh,
 * which builds the same table for its GHA step summary.
 *
 * Usage:
 *   bun src/fit/shared/run-test-driver/situational-results.ts <test_results.csv>
 */
import { existsSync, readFileSync } from "node:fs";
import { isMain } from "../../../util/non-fit/cli.js";

export interface SituationalResultRow {
  timestamp: string;
  testCase: string;
  status: string;
  url: string;
}

/** Parse test_results.csv rows: timestamp,testCase,status,url (no header, one row per scenario). */
export function parseSituationalResultsCsv(csv: string): SituationalResultRow[] {
  const rows: SituationalResultRow[] = [];
  for (const line of csv.split("\n")) {
    if (line.trim() === "") continue;
    const [timestamp, testCase, status, url] = line.split(",");
    if (!timestamp) continue;
    rows.push({ timestamp, testCase: testCase ?? "", status: status ?? "", url: url ?? "" });
  }
  return rows;
}

/** "2026-06-15T11:49:04.123+01:00" -> "2026-06-15 11:49:04", matching generate_sit_table.sh. */
function cleanTimestamp(ts: string): string {
  return ts.split(".")[0].replace("T", " ");
}

function statusEmoji(status: string): string {
  if (status === "Passed") return "✅ Passed";
  if (status === "Failed") return "❌ Failed";
  return `⚠️ ${status}`;
}

/** Render a GFM markdown table (for $GITHUB_STEP_SUMMARY), matching generate_sit_table.sh's format. */
export function renderSituationalResultsMarkdown(rows: readonly SituationalResultRow[]): string {
  const lines: string[] = [];
  lines.push("### 📊 Situational Test Results");
  lines.push("");
  lines.push("| Timestamp | Test Case | Status | Detailed Report |");
  lines.push("| --- | --- | --- | --- |");
  for (const row of rows) {
    lines.push(`| ${cleanTimestamp(row.timestamp)} | ${row.testCase} | ${statusEmoji(row.status)} | [View Detailed Results](${row.url}) |`);
  }
  return lines.join("\n") + "\n";
}

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** Render a plain-text table for terminal output. */
export function renderSituationalResultsPlainText(rows: readonly SituationalResultRow[]): string {
  if (rows.length === 0) {
    return "No situational test results found.\n";
  }

  const tsHeader = "Timestamp";
  const caseHeader = "Test Case";
  const statusHeader = "Status";
  const urlHeader = "Detailed Report";

  const tsWidth = Math.max(tsHeader.length, ...rows.map((r) => cleanTimestamp(r.timestamp).length));
  const caseWidth = Math.max(caseHeader.length, ...rows.map((r) => r.testCase.length));
  const statusWidth = Math.max(statusHeader.length, ...rows.map((r) => r.status.length));

  const sep = `${"-".repeat(tsWidth)}-+-${"-".repeat(caseWidth)}-+-${"-".repeat(statusWidth)}-+-${"-".repeat(urlHeader.length)}`;

  const row = (ts: string, testCase: string, status: string, url: string, failed = false): string => {
    const statusStr = failed ? `${RED}${status.padEnd(statusWidth)}${RESET}` : status.padEnd(statusWidth);
    return `${ts.padEnd(tsWidth)} | ${testCase.padEnd(caseWidth)} | ${statusStr} | ${url}`;
  };

  const lines: string[] = [row(tsHeader, caseHeader, statusHeader, urlHeader), sep];
  for (const r of rows) {
    lines.push(row(cleanTimestamp(r.timestamp), r.testCase, r.status, r.url, r.status !== "Passed"));
  }
  return lines.join("\n") + "\n";
}

/** Read and parse test_results.csv at `path`. Returns undefined if the file doesn't exist. */
export function readSituationalResultsCsv(path: string): SituationalResultRow[] | undefined {
  if (!existsSync(path)) return undefined;
  return parseSituationalResultsCsv(readFileSync(path, "utf8"));
}

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  if (args.length !== 1 || args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: bun src/fit/shared/run-test-driver/situational-results.ts <test_results.csv>");
    process.exit(args.length === 1 ? 0 : 2);
  }

  const rows = readSituationalResultsCsv(args[0]);
  if (!rows) {
    console.error(`Not found: ${args[0]}`);
    process.exit(1);
  }
  process.stdout.write(renderSituationalResultsPlainText(rows));
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
