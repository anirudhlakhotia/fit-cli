/**
 * Workflow: run the FIT test-driver Maven command from transactions-fit-performer.
 *
 * Run on its own (add --root <dir> to point elsewhere):
 *   npx tsx src/workflows/fit-functional/workflows/run-test-driver/index.ts
 */
import { isMain, runCli } from "../../../../util/non-fit/cli.js";
import { run } from "../../../../util/non-fit/proc.js";
import { FIT_PERFORMER, repoPath } from "../../../../util/fit/repos.js";
import { rootDirFromArgv } from "../../../../util/fit/root.js";
import { selectFitTests, type FitTestSelection } from "../select-fit-tests/index.js";

export const DEFAULT_MAVEN_TEST_ARGS = [
  "-DexcludedGroups=situational,openshift,syncgateway",
] as const;

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
): Promise<boolean> {
  const args = runTestDriverArgs(selection, fitConfigPath, extraMavenArgs);
  console.log(`\nRunning FIT test-driver with:\n  cd ${repoPath(FIT_PERFORMER, rootDir)} && ./mvnw ${args.join(" ")}\n`);

  try {
    await run("./mvnw", args, repoPath(FIT_PERFORMER, rootDir));
    console.log("\n✓ FIT test-driver finished");
    return true;
  } catch (err) {
    console.error(`\n✗ FIT test-driver failed: ${(err as Error).message}`);
    return false;
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    const selection = await selectFitTests(rootDir);
    await runTestDriver(rootDir, selection);
  });
}
