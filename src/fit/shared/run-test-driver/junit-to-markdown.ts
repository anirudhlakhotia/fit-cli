/**
 * Generate GitHub-flavoured Markdown from JUnit surefire XML reports.
 * Produces a badge summary, a per-package results table, and detail blocks
 * for each failed test. Skipped tests are counted but not annotated.
 *
 * Usage:
 *   bun src/fit/shared/run-test-driver/junit-to-markdown.ts <surefire-reports-dir-or-archive.tar.gz>
 *   bun src/fit/shared/run-test-driver/junit-to-markdown.ts /tmp/fit-cli/20260622-122009
 *   bun src/fit/shared/run-test-driver/junit-to-markdown.ts /tmp/fit-cli/20260622-122009/instances/0/clusters/0/sessions/0/runs/0/surefire-reports.tar.gz
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { isMain } from "../../../util/non-fit/cli.js";
import { run } from "../../../util/non-fit/proc.js";

interface TestIssue {
  tag: "failure" | "error";
  message: string;
  body: string;
}

export interface FailingTestCase {
  classname: string;
  name: string;
  timeMs: number;
  issues: TestIssue[];
  stdout?: string;
  stderr?: string;
}

export interface PackageStats {
  pkg: string;
  passed: number;
  failures: number;
  errors: number;
  skipped: number;
  timeMs: number;
}

export interface JunitMarkdownData {
  packages: PackageStats[];
  failingCases: FailingTestCase[];
  totalPassed: number;
  totalFailures: number;
  totalErrors: number;
  totalSkipped: number;
  totalTimeMs: number;
}

function getAttr(attrs: string, name: string): string {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? decodeXmlEntities(m[1]) : "";
}

/** Decode the five predefined XML entities and numeric character references (e.g. &#10;). */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Strip CDATA section wrappers, returning the unwrapped content. */
function unwrapCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

