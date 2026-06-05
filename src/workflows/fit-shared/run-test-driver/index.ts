/**
 * Workflow: run the FIT test-driver Maven command from transactions-fit-performer.
 *
 * Shared by every FIT flavour (functional, situational, …). The only thing that
 * varies between them is `extraMavenArgs` — the JUnit group filter — which the
 * caller supplies (see e.g. FUNCTIONAL_MAVEN_TEST_ARGS in fit-functional and
 * SITUATIONAL_MAVEN_TEST_ARGS in fit-situational).
 *
 * Run on its own (add --root <dir> to point elsewhere):
 *   npx tsx src/workflows/fit-shared/run-test-driver/index.ts
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { artifactFromPath, combineArtifacts, type Detail, type RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { surefireReportsDir } from "./collect-junit.js";
import { createLogFile } from "../../../util/non-fit/proc.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { createLocalFitExecutionContext, type FitExecutionContext } from "../remote-fit-run.js";
import { selectFitTests, type FitTestSelection } from "../select-fit-tests/index.js";

export const DEFAULT_MAVEN_TEST_ARGS = [
  "-DexcludedGroups=situational,openshift,syncgateway",
] as const;

export interface TestRunResult extends RunOutput {
  ok: boolean;
  logFile: string;
}

export interface FitTestDriverSummary {
  testsRun: number;
  failures: number;
  errors: number;
  skipped: number;
}

const JUNIT_ATTRIBUTE_RE = (name: string): RegExp => new RegExp(`\\b${name}="(\\d+)"`);

export function fitTestLogStem(iteration: number): string {
  return `${iteration}-driver`;
}

function fitTestLogFile(iteration: number): string {
  return createLogFile(fitTestLogStem(iteration));
}

function extractJunitAttribute(xml: string, name: string): number | undefined {
  const match = xml.match(JUNIT_ATTRIBUTE_RE(name));
  return match ? Number(match[1]) : undefined;
}

export function extractFitTestDriverSummaryFromJunit(xml: string): FitTestDriverSummary | undefined {
  if (!xml.includes("<testsuite") && !xml.includes("<testsuites")) {
    return undefined;
  }

  const testsRun = extractJunitAttribute(xml, "tests");
  const failures = extractJunitAttribute(xml, "failures");
  const errors = extractJunitAttribute(xml, "errors");
  const skipped = extractJunitAttribute(xml, "skipped");
  if (testsRun === undefined || failures === undefined || errors === undefined || skipped === undefined) {
    return undefined;
  }

  return {
    testsRun,
    failures,
    errors,
    skipped,
  };
}

export function extractFitTestDriverSummaryFromJunitReports(reportsDir: string): FitTestDriverSummary | undefined {
  if (!existsSync(reportsDir)) {
    return undefined;
  }

  const xmlFiles = readdirSync(reportsDir).filter((file) => file.startsWith("TEST-") && file.endsWith(".xml"));
  if (xmlFiles.length === 0) {
    return undefined;
  }

  const summaries = xmlFiles
    .map((file) => extractFitTestDriverSummaryFromJunit(readFileSync(join(reportsDir, file), "utf8")))
    .filter((summary): summary is FitTestDriverSummary => summary !== undefined);
  if (summaries.length === 0) {
    return undefined;
  }

  return summaries.reduce<FitTestDriverSummary>(
    (combined, summary) => ({
      testsRun: combined.testsRun + summary.testsRun,
      failures: combined.failures + summary.failures,
      errors: combined.errors + summary.errors,
      skipped: combined.skipped + summary.skipped,
    }),
    { testsRun: 0, failures: 0, errors: 0, skipped: 0 },
  );
}

export function didFitTestDriverPass(summary: FitTestDriverSummary): boolean {
  return summary.failures === 0 && summary.errors === 0;
}

export function fitTestDriverSummaryDetails(summary: FitTestDriverSummary): Detail[] {
  return [
    {
      label: "Result",
      value: didFitTestDriverPass(summary) ? "PASS" : "FAIL",
    },
    {
      label: "Tests run",
      value: String(summary.testsRun),
    },
    {
      label: "Failures",
      value: String(summary.failures),
    },
    {
      label: "Errors",
      value: String(summary.errors),
    },
    {
      label: "Skipped",
      value: String(summary.skipped),
    },
  ];
}

/** Build the `./mvnw` args needed to run the FIT test-driver. */
export function runTestDriverArgs(
  selection: FitTestSelection,
  fitConfigPath?: string,
  extraMavenArgs: readonly string[] = DEFAULT_MAVEN_TEST_ARGS,
): string[] {
  return [
    "-q",
    "--no-transfer-progress",
    "--batch-mode",
    "--projects",
    "test-driver",
    "--also-make",
    "-Dmaven.test.failure.ignore",
    "-Dsurefire.failIfNoSpecifiedTests=false",
    ...(selection.mavenTestSelector ? [`-Dtest=${selection.mavenTestSelector}`] : []),
    ...(fitConfigPath ? [`-Dfit.config=${fitConfigPath}`] : []),
    "test",
    ...extraMavenArgs,
  ];
}

