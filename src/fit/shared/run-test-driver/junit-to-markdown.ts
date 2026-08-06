/**
 * Generate GitHub-flavoured Markdown from JUnit surefire XML reports.
 * Produces a badge summary, a per-package results table, and detail blocks
 * for each failed test. Skipped tests are counted but not annotated.
 *
 * Usage:
 *   bun src/fit/shared/run-test-driver/junit-to-markdown.ts <surefire-reports-dir-or-archive.tar.gz>
 *   bun src/fit/shared/run-test-driver/junit-to-markdown.ts /tmp/fit-cli/20260622-122009
 *   bun src/fit/shared/run-test-driver/junit-to-markdown.ts /tmp/fit-cli/20260622-122009/instances/0/clusters/0/sessions/0/runs/0/surefire-reports.tar.gz
 *
 * Add --markdown to see what a GitHub Actions step summary will contain (--lean for the
 * reduced form, --bytes for just the size). See --help.
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

function elisionMarker(omittedLines: number): string {
  return `\n[...truncated by fit-cli to avoid Github length limits — ~${omittedLines} lines hidden; full output is in this run's ARTIFACT_DIR, fetchable via \`fit archive fetch ...\`...]\n`;
}

/**
 * Keep the head and tail of `s`, replacing the middle with a marker saying how much was
 * hidden and where to find it in full. `max` bounds the returned length *including* the
 * marker: at the historical 16k window the marker was rounding error, but the window is
 * now derived from the step-summary budget and can be small enough that ~160 bytes of
 * marker matters.
 */
function truncate(s: string, max = 16 * 1024): string {
  if (s.length <= max) return s;
  // Two passes: the marker's length depends on the hidden line count, which depends on
  // where we cut. One refinement is enough to settle it.
  let half = Math.max(0, Math.floor((max - elisionMarker(0).length) / 2));
  for (let pass = 0; pass < 2; pass++) {
    const omittedLines = s.substring(half, s.length - half).split("\n").length - 1;
    half = Math.max(0, Math.floor((max - elisionMarker(omittedLines).length) / 2));
  }
  if (half === 0) {
    // No room for any content alongside the marker — say what was dropped and nothing else.
    return elisionMarker(s.split("\n").length - 1).trim();
  }
  const omittedLines = s.substring(half, s.length - half).split("\n").length - 1;
  return s.substring(0, half) + elisionMarker(omittedLines) + s.substring(s.length - half);
}

/**
 * Third-party frames that appear in every FIT stack trace and carry no signal about
 * the failure. The test driver is always the Java/Maven suite in transactions-fit-performer
 * regardless of which SDK is under test, so this list is fixed rather than per-language.
 */
const FRAMEWORK_FRAME = /^\s*at\s+(org\.awaitility|okhttp3|okio|java\.base|jdk\.internal|sun\.|org\.junit|org\.opentest4j|io\.grpc|reactor\.|com\.google\.common|org\.apache\.maven|org\.testng|kotlin\.|kotlinx\.)/;

/**
 * Drop framework frames from a stack trace, keeping every non-frame line (the exception
 * header, `Caused by:`, `... N more`) and every frame that isn't third-party plumbing.
 * Runs of dropped frames are replaced by a marker so nothing disappears silently.
 *
 * On a real FIT run this cuts stack bodies by roughly 6x — a typical trace has two
 * `com.couchbase.*` frames and fourteen frames of awaitility/okhttp/JDK internals.
 * If a trace is *entirely* framework frames the original is returned unchanged, since
 * a marker on its own would tell the reader nothing.
 */