/** Extract the (single) `<tag>...</tag>` content from a `<testcase>` body, e.g. `system-out`/`system-err`. */
function extractTagContent(inner: string, tag: string): string | undefined {
  const m = inner.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`));
  if (!m) return undefined;
  const content = unwrapCdata(m[1]).trim();
  return content.length > 0 ? content : undefined;
}

/** Parse failing/erroring <testcase> elements from a single TEST-*.xml file. */
export function parseFailingTestCases(xml: string): FailingTestCase[] {
  const cases: FailingTestCase[] = [];
  const re = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const inner = m[2] ?? "";
    // Only collect cases that have <failure> or <error> children — skip <skipped>.
    const childRe = /<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>|<(failure|error)\b([^>]*)\/>/g;
    let cm: RegExpExecArray | null;
    const issues: TestIssue[] = [];
    while ((cm = childRe.exec(inner)) !== null) {
      const tag = (cm[1] ?? cm[4]) as "failure" | "error";
      const childAttrs = cm[2] ?? cm[5] ?? "";
      const body = unwrapCdata((cm[3] ?? "").trim()).trim();
      const message = getAttr(childAttrs, "message") || body.split("\n")[0]?.trim() || "";
      issues.push({ tag, message, body });
    }
    if (issues.length > 0) {
      const attrs = m[1];
      const classname = getAttr(attrs, "classname");
      const name = getAttr(attrs, "name");
      const timeMs = Math.round(parseFloat(getAttr(attrs, "time") || "0") * 1000);
      const stdout = extractTagContent(inner, "system-out");
      const stderr = extractTagContent(inner, "system-err");
      cases.push({ classname, name, timeMs, issues, stdout, stderr });
    }
  }
  return cases;
}

/** Parse suite-level stats and failing test cases from an array of {filename, xml} pairs. */
export function parseJunitData(files: ReadonlyArray<{ filename: string; xml: string }>): JunitMarkdownData {
  const packageMap = new Map<string, Omit<PackageStats, "pkg">>();
  const failingCases: FailingTestCase[] = [];

  for (const { filename, xml } of files) {
    const suiteMatch = xml.match(/<testsuite\b([^>]*)>/);
    if (!suiteMatch) continue;
    const attrs = suiteMatch[1];
    const suiteName = getAttr(attrs, "name") || filename.replace(/^TEST-/, "").replace(/\.xml$/, "");
    const timeMs = Math.round(parseFloat(getAttr(attrs, "time") || "0") * 1000);
    const tests = parseInt(getAttr(attrs, "tests") || "0", 10);
    const failures = parseInt(getAttr(attrs, "failures") || "0", 10);
    const errors = parseInt(getAttr(attrs, "errors") || "0", 10);
    const skipped = parseInt(getAttr(attrs, "skipped") || "0", 10);
    const passed = Math.max(0, tests - failures - errors - skipped);

    const dotIdx = suiteName.lastIndexOf(".");
    const pkg = dotIdx === -1 ? "(default)" : suiteName.substring(0, dotIdx);
    const existing = packageMap.get(pkg) ?? { passed: 0, failures: 0, errors: 0, skipped: 0, timeMs: 0 };
    packageMap.set(pkg, {
      passed: existing.passed + passed,
      failures: existing.failures + failures,
      errors: existing.errors + errors,
      skipped: existing.skipped + skipped,
      timeMs: existing.timeMs + timeMs,
    });

    failingCases.push(...parseFailingTestCases(xml));
  }

  // Packages with failures/errors first, then alphabetical.
  const packages: PackageStats[] = [...packageMap.entries()]
    .sort(([pkgA, a], [pkgB, b]) => {
      const aFailed = a.failures + a.errors;
      const bFailed = b.failures + b.errors;
      if (aFailed > 0 && bFailed === 0) return -1;
      if (aFailed === 0 && bFailed > 0) return 1;
      return pkgA.localeCompare(pkgB);
    })
    .map(([pkg, s]) => ({ pkg, ...s }));

  let totalPassed = 0,
    totalFailures = 0,
    totalErrors = 0,
    totalSkipped = 0,
    totalTimeMs = 0;
  for (const s of packages) {
    totalPassed += s.passed;
    totalFailures += s.failures;
    totalErrors += s.errors;
    totalSkipped += s.skipped;
    totalTimeMs += s.timeMs;
  }

  return { packages, failingCases, totalPassed, totalFailures, totalErrors, totalSkipped, totalTimeMs };
}

function pctSuccess(passed: number, failed: number): string {
  const total = passed + failed;
  if (total === 0) return "-";
  return ((passed / total) * 100).toFixed(2) + "%";
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function truncate(s: string, max = 16 * 1024): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  const omitted = s.substring(half, s.length - half);
  const omittedLines = omitted.split("\n").length - 1;
  const marker = `\n[...truncated by fit-cli to avoid Github length limits — ~${omittedLines} lines hidden; full output is in this run's ARTIFACT_DIR, fetchable via \`fit archive fetch ...\`...]\n`;
  return s.substring(0, half) + marker + s.substring(s.length - half);
}

/** Keep only the last `maxLines` lines of `s` — the failure context is usually near the end of a test's output. */
function tailLines(s: string, maxLines: number): { text: string; omittedCount: number } {
  const lines = s.split("\n");
  if (lines.length <= maxLines) return { text: s, omittedCount: 0 };
  return { text: lines.slice(-maxLines).join("\n"), omittedCount: lines.length - maxLines };
}

function removePackage(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? name : name.substring(idx + 1);
}

/** Render a JunitMarkdownData object to a GFM markdown string (for $GITHUB_STEP_SUMMARY). */
export function renderJunitMarkdown(data: JunitMarkdownData): string {
  const { packages, failingCases, totalPassed, totalFailures, totalErrors, totalSkipped, totalTimeMs } = data;
  const totalFailed = totalFailures + totalErrors;
  const lines: string[] = [];

  // Badge
  const badgeText = `tests-${totalPassed} ✅ | ${totalFailures} ❌ | ${totalErrors} 💥 | ${totalSkipped} ⏭ | ${formatTime(totalTimeMs)} ⏱️-white`;
  const badgeUrl = `https://img.shields.io/badge/${encodeURIComponent(badgeText).replace(/\+/g, "%20")}`;
  const altText = `Test results: ${totalPassed} passed, ${totalFailures} test failures, ${totalErrors} infra errors, ${totalSkipped} skipped, time: ${formatTime(totalTimeMs)}`;
  lines.push(`![${altText}](${badgeUrl})`);
  lines.push("");

  // Per-package summary table
  lines.push("<details>");
  lines.push("<summary>Test results by package</summary>");
  lines.push("");
  lines.push("| Package | Pass | Test Fail | Infra | Skip | % Success | Time |");
  lines.push("|:---|---:|---:|---:|---:|---:|---:|");
  for (const s of packages) {
    const failed = s.failures + s.errors;
    lines.push(
      `| ${s.pkg} | ${s.passed > 0 ? `${s.passed} ✅` : ""} | ${s.failures > 0 ? `${s.failures} ❌` : ""} | ${s.errors > 0 ? `${s.errors} 💥` : ""} | ${s.skipped > 0 ? `${s.skipped} ⏭️` : ""} | ${pctSuccess(s.passed, failed)} | ${formatTime(s.timeMs)} ⏱️ |`,
    );
  }
  // Use explicit 0 for zero totals so the cell isn't bold-empty (**<empty>** = ****).
  const totalPassCell = totalPassed > 0 ? `${totalPassed} ✅` : "0";
  const totalFailureCell = totalFailures > 0 ? `${totalFailures} ❌` : "0";
  const totalErrorCell = totalErrors > 0 ? `${totalErrors} 💥` : "0";
  const totalSkipCell = totalSkipped > 0 ? `${totalSkipped} ⏭️` : "0";
  lines.push(
    `| **TOTAL** | **${totalPassCell}** | **${totalFailureCell}** | **${totalErrorCell}** | **${totalSkipCell}** | **${pctSuccess(totalPassed, totalFailed)}** | **${formatTime(totalTimeMs)} ⏱️** |`,
  );
  lines.push("");
  lines.push("</details>");
  lines.push("");

  // Per-failure detail blocks
  for (const tc of failingCases) {
    const simpleClass = removePackage(tc.classname);
    const icon = tc.issues.some((issue) => issue.tag === "error") ? "💥" : "❌";
    lines.push(`#### ${icon} ${simpleClass}.${tc.name}`);
    lines.push("");
    for (const issue of tc.issues) {
      if (issue.message) {
        lines.push("```");
        lines.push(issue.message);
        lines.push("```");
        lines.push("");
      }
      if (tc.timeMs > 0) {
        lines.push(`${formatTime(tc.timeMs)} ⏱️`);
        lines.push("");
      }
      if (issue.body) {
        lines.push("<details>");
        lines.push("<summary>Stack trace</summary>");
        lines.push("");
        lines.push("```");
        lines.push(truncate(issue.body));
        lines.push("```");
        lines.push("");
        lines.push("</details>");
        lines.push("");
      }
    }
    for (const [label, output] of [
      ["stdout", tc.stdout],
      ["stderr", tc.stderr],
    ] as const) {
      if (!output) continue;
      lines.push("<details>");
      lines.push(`<summary>Test output (${label})</summary>`);
      lines.push("");
      lines.push("```");
      lines.push(truncate(output));
      lines.push("```");
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** Render a JunitMarkdownData object as a plain-text table for terminal output. */
export function renderJunitPlainText(data: JunitMarkdownData, maxFailuresPerPackage = 3, maxOutputLines = 20): string {
  const { packages, failingCases, totalPassed, totalFailures, totalErrors, totalSkipped, totalTimeMs } = data;
  const totalFailed = totalFailures + totalErrors;
  const lines: string[] = [];

  const pkgHeader = "Package";
  const passHeader = "Pass";
  const skipHeader = "Skip";
  const failureHeader = "Test Fail";
  const errorHeader = "Infra";
  const pctHeader = "% Succ";
  const timeHeader = "Time";

  const pkgWidth = Math.max(pkgHeader.length, ...packages.map((s) => s.pkg.length), 5);
  const passWidth = Math.max(passHeader.length, String(totalPassed).length);
  const skipWidth = Math.max(skipHeader.length, String(totalSkipped).length);
  const failureWidth = Math.max(failureHeader.length, String(totalFailures).length);
  const errorWidth = Math.max(errorHeader.length, String(totalErrors).length);
  const pctWidth = Math.max(pctHeader.length, "100.00%".length);
  const timeWidth = Math.max(timeHeader.length, "H:MM:SS".length, formatTime(totalTimeMs).length);

  const sep = `${"-".repeat(pkgWidth)}-+-${"-".repeat(passWidth)}-+-${"-".repeat(skipWidth)}-+-${"-".repeat(failureWidth)}-+-${"-".repeat(errorWidth)}-+-${"-".repeat(pctWidth)}-+-${"-".repeat(timeWidth)}`;

  const row = (pkg: string, pass: string, skip: string, failure: string, error: string, pct: string, time: string, highlight = false): string => {
    const failureStr = highlight && failure !== "0" ? `${RED}${failure.padStart(failureWidth)}${RESET}` : failure.padStart(failureWidth);
    const errorStr = highlight && error !== "0" ? `${RED}${error.padStart(errorWidth)}${RESET}` : error.padStart(errorWidth);
    return `${pkg.padEnd(pkgWidth)} | ${pass.padStart(passWidth)} | ${skip.padStart(skipWidth)} | ${failureStr} | ${errorStr} | ${pct.padStart(pctWidth)} | ${time.padStart(timeWidth)}`;
  };

  const renderTable = (): void => {
    lines.push(row(pkgHeader, passHeader, skipHeader, failureHeader, errorHeader, pctHeader, timeHeader));
    lines.push(sep);
    for (const s of packages) {
      lines.push(
        row(s.pkg, String(s.passed), String(s.skipped), String(s.failures), String(s.errors), pctSuccess(s.passed, s.failures + s.errors), formatTime(s.timeMs), true),
      );
    }
    lines.push(sep);
    lines.push(row("TOTAL", String(totalPassed), String(totalSkipped), String(totalFailures), String(totalErrors), pctSuccess(totalPassed, totalFailed), formatTime(totalTimeMs), true));
  };

  renderTable();

  if (failingCases.length > 0) {
    lines.push("");
    lines.push("Failures:");

    // Group by package so we can cap output per package.
    const byPackage = new Map<string, FailingTestCase[]>();
    for (const tc of failingCases) {
      const dotIdx = tc.classname.lastIndexOf(".");
      const pkg = dotIdx === -1 ? "(default)" : tc.classname.substring(0, dotIdx);
      const arr = byPackage.get(pkg) ?? [];
      arr.push(tc);
      byPackage.set(pkg, arr);
    }

    for (const [pkg, cases] of byPackage) {
      const shown = cases.slice(0, maxFailuresPerPackage);
      const hidden = cases.length - shown.length;
      for (const tc of shown) {
        const simpleClass = removePackage(tc.classname);
        const icon = tc.issues.some((issue) => issue.tag === "error") ? "💥" : "❌";
        lines.push(`  ${RED}${icon} ${simpleClass}.${tc.name}${RESET}`);
        for (const issue of tc.issues) {
          if (issue.message) {
            lines.push(`    ${issue.message}`);
          }
          if (issue.body) {
            // 10 sometimes isn't quite enough to reach the relevant frame.
            for (const line of truncate(issue.body).split("\n").slice(0, 13)) {
              lines.push(`      ${line}`);
            }
          }
        }
        for (const [label, output] of [
          ["stdout", tc.stdout],
          ["stderr", tc.stderr],
        ] as const) {
          if (!output) continue;
          const { text, omittedCount } = tailLines(output, maxOutputLines);
          lines.push(`    Test output (${label})${omittedCount > 0 ? ` [${omittedCount} earlier line(s) omitted]` : ""}:`);
          for (const line of text.split("\n")) {
            lines.push(`      ${line}`);
          }
        }
      }
      if (hidden > 0) {
        lines.push(`  ${RED}... and ${hidden} more failure(s) in ${pkg}${RESET}`);
      }
    }

    // Repeat the summary table so it's visible without scrolling past a wall of failures.
    lines.push("");
    renderTable();
  }

  return lines.join("\n") + "\n";
}

/** Recursively collect all TEST-*.xml files under `dir`. */
function findXmlFiles(dir: string): Array<{ filename: string; xml: string }> {
  const results: Array<{ filename: string; xml: string }> = [];
  function walk(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(current, entry.name));
      } else if (entry.name.startsWith("TEST-") && entry.name.endsWith(".xml")) {
        results.push({ filename: entry.name, xml: readFileSync(join(current, entry.name), "utf8") });
      }
    }
  }
  walk(dir);
  return results;
}

/** Parse all TEST-*.xml files recursively under `dir`. Returns undefined if none found. */
export function parseJunitDataFromDir(dir: string): JunitMarkdownData | undefined {
  const files = findXmlFiles(dir);
  return files.length === 0 ? undefined : parseJunitData(files);
}

/**
 * Read all TEST-*.xml files recursively under `dir` and return a GFM
 * markdown string suitable for appending to $GITHUB_STEP_SUMMARY.
 */
export function junitToMarkdownFromDir(dir: string): string {
  const data = parseJunitDataFromDir(dir);
  return data ? renderJunitMarkdown(data) : "_No JUnit reports found._\n";
}

/**
 * Read all TEST-*.xml files recursively under `dir` and return a plain-text
 * table suitable for printing to the terminal.
 */
export function junitToPlainTextFromDir(dir: string): string {
  const data = parseJunitDataFromDir(dir);
  return data ? renderJunitPlainText(data) : "No JUnit reports found.\n";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  if (args.length !== 1 || args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: bun src/fit/shared/run-test-driver/junit-to-markdown.ts <surefire-reports-dir-or-archive.tar.gz>");
    process.exit(args.length === 1 ? 0 : 2);
  }

  const input = args[0];
  if (!existsSync(input)) {
    console.error(`Not found: ${input}`);
    process.exit(1);
  }

  if (extname(input) === ".gz") {
    const tmpDir = mkdtempSync(join(tmpdir(), "fit-junit-markdown-"));
    try {
      await run("tar", ["-xzf", input, "-C", tmpDir]);
      process.stdout.write(junitToPlainTextFromDir(tmpDir));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  } else {
    process.stdout.write(junitToPlainTextFromDir(input));
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
