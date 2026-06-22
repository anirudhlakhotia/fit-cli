/**
 * junit-summary — print a per-suite breakdown of JUnit surefire results.
 *
 * Accepts a surefire-reports directory or a surefire-reports.tar.gz archive.
 * Prints each test suite sorted by duration (slowest first) with pass/skip/fail counts.
 *
 * Usage:
 *   bun src/fit/shared/run-test-driver/junit-summary.ts <surefire-reports-dir-or-archive>
 *   bun src/fit/shared/run-test-driver/junit-summary.ts /tmp/fit-cli/20260616-143259/instances/0/clusters/0/sessions/0/runs/0/surefire-reports.tar.gz
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { run } from "../../../util/non-fit/proc.js";
import { formatDuration } from "./run-test-driver.js";

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export interface SuiteStats {
  name: string;
  durationMs: number;
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
}

function red(text: string): string {
  return `${RED}${text}${RESET}`;
}

/** Parse a single TEST-*.xml file into suite stats. Returns undefined if unparseable. */
export function parseSuiteStats(filename: string, xml: string): SuiteStats | undefined {
  const suiteMatch = xml.match(/<testsuite\b([^>]*)>/);
  if (!suiteMatch) return undefined;
  const attrs = suiteMatch[1];
  const getAttr = (name: string): string | undefined => {
    const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
    return m ? m[1] : undefined;
  };
  const name = getAttr("name") ?? filename.replace(/^TEST-/, "").replace(/\.xml$/, "");
  const timeStr = getAttr("time") ?? "0";
  const durationMs = Math.round(parseFloat(timeStr) * 1000);
  const tests = parseInt(getAttr("tests") ?? "0", 10);
  const failures = parseInt(getAttr("failures") ?? "0", 10);
  const errors = parseInt(getAttr("errors") ?? "0", 10);
  const skipped = parseInt(getAttr("skipped") ?? "0", 10);
  if (isNaN(tests)) return undefined;
  return { name, durationMs, tests, failures, errors, skipped };
}

/** Parse all TEST-*.xml files in a directory into suite stats, sorted by duration desc. */
export function parseSuiteStatsFromDir(dir: string): SuiteStats[] {
  const files = readdirSync(dir).filter((f) => f.startsWith("TEST-") && f.endsWith(".xml"));
  const stats: SuiteStats[] = [];
  for (const file of files) {
    const xml = readFileSync(join(dir, file), "utf8");
    const suite = parseSuiteStats(file, xml);
    if (suite) stats.push(suite);
  }
  return stats.sort((a, b) => b.durationMs - a.durationMs);
}

/** Format and print the per-suite stats table to stdout. */
export function printSuiteStatsTable(suites: SuiteStats[]): void {
  if (suites.length === 0) {
    console.log("No JUnit suites found.");
    return;
  }

  const totals = suites.reduce(
    (acc, s) => ({
      durationMs: acc.durationMs + s.durationMs,
      tests: acc.tests + s.tests,
      failures: acc.failures + s.failures,
      errors: acc.errors + s.errors,
      skipped: acc.skipped + s.skipped,
    }),
    { durationMs: 0, tests: 0, failures: 0, errors: 0, skipped: 0 },
  );

  const nameHeader = "Test Suite";
  const durHeader = "Duration";
  const passHeader = "Pass";
  const skipHeader = "Skip";
  const failHeader = "Fail";

  const nameWidth = Math.max(nameHeader.length, ...suites.map((s) => s.name.length), 5);
  const durWidth = Math.max(durHeader.length, ...suites.map((s) => formatDuration(s.durationMs).length), formatDuration(totals.durationMs).length);
  const passWidth = Math.max(passHeader.length, ...suites.map((s) => String(s.tests - s.failures - s.errors).length), String(totals.tests - totals.failures - totals.errors).length);
  const skipWidth = Math.max(skipHeader.length, ...suites.map((s) => String(s.skipped).length), String(totals.skipped).length);
  const failWidth = Math.max(failHeader.length, ...suites.map((s) => String(s.failures + s.errors).length), String(totals.failures + totals.errors).length);

  const sep = `${"-".repeat(nameWidth)}-+-${"-".repeat(durWidth)}-+-${"-".repeat(passWidth)}-+-${"-".repeat(skipWidth)}-+-${"-".repeat(failWidth)}`;

  const row = (name: string, dur: string, pass: string, skip: string, fail: string, failRed = false): string => {
    const failStr = failRed && fail !== "0" ? red(fail.padStart(failWidth)) : fail.padStart(failWidth);
    return `${name.padEnd(nameWidth)} | ${dur.padStart(durWidth)} | ${pass.padStart(passWidth)} | ${skip.padStart(skipWidth)} | ${failStr}`;
  };

  console.log(row(nameHeader, durHeader, passHeader, skipHeader, failHeader));
  console.log(sep);
  for (const s of suites) {
    const pass = String(Math.max(0, s.tests - s.failures - s.errors));
    const fail = String(s.failures + s.errors);
    console.log(row(s.name, formatDuration(s.durationMs), pass, String(s.skipped), fail, true));
  }
  console.log(sep);
  const totalPass = String(Math.max(0, totals.tests - totals.failures - totals.errors));
  const totalFail = String(totals.failures + totals.errors);
  console.log(row("TOTAL", formatDuration(totals.durationMs), totalPass, String(totals.skipped), totalFail, true));
}

function findXmlDir(dir: string): string {
  // The archive may contain files at root (remote format) or under surefire-reports/ (local format).
  if (readdirSync(dir).some((f) => f.startsWith("TEST-") && f.endsWith(".xml"))) {
    return dir;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const sub = join(dir, entry.name);
      if (readdirSync(sub).some((f) => f.startsWith("TEST-") && f.endsWith(".xml"))) {
        return sub;
      }
    }
  }
  return dir;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  if (args.length !== 1 || args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: bun src/fit/shared/run-test-driver/junit-summary.ts <surefire-reports-dir-or-archive.tar.gz>");
    process.exit(args.length === 1 ? 0 : 2);
  }

  const input = args[0];
  if (!existsSync(input)) {
    console.error(`Not found: ${input}`);
    process.exit(1);
  }

  const isArchive = extname(input) === ".gz";
  if (isArchive) {
    const tmpDir = mkdtempSync(join(tmpdir(), "fit-junit-summary-"));
    try {
      await run("tar", ["-xzf", input, "-C", tmpDir]);
      printSuiteStatsTable(parseSuiteStatsFromDir(findXmlDir(tmpDir)));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  } else {
    printSuiteStatsTable(parseSuiteStatsFromDir(input));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
