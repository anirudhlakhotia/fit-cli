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
import { readFileSync } from "node:fs";
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

const FIT_TEST_DRIVER_SUMMARY_RE =
  /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/g;

function fitTestLogFile(): string {
  return createLogFile("driver");
}

export function extractFitTestDriverSummary(log: string): FitTestDriverSummary | undefined {
  const matches = Array.from(log.matchAll(FIT_TEST_DRIVER_SUMMARY_RE));
  const last = matches.at(-1);
  if (!last) {
    return undefined;
  }

  return {
    testsRun: Number(last[1]),
    failures: Number(last[2]),
    errors: Number(last[3]),
    skipped: Number(last[4]),
  };
}

export function fitTestDriverSummaryDetails(summary: FitTestDriverSummary): Detail[] {
  return [
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

  const logFile = fitTestLogFile();
  const targetLogFile = execution.targetFilePath(logFile);
  const logArtifact = artifactFromPath(logFile, "FIT test-driver stdout/stderr captured for this run");
  console.log(`\nRunning FIT test-driver with:\n  cd ${execution.fitPerformerDir} && ./mvnw ${args.join(" ")}\n`);
  console.log(`Streaming FIT test-driver output to:\n  ${targetLogFile}\n`);

  // The test-driver still writes JUnit reports when tests fail, so collect them
  // on both paths — the failing run is the one most worth visualising.
  let ok: boolean;
  try {
    await execution.runToFile("./mvnw", args, targetLogFile, execution.fitPerformerDir);
    console.log("\n✓ FIT test-driver finished");
    ok = true;
  } catch (err) {
    console.error(`\n✗ FIT test-driver failed: ${(err as Error).message}`);
    ok = false;
  }

  await execution.collectFile(targetLogFile, logFile);
  const artifacts = combineArtifacts([logArtifact], await execution.collectJunitArtifacts(surefireReportsDir(execution.rootDir)));
  const summary = extractFitTestDriverSummary(readFileSync(logFile, "utf8"));
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
