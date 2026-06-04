/**
 * Collect the JUnit XML the FIT test-driver produces (via Maven surefire) into
 * the per-run ARTIFACT_DIR, and render a self-contained HTML visualisation of
 * the results with xunit-viewer.
 *
 * The surefire reports live under the performer repo's target/ directory, which
 * is overwritten by the next Maven run, so we copy them somewhere stable and
 * register them — and the generated report — as run artifacts.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactFromPath, type Artifact } from "../../../util/non-fit/artifacts.js";
import { run } from "../../../util/non-fit/proc.js";
import { ensureRunDir } from "../../../util/non-fit/replay.js";
import { FIT_PERFORMER, repoPath } from "../../../util/fit/repos.js";

/** Absolute path to the surefire JUnit XML directory the test-driver produces. */
export function surefireReportsDir(rootDir: string): string {
  return join(repoPath(FIT_PERFORMER, rootDir), "test-driver", "target", "surefire-reports");
}

/** The surefire XML report files (TEST-*.xml) found in `sourceDir`. */
function junitXmlFiles(sourceDir: string): string[] {
  if (!existsSync(sourceDir)) {
    return [];
  }
  return readdirSync(sourceDir).filter((file) => file.startsWith("TEST-") && file.endsWith(".xml"));
}

/**
 * Drop the surefire <properties> block (java.class.path, surefire.test.class.path
 * and friends) from a report. The values are huge and add no signal to the HTML
 * report, which embeds the raw XML, so we strip them from the copy we render.
 */
export function stripJunitProperties(xml: string): string {
  return xml.replace(/[ \t]*<properties>[\s\S]*?<\/properties>\n?/g, "");
}

/**
 * Patch the xunit-viewer HTML so suites render collapsed by default. The bundle
 * initialises every suite to active (expanded); flip that, and the "Expanded"
 * toggle's initial state, by rewriting the two tokens that drive it. Best effort:
 * returns the HTML unchanged (with a warning) if a token is no longer present,
 * e.g. after an xunit-viewer upgrade.
 */
export function collapseSuitesByDefault(html: string): string {
  const replacements: ReadonlyArray<readonly [string, string]> = [
    ["(r.currentSuites[a].active=!0)", "(r.currentSuites[a].active=!1)"],
    ["suitesExpanded:!0", "suitesExpanded:!1"],
  ];

  let patched = html;
  for (const [from, to] of replacements) {
    if (!patched.includes(from)) {
      console.warn(`\nCould not collapse JUnit suites by default: xunit-viewer token not found (${from}).`);
      continue;
    }
    patched = patched.replaceAll(from, to);
  }
  return patched;
}

/**
 * Render report.html from the collected reports: strip the noisy <properties>
 * block from a throwaway copy, run xunit-viewer over it, then collapse the
 * suites in the generated HTML. Returns undefined (best effort) if the render
 * fails, leaving the raw XML artifact untouched.
 */
async function renderJunitReport(reportsDir: string, runDir: string): Promise<Artifact | undefined> {
  const renderDir = mkdtempSync(join(tmpdir(), "fit-junit-"));
  try {
    for (const file of readdirSync(reportsDir)) {
      const cleaned = stripJunitProperties(readFileSync(join(reportsDir, file), "utf8"));
      writeFileSync(join(renderDir, file), cleaned, { mode: 0o600 });
    }

    const reportFile = join(runDir, "report.html");
    await run("npx", ["--no-install", "xunit-viewer", "--results", renderDir, "--output", reportFile]);
    writeFileSync(reportFile, collapseSuitesByDefault(readFileSync(reportFile, "utf8")), { mode: 0o600 });
    return artifactFromPath(reportFile, "HTML visualisation of the JUnit results (open in a browser)");
  } catch (err) {
    console.warn(`\nCould not render the JUnit HTML report with xunit-viewer: ${(err as Error).message}`);
    return undefined;
  } finally {
    rmSync(renderDir, { recursive: true, force: true });
  }
}

/**
 * Copy the test-driver's JUnit XML into ARTIFACT_DIR/surefire-reports, render an
 * HTML report from it, and return artifacts for both. Best effort: returns an
 * empty list when no reports were produced, and still returns the XML artifact
 * if the HTML render fails.
 */
export async function collectJunitArtifacts(rootDir: string): Promise<Artifact[]> {
  const sourceDir = surefireReportsDir(rootDir);
  const xmlFiles = junitXmlFiles(sourceDir);
  if (xmlFiles.length === 0) {
    console.warn(`\nNo JUnit reports found under ${sourceDir}; skipping JUnit artifacts.`);
    return [];
  }

  const runDir = ensureRunDir();
  const destDir = join(runDir, "surefire-reports");
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  for (const file of xmlFiles) {
    cpSync(join(sourceDir, file), join(destDir, file));
  }

  const artifacts: Artifact[] = [
    artifactFromPath(destDir, `JUnit XML reports from the FIT test-driver (${xmlFiles.length} file(s))`),
  ];

  const reportArtifact = await renderJunitReport(destDir, runDir);
  if (reportArtifact) {
    artifacts.push(reportArtifact);
  }
  return artifacts;
}
