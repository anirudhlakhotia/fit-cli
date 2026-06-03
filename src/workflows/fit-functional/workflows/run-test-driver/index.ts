/**
 * Workflow: run the FIT test-driver Maven command from transactions-fit-performer.
 *
 * Run on its own (add --root <dir> to point elsewhere):
 *   npx tsx src/workflows/fit-functional/workflows/run-test-driver/index.ts
 */
import { artifactFromPath, type ArtifactCollection } from "../../../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../../../util/non-fit/cli.js";
import { createLogFile, runAndCaptureToFile } from "../../../../util/non-fit/proc.js";
import { FIT_PERFORMER, repoPath } from "../../../../util/fit/repos.js";
import { rootDirFromArgv } from "../../../../util/fit/root.js";
import { selectFitTests, type FitTestSelection } from "../select-fit-tests/index.js";

export const DEFAULT_MAVEN_TEST_ARGS = [
  "-DexcludedGroups=situational,openshift,syncgateway",
] as const;

export interface TestRunResult extends ArtifactCollection {
  ok: boolean;
  logFile: string;
}

function fitTestLogFile(): string {
  return createLogFile("fit-test-driver");
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
    "-DfailIfNoTests=false",
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
  const logFile = fitTestLogFile();
  const artifacts = [artifactFromPath(logFile, "FIT test-driver stdout/stderr captured for this run")];
  console.log(`\nRunning FIT test-driver with:\n  cd ${repoPath(FIT_PERFORMER, rootDir)} && ./mvnw ${args.join(" ")}\n`);
  console.log(`Streaming FIT test-driver output to:\n  ${logFile}\n`);

  try {
    await runAndCaptureToFile("./mvnw", args, logFile, repoPath(FIT_PERFORMER, rootDir));
    console.log("\n✓ FIT test-driver finished");
    return { ok: true, logFile, artifacts };
  } catch (err) {
    console.error(`\n✗ FIT test-driver failed: ${(err as Error).message}`);
    return { ok: false, logFile, artifacts };
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    const selection = await selectFitTests(rootDir);
    return await runTestDriver(rootDir, selection);
  });
}