export function condenseStackTrace(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let elided = 0;
  let keptFrames = 0;
  const flush = (): void => {
    if (elided > 0) {
      out.push(`\t... ${elided} framework frame${elided === 1 ? "" : "s"} elided by fit-cli ...`);
      elided = 0;
    }
  };
  for (const line of lines) {
    if (FRAMEWORK_FRAME.test(line)) {
      elided++;
      continue;
    }
    flush();
    if (/^\s*at\s+/.test(line)) keptFrames++;
    out.push(line);
  }
  flush();
  return keptFrames === 0 ? body : out.join("\n");
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

/**
 * Historical per-stream elision window. Retained as the default so a run with few
 * failures renders exactly as it always has.
 *
 * It bounds each stream of each failure but never their sum, which is how a 1437k
 * summary got built out of individually-elided pieces and was discarded whole: at 16k
 * per stream a failure can cost 32k, so the format only ever afforded ~32 maximally
 * verbose failures. One nightly .NET run had 136.
 */
export const DEFAULT_OUTPUT_WINDOW_BYTES = 16 * 1024;

/**
 * Smallest per-stream window still worth rendering. Below this the elision marker
 * crowds out the output it is describing, so the budget is better spent showing fewer
 * failures properly than all of them uselessly.
 */
export const MIN_OUTPUT_WINDOW_BYTES = 512;

/**
 * Markdown scaffolding around one failure's content — heading, code fences, `<details>`
 * wrappers, separator. Measured from a rendered failure rather than estimated; only used
 * to size the output window, and the byte-accurate check in gha.ts is the real bound.
 */
const PER_FAILURE_SCAFFOLD_BYTES = 220;

export interface JunitMarkdownOptions {
  /**
   * Include the per-failure detail blocks. Set false for the badge and package table
   * only — the lean form the step-summary budget falls back to (see gha.ts).
   */
  includeFailureDetail?: boolean;
  /**
   * Bytes this run's markdown may occupy. Sizes the per-failure stdout/stderr window so
   * the total fits, rather than bounding each stream by a constant unrelated to the
   * budget. Omit to keep the historical fixed window.
   */
  budgetBytes?: number;
}

/** How much of `budgetBytes` a single failure's stdout/stderr may use, and how many failures to detail. */
export function planFailureDetail(args: {
  failureCount: number;
  /** Bytes already committed to the badge, package table and any non-failure content. */
  fixedBytes: number;
  /** Message + stack trace + markdown scaffolding, summed over all failures. */
  perFailureBytes: number;
  budgetBytes?: number;
}): { outputBudgetPerFailure: number; shownFailures: number } {
  const { failureCount, fixedBytes, perFailureBytes, budgetBytes } = args;
  const maxPerFailure = 2 * DEFAULT_OUTPUT_WINDOW_BYTES;
  if (failureCount === 0) return { outputBudgetPerFailure: maxPerFailure, shownFailures: 0 };
  if (budgetBytes === undefined) return { outputBudgetPerFailure: maxPerFailure, shownFailures: failureCount };

  // Rule 1: size the allowance to what's left after the parts we always render. This is a
  // per-failure total shared by whichever of stdout/stderr that failure actually has —
  // dividing by a fixed two streams wasted half the budget on the common case of an empty
  // stderr.
  const forOutput = budgetBytes - fixedBytes - perFailureBytes;
  const perFailure = Math.floor(forOutput / failureCount);
  if (perFailure >= MIN_OUTPUT_WINDOW_BYTES) {
    return { outputBudgetPerFailure: Math.min(perFailure, maxPerFailure), shownFailures: failureCount };
  }

  // Rule 2: the window has hit its floor, so cut how many failures are detailed rather
  // than shrinking the window into uselessness. Costs are averaged over the failures we
  // have; the byte-accurate check in gha.ts is what actually guarantees the bound.
  const averageFixed = perFailureBytes / failureCount;
  const costEach = averageFixed + MIN_OUTPUT_WINDOW_BYTES;
  const affordable = Math.floor((budgetBytes - fixedBytes) / costEach);
  return { outputBudgetPerFailure: MIN_OUTPUT_WINDOW_BYTES, shownFailures: Math.max(0, Math.min(failureCount, affordable)) };
}

/**
 * Render a JunitMarkdownData object to a GFM markdown string (for $GITHUB_STEP_SUMMARY).
 *
 * Per-test stdout and stack traces are kept — they are what makes a failure triageable —
 * but the elision window is derived from `budgetBytes` rather than fixed, so a run with
 * many failures narrows the window instead of overrunning GitHub's 1024k cap and losing
 * the summary entirely. Once the window would be too small to be useful, fewer failures
 * are detailed and the remainder is reported as a count.
 */
export function renderJunitMarkdown(data: JunitMarkdownData, options: JunitMarkdownOptions = {}): string {
  const { includeFailureDetail = true, budgetBytes } = options;
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
  lines.push("<details open>");
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

  if (!includeFailureDetail) {
    if (failingCases.length > 0) {
      lines.push(`_${failingCases.length} failing test(s) — detail omitted to stay within GitHub's step-summary limit; see the run artifacts above._`);
      lines.push("");
    }
    return lines.join("\n");
  }

  // Size the per-failure output window against what's left of the budget. The stack trace
  // and message are always rendered, so they count as committed cost before the window is
  // divided up; only stdout/stderr flex.
  const fixedBytes = Buffer.byteLength(lines.join("\n"), "utf8");
  const perFailureBytes = failingCases.reduce(
    (total, tc) =>
      total +
      PER_FAILURE_SCAFFOLD_BYTES +
      tc.issues.reduce((a, issue) => a + Buffer.byteLength(issue.message, "utf8") + Buffer.byteLength(condenseStackTrace(issue.body), "utf8"), 0),
    0,
  );
  const plan = planFailureDetail({
    failureCount: failingCases.length,
    fixedBytes,
    perFailureBytes,
    budgetBytes,
  });

  /**
   * Render the failure section for a given allowance. Predicting its exact size from the
   * inputs proved unreliable (markdown scaffolding, elision markers and multi-byte content
   * all drift), so `renderJunitMarkdown` renders, measures, and shrinks until it fits
   * rather than trusting the estimate.
   */
  const renderFailures = (outputBudgetPerFailure: number, shownFailures: number): string[] => {
  const lines: string[] = [];
  for (const tc of failingCases.slice(0, shownFailures)) {
    const simpleClass = removePackage(tc.classname);
    const icon = tc.issues.some((issue) => issue.tag === "error") ? "💥" : "❌";
    lines.push(`#### ${icon} ${simpleClass}.${tc.name}`);
    lines.push("");
    for (const issue of tc.issues) {
      if (issue.message) {
        lines.push("```");
        // Windowed like everything else: normally ~60 bytes, but the driver can put a
        // whole serialized exception in here and nothing else would bound it.
        lines.push(truncate(issue.message, outputBudgetPerFailure));
        lines.push("```");
        lines.push("");
      }
      if (tc.timeMs > 0) {
        lines.push(`${formatTime(tc.timeMs)} ⏱️`);
        lines.push("");
      }
      if (issue.body) {
        lines.push("<details>");
        lines.push("<summary><b>🧵 Stack trace</b></summary>");
        lines.push("");
        lines.push("```");
        lines.push(truncate(condenseStackTrace(issue.body), outputBudgetPerFailure));
        lines.push("```");
        lines.push("");
        lines.push("</details>");
        lines.push("");
      }
    }
    // Share this failure's allowance across only the streams it actually has.
    const streams = ([["stdout", tc.stdout], ["stderr", tc.stderr]] as const).filter(([, output]) => Boolean(output));
    const perStream = streams.length > 0 ? Math.floor(outputBudgetPerFailure / streams.length) : outputBudgetPerFailure;
    for (const [label, output] of streams) {
      if (!output) continue;
      lines.push("<details>");
      lines.push(`<summary><b>🖥️ Test output (${label})</b></summary>`);
      lines.push("");
      lines.push("```");
      lines.push(truncate(output, perStream));
      lines.push("```");
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }

  const notShown = failingCases.length - shownFailures;
  if (notShown > 0) {
    lines.push(
      `_... and ${notShown} more failure(s) not shown, to stay within GitHub's step-summary limit. ` +
        `All ${failingCases.length} are in this run's ARTIFACT_DIR, fetchable via \`fit archive fetch ...\` (see above)._`,
    );
    lines.push("");
  }
    return lines;
  };

  let { outputBudgetPerFailure, shownFailures } = plan;
  let failureLines = renderFailures(outputBudgetPerFailure, shownFailures);
  if (budgetBytes !== undefined) {
    // Shrink the allowance to close any overshoot, then, if the allowance is already at its
    // floor, show fewer failures. Bounded passes so this can never loop.
    for (let pass = 0; pass < 6; pass++) {
      const size = Buffer.byteLength([...lines, ...failureLines].join("\n"), "utf8");
      if (size <= budgetBytes) break;
      const overshoot = size - budgetBytes;
      if (outputBudgetPerFailure > MIN_OUTPUT_WINDOW_BYTES && shownFailures > 0) {
        const reduction = Math.max(1, Math.ceil(overshoot / shownFailures));
        outputBudgetPerFailure = Math.max(MIN_OUTPUT_WINDOW_BYTES, outputBudgetPerFailure - reduction);
      } else if (shownFailures > 0) {
        const perFailure = Math.max(1, Math.floor(size / Math.max(1, shownFailures)));
        shownFailures = Math.max(0, shownFailures - Math.max(1, Math.ceil(overshoot / perFailure)));
      } else {
        break;
      }
      failureLines = renderFailures(outputBudgetPerFailure, shownFailures);
    }
  }

  return [...lines, ...failureLines].join("\n");
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
export function junitToMarkdownFromDir(dir: string, options: JunitMarkdownOptions = {}): string {
  const data = parseJunitDataFromDir(dir);
  return data ? renderJunitMarkdown(data, options) : "_No JUnit reports found._\n";
}

/**
 * Read all TEST-*.xml files recursively under `dir` and return a plain-text
 * table suitable for printing to the terminal.
 */
export function junitToPlainTextFromDir(dir: string): string {
  const data = parseJunitDataFromDir(dir);
  return data ? renderJunitPlainText(data) : "No JUnit reports found.\n";
}

const USAGE = `Usage: bun src/fit/shared/run-test-driver/junit-to-markdown.ts [options] <surefire-reports-dir-or-archive.tar.gz>

Render JUnit surefire reports the way fit-cli does.

Options:
  --markdown     Emit the GitHub-flavoured markdown written to $GITHUB_STEP_SUMMARY,
                 rather than the terminal table. Use this to see what a GHA run will show.
  --lean         With --markdown, emit the reduced form (badge + package table, no
                 per-failure detail) that the step-summary budget falls back to.
  --bytes        Print the rendered size instead of the content — handy for checking
                 a run against GitHub's 1024k step-summary cap.
  -h, --help     Show this help.

Examples:
  bun src/fit/shared/run-test-driver/junit-to-markdown.ts /tmp/fit-cli/20260622-122009
  bun src/fit/shared/run-test-driver/junit-to-markdown.ts --markdown --bytes /tmp/fit-cli/20260804-002753-7c4f/instances/aws1/clusters/8.0-stable/sessions/dotnet-main/runs/functional/surefire-reports
  bun src/fit/shared/run-test-driver/junit-to-markdown.ts --markdown .../surefire-reports.tar.gz`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  // Reject unknown options rather than ignoring them: silently dropping a typo like
  // "--markdwon" would print the terminal table while the caller believed they were
  // looking at the markdown GitHub will render.
  const KNOWN_FLAGS = new Set(["--markdown", "--lean", "--bytes"]);
  const unknown = argv.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    console.error(`Unknown option(s): ${unknown.join(", ")}\n\n${USAGE}`);
    process.exit(2);
  }
  const asMarkdown = argv.includes("--markdown");
  const lean = argv.includes("--lean");
  const bytesOnly = argv.includes("--bytes");
  const positional = argv.filter((a) => !a.startsWith("-"));
  if (positional.length !== 1) {
    console.log(USAGE);
    process.exit(2);
  }
  if (lean && !asMarkdown) {
    console.error("--lean only applies with --markdown (the terminal renderer has no lean form).");
    process.exit(2);
  }

  const input = positional[0];
  if (!existsSync(input)) {
    console.error(`Not found: ${input}`);
    process.exit(1);
  }

  const render = (dir: string): string => (asMarkdown ? junitToMarkdownFromDir(dir, { includeFailureDetail: !lean }) : junitToPlainTextFromDir(dir));
  const emit = (text: string): void => {
    if (bytesOnly) {
      console.log(`${Buffer.byteLength(text, "utf8")} bytes (${(Buffer.byteLength(text, "utf8") / 1024).toFixed(1)}K)`);
    } else {
      process.stdout.write(text);
    }
  };

  if (extname(input) === ".gz") {
    const tmpDir = mkdtempSync(join(tmpdir(), "fit-junit-markdown-"));
    try {
      await run("tar", ["-xzf", input, "-C", tmpDir]);
      emit(render(tmpDir));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  } else {
    emit(render(input));
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
