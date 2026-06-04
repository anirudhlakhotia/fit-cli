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
import { rmSync } from "node:fs";
import { artifactFromPath, combineArtifacts, type ArtifactCollection } from "../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { collectJunitArtifacts, surefireReportsDir } from "./collect-junit.js";
import { createLogFile, streamToFile } from "../../../util/non-fit/proc.js";
import { FIT_PERFORMER, repoPath } from "../../../util/fit/repos.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { selectFitTests, type FitTestSelection } from "../select-fit-tests/index.js";

export const DEFAULT_MAVEN_TEST_ARGS = [
  "-DexcludedGroups=situational,openshift,syncgateway",
] as const;

export interface TestRunResult extends ArtifactCollection {
  ok: boolean;
  logFile: string;
}

function fitTestLogFile(): string {
  return createLogFile("driver");
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
  rootDir: string,
  selection: FitTestSelection,
  fitConfigPath?: string,
  extraMavenArgs: readonly string[] = DEFAULT_MAVEN_TEST_ARGS,
): Promise<TestRunResult> {
  const args = runTestDriverArgs(selection, fitConfigPath, extraMavenArgs);

  // Surefire only overwrites reports for the classes it actually runs; it never
  // purges the directory. Without this, stale reports from a prior (broader) run
  // get collected alongside this run's, polluting the JUnit report with tests we
  // didn't run. We delete only surefire-reports, not the whole target/ — a true
  // `mvn clean` (or rm -rf target) would also drop the compiled code, making
  // every iteration pay the recompile cost.
  rmSync(surefireReportsDir(rootDir), { recursive: true, force: true });

  const logFile = fitTestLogFile();
  const logArtifact = artifactFromPath(logFile, "FIT test-driver stdout/stderr captured for this run");
  console.log(`\nRunning FIT test-driver with:\n  cd ${repoPath(FIT_PERFORMER, rootDir)} && ./mvnw ${args.join(" ")}\n`);
  console.log(`Streaming FIT test-driver output to:\n  ${logFile}\n`);

  // The test-driver still writes JUnit reports when tests fail, so collect them
  // on both paths — the failing run is the one most worth visualising.
  let ok: boolean;
  try {
    await streamToFile("./mvnw", args, logFile, repoPath(FIT_PERFORMER, rootDir));
    console.log("\n✓ FIT test-driver finished");
    ok = true;
  } catch (err) {
    console.error(`\n✗ FIT test-driver failed: ${(err as Error).message}`);
    ok = false;
  }

  const artifacts = combineArtifacts([logArtifact], await collectJunitArtifacts(rootDir));
  return { ok, logFile, artifacts };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    const selection = await selectFitTests(rootDir);
    return await runTestDriver(rootDir, selection);
  });
}
