/**
 * Collect the JUnit XML the FIT test-driver produces (via Maven surefire) into
 * the per-run ARTIFACT_DIR, and render a self-contained HTML visualisation of
 * the results with xunit-viewer.
 *
 * The surefire reports live under the performer repo's target/ directory, which
 * is overwritten by the next Maven run, so we copy them somewhere stable and
 * register them — and the generated report — as run artifacts.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { artifactFromPath, type Artifact } from "../../../../util/non-fit/artifacts.js";
import { run } from "../../../../util/non-fit/proc.js";
import { ensureRunDir } from "../../../../util/non-fit/replay.js";
import { FIT_PERFORMER, repoPath } from "../../../../util/fit/repos.js";

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
 * Copy the test-driver's JUnit XML into ARTIFACT_DIR/surefire-reports, generate
 * an HTML report from it with xunit-viewer, and return artifacts for both. Best
 * effort: returns an empty list when no reports were produced, and still returns
 * the XML artifact if the HTML render fails.
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

  const reportFile = join(runDir, "report.html");
  try {
    await run("npx", ["--no-install", "xunit-viewer", "--results", destDir, "--output", reportFile]);
    artifacts.push(artifactFromPath(reportFile, "HTML visualisation of the JUnit results (open in a browser)"));
  } catch (err) {
    console.warn(`\nCould not render the JUnit HTML report with xunit-viewer: ${(err as Error).message}`);
  }

  return artifacts;
}
