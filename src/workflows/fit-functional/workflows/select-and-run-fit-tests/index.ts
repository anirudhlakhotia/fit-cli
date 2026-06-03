/**
 * Workflow: prompt for FIT test-driver tests, then run the FIT test-driver.
 *
 * Run on its own (optionally pass a FITConfiguration.json path first, then add
 * --root <dir> to point elsewhere):
 *   npx tsx src/workflows/fit-functional/workflows/select-and-run-fit-tests/index.ts [fitConfigPath]
 */
import { isMain, runCli } from "../../../../util/non-fit/cli.js";
import { rootDirFromArgv } from "../../../../util/fit/root.js";
import {
  selectFitTests,
  type FitTestSelection,
} from "../select-fit-tests/index.js";
import { runTestDriver } from "../run-test-driver/index.js";

export interface SelectAndRunFitTestsDeps {
  selectFitTests: (rootDir: string) => Promise<FitTestSelection>;
  runTestDriver: (
    rootDir: string,
    selection: FitTestSelection,
    fitConfigPath?: string,
  ) => Promise<boolean>;
}

const DEFAULT_DEPS: SelectAndRunFitTestsDeps = {
  selectFitTests,
  runTestDriver,
};

/** Prompt for FIT tests and then run the test-driver with that selection. */
export async function selectAndRunFitTests(
  rootDir: string,
  fitConfigPath?: string,
  deps: SelectAndRunFitTestsDeps = DEFAULT_DEPS,
): Promise<boolean> {
  const selection = await deps.selectFitTests(rootDir);
  return deps.runTestDriver(rootDir, selection, fitConfigPath);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir, positionals } = rootDirFromArgv(process.argv.slice(2));
    if (positionals.length > 1) {
      console.error(
        "Usage: tsx src/workflows/fit-functional/workflows/select-and-run-fit-tests/index.ts [fitConfigPath] [--root <dir>]",
      );
      process.exit(2);
    }

    await selectAndRunFitTests(rootDir, positionals[0]);
  });
}