/** Run the FIT test-driver using the Jenkins-style Maven invocation. */
export async function runTestDriver(
  execution: FitExecutionContext,
  selection: FitTestSelection,
  fitConfigPath?: string,
  extraMavenArgs: readonly string[] = DEFAULT_MAVEN_TEST_ARGS,
  iteration: number = 0,
): Promise<TestRunResult> {
  const targetFitConfigPath = fitConfigPath ? await execution.stageFile(fitConfigPath) : undefined;
  const args = runTestDriverArgs(selection, targetFitConfigPath, extraMavenArgs);

  // Surefire only overwrites reports for the classes it actually runs; it never
  // purges the directory. Without this, stale reports from a prior (broader) run
  // get collected alongside this run's, polluting the JUnit report with tests we
  // didn't run. We delete only surefire-reports, not the whole target/ — a true
  // `mvn clean` (or rm -rf target) would also drop the compiled code, making
  // every iteration pay the recompile cost.
  await execution.removeTree(surefireReportsDir(execution.rootDir));

  const logFile = fitTestLogFile(iteration);
  const targetLogFile = execution.targetFilePath(logFile);
  const logArtifact = artifactFromPath(logFile, "FIT test-driver stdout/stderr captured for this run");
  console.log(`\nRunning FIT test-driver with:\n  cd ${execution.fitPerformerDir} && ./mvnw ${args.join(" ")}\n`);
  console.log(`Streaming FIT test-driver output to:\n  ${targetLogFile}\n`);

  // The test-driver still writes JUnit reports when tests fail, so collect them
  // on both paths — the failing run is the one most worth visualising.
  let commandOk: boolean;
  try {
    await execution.runToFile("./mvnw", args, targetLogFile, execution.fitPerformerDir);
    console.log("\n✓ FIT test-driver finished");
    commandOk = true;
  } catch (err) {
    console.error(`\n✗ FIT test-driver failed: ${(err as Error).message}`);
    commandOk = false;
  }

  await execution.collectFile(targetLogFile, logFile);
  const artifacts = combineArtifacts([logArtifact], await execution.collectJunitArtifacts(surefireReportsDir(execution.rootDir)));
  const summary = extractFitTestDriverSummaryFromJunitReports(join(dirname(logFile), "surefire-reports"));
  const ok = commandOk && (summary ? didFitTestDriverPass(summary) : true);
  return { ok, logFile, artifacts, details: summary ? fitTestDriverSummaryDetails(summary) : [] };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    const execution = createLocalFitExecutionContext(rootDir);
    const selection = await selectFitTests(execution);
    return await runTestDriver(execution, selection);
  });
}
