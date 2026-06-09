/**
 * Workflow: run the FIT test-driver Maven command from transactions-fit-performer.
 *
 * Shared by every FIT flavour (functional, situational, …). The only thing that
 * varies between them is `extraMavenArgs` — the JUnit group filter — which the
 * caller supplies (see {@link DEFAULT_MAVEN_TEST_ARGS} for functional runs and
 * {@link SITUATIONAL_MAVEN_TEST_ARGS} for situational ones).
 *
 * Run on its own (add --root <dir> to point elsewhere):
 *   npx tsx src/workflows/fit-shared/run-test-driver/run-test-driver.ts
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { artifactFromPath, combineArtifacts, type Detail, type RunOutput } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { surefireReportsDir } from "./collect-junit.js";
import { createLogFile } from "../../../util/non-fit/proc.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { createLocalFitExecutionContext, type FitExecutionContext } from "../util/remote-fit-run.js";
import { selectFitTests, type FitTestSelection } from "../select-fit-tests/select-fit-tests.js";

export const DEFAULT_MAVEN_TEST_ARGS = [
  "-DexcludedGroups=situational,openshift,syncgateway",
] as const;

/** The `-Dgroups` filter that selects the cbdino-managed situational tests. */
export const SITUATIONAL_MAVEN_GROUPS_ARG = "-Dgroups=situational,cbDino";

/**
 * The default Maven group filter for situational runs: select the situational +
 * cbDino tests and exclude the ones that don't fit a cbdino-managed cluster. A
 * definition's `runtime.excludedGroups` overrides the exclusions (see
 * resolve-definition.ts).
 */
export const SITUATIONAL_MAVEN_TEST_ARGS = [
  SITUATIONAL_MAVEN_GROUPS_ARG,
  "-DexcludedGroups=openshift,capella",
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

export function fitTestLogStem(cycleIndex: number, iteration: number): string {
  return join("cycles", String(cycleIndex), `it${iteration}`, "driver");
}

function fitTestLogFile(cycleIndex: number, iteration: number): string {
  return createLogFile(fitTestLogStem(cycleIndex, iteration));
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

function iterationDetailLabel(iteration: number, label: string): string {
  return `it${iteration} ${label}`;
}

export function fitTestDriverSummaryDetails(summary: FitTestDriverSummary, iteration: number = 0): Detail[] {
  return [
    {
      label: iterationDetailLabel(iteration, "Result"),
      value: didFitTestDriverPass(summary) ? "PASS" : "FAIL",
    },
    {
      label: iterationDetailLabel(iteration, "Tests run"),
      value: String(summary.testsRun),
    },
    {
      label: iterationDetailLabel(iteration, "Failures"),
      value: String(summary.failures),
    },
    {
      label: iterationDetailLabel(iteration, "Errors"),
      value: String(summary.errors),
    },
    {
      label: iterationDetailLabel(iteration, "Skipped"),
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
  cycleIndex: number = 0,
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

  const logFile = fitTestLogFile(cycleIndex, iteration);
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
  const artifacts = combineArtifacts(
    [logArtifact],
    await execution.collectJunitArtifacts(surefireReportsDir(execution.rootDir), cycleIndex, iteration),
  );
  const summary = extractFitTestDriverSummaryFromJunitReports(join(dirname(logFile), "surefire-reports"));
  const ok = commandOk && (summary ? didFitTestDriverPass(summary) : true);
  return { ok, logFile, artifacts, details: summary ? fitTestDriverSummaryDetails(summary, iteration) : [] };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    const execution = createLocalFitExecutionContext(rootDir);
    const selection = await selectFitTests(execution);
    return await runTestDriver(execution, selection);
  });
}
