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
}

export interface PackageStats {
  pkg: string;
  passed: number;
  failed: number;
  skipped: number;
  timeMs: number;
}

export interface JunitMarkdownData {
  packages: PackageStats[];
  failingCases: FailingTestCase[];
  totalPassed: number;
  totalFailed: number;
  totalSkipped: number;
  totalTimeMs: number;
}

function getAttr(attrs: string, name: string): string {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1] : "";
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
      const body = (cm[3] ?? "").trim();
      const message = getAttr(childAttrs, "message") || body.split("\n")[0]?.trim() || "";
      issues.push({ tag, message, body });
    }
    if (issues.length > 0) {
      const attrs = m[1];
      const classname = getAttr(attrs, "classname");
      const name = getAttr(attrs, "name");
      const timeMs = Math.round(parseFloat(getAttr(attrs, "time") || "0") * 1000);
      cases.push({ classname, name, timeMs, issues });
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
    const failed = failures + errors;
    const passed = Math.max(0, tests - failed - skipped);

    const dotIdx = suiteName.lastIndexOf(".");
    const pkg = dotIdx === -1 ? "(default)" : suiteName.substring(0, dotIdx);
    const existing = packageMap.get(pkg) ?? { passed: 0, failed: 0, skipped: 0, timeMs: 0 };
    packageMap.set(pkg, {
      passed: existing.passed + passed,
      failed: existing.failed + failed,
      skipped: existing.skipped + skipped,
      timeMs: existing.timeMs + timeMs,
    });

    failingCases.push(...parseFailingTestCases(xml));
  }

  // Packages with failures first, then alphabetical.
  const packages: PackageStats[] = [...packageMap.entries()]
    .sort(([pkgA, a], [pkgB, b]) => {
      if (a.failed > 0 && b.failed === 0) return -1;
      if (a.failed === 0 && b.failed > 0) return 1;
      return pkgA.localeCompare(pkgB);
    })
    .map(([pkg, s]) => ({ pkg, ...s }));

  let totalPassed = 0,
    totalFailed = 0,
    totalSkipped = 0,
    totalTimeMs = 0;
  for (const s of packages) {
    totalPassed += s.passed;
    totalFailed += s.failed;
    totalSkipped += s.skipped;
    totalTimeMs += s.timeMs;
  }

  return { packages, failingCases, totalPassed, totalFailed, totalSkipped, totalTimeMs };
}

function formatTime(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function truncate(s: string, max = 8 * 1024): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return s.substring(0, half) + "\n[...truncated...]\n" + s.substring(s.length - half);
}

function removePackage(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? name : name.substring(idx + 1);
}

/** Render a JunitMarkdownData object to a GFM markdown string (for $GITHUB_STEP_SUMMARY). */
export function renderJunitMarkdown(data: JunitMarkdownData): string {
  const { packages, failingCases, totalPassed, totalFailed, totalSkipped, totalTimeMs } = data;
  const lines: string[] = [];

  // Badge
  const badgeText = `tests-${totalPassed} ✅ | ${totalFailed} ❌ | ${totalSkipped} ⏭ | ${formatTime(totalTimeMs)} ⏱️-white`;
  const badgeUrl = `https://img.shields.io/badge/${encodeURIComponent(badgeText).replace(/\+/g, "%20")}`;
  const altText = `Test results: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped, time: ${formatTime(totalTimeMs)}`;
  lines.push(`![${altText}](${badgeUrl})`);
  lines.push("");

  // Per-package summary table
  lines.push("<details>");
  lines.push("<summary>Test results by package</summary>");
  lines.push("");
  lines.push("| Package | Passed | Failed | Skipped | Time |");
  lines.push("|:---|---:|---:|---:|---:|");
  for (const s of packages) {
    lines.push(
      `| ${s.pkg} | ${s.passed > 0 ? `${s.passed} ✅` : ""} | ${s.failed > 0 ? `${s.failed} ❌` : ""} | ${s.skipped > 0 ? `${s.skipped} ⏭️` : ""} | ${formatTime(s.timeMs)} ⏱️ |`,
    );
  }
  // Use explicit 0 for zero totals so the cell isn't bold-empty (**<empty>** = ****).
  const totalPassCell = totalPassed > 0 ? `${totalPassed} ✅` : "0";
  const totalFailCell = totalFailed > 0 ? `${totalFailed} ❌` : "0";
  const totalSkipCell = totalSkipped > 0 ? `${totalSkipped} ⏭️` : "0";
  lines.push(`| **TOTAL** | **${totalPassCell}** | **${totalFailCell}** | **${totalSkipCell}** | **${formatTime(totalTimeMs)} ⏱️** |`);
  lines.push("");
  lines.push("</details>");
  lines.push("");

  // Per-failure detail blocks
  for (const tc of failingCases) {
    const simpleClass = removePackage(tc.classname);
    lines.push(`#### ❌ ${simpleClass}.${tc.name}`);
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
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** Render a JunitMarkdownData object as a plain-text table for terminal output. */
export function renderJunitPlainText(data: JunitMarkdownData): string {
  const { packages, failingCases, totalPassed, totalFailed, totalSkipped, totalTimeMs } = data;
  const lines: string[] = [];

  const pkgHeader = "Package";
  const passHeader = "Pass";
  const skipHeader = "Skip";
  const failHeader = "Fail";
  const timeHeader = "Time";

  const pkgWidth = Math.max(pkgHeader.length, ...packages.map((s) => s.pkg.length), 5);
  const passWidth = Math.max(passHeader.length, String(totalPassed).length);
  const skipWidth = Math.max(skipHeader.length, String(totalSkipped).length);
  const failWidth = Math.max(failHeader.length, String(totalFailed).length);
  const timeWidth = Math.max(timeHeader.length, formatTime(totalTimeMs).length);

  const sep = `${"-".repeat(pkgWidth)}-+-${"-".repeat(passWidth)}-+-${"-".repeat(skipWidth)}-+-${"-".repeat(failWidth)}-+-${"-".repeat(timeWidth)}`;

  const row = (pkg: string, pass: string, skip: string, fail: string, time: string, highlight = false): string => {
    const failStr = highlight && fail !== "0" ? `${RED}${fail.padStart(failWidth)}${RESET}` : fail.padStart(failWidth);
    return `${pkg.padEnd(pkgWidth)} | ${pass.padStart(passWidth)} | ${skip.padStart(skipWidth)} | ${failStr} | ${time.padStart(timeWidth)}`;
  };

  lines.push(row(pkgHeader, passHeader, skipHeader, failHeader, timeHeader));
  lines.push(sep);
  for (const s of packages) {
    lines.push(row(s.pkg, String(s.passed), String(s.skipped), String(s.failed), formatTime(s.timeMs), true));
  }
  lines.push(sep);
  lines.push(row("TOTAL", String(totalPassed), String(totalSkipped), String(totalFailed), formatTime(totalTimeMs), true));

  if (failingCases.length > 0) {
    lines.push("");
    lines.push("Failures:");
    for (const tc of failingCases) {
      const simpleClass = removePackage(tc.classname);
      lines.push(`  ${RED}${simpleClass}.${tc.name}${RESET}`);
      for (const issue of tc.issues) {
        if (issue.message) {
          lines.push(`    ${issue.message}`);
        }
        if (issue.body) {
          for (const line of truncate(issue.body).split("\n").slice(0, 10)) {
            lines.push(`      ${line}`);
          }
        }
      }
    }
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
