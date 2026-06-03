#!/usr/bin/env node
/**
 * The FIT CLI wizard. This file only presents the top-level menu and hands off
 * to a flow. Each flow lives in its own directory (e.g.
 * workflows/fit-functional/guided/) and can be run on its own for debugging —
 * see the header of its index.ts.
 */
import { select } from "./lib/prompts.js";
import { runFunctionalTests } from "./workflows/fit-functional/guided/index.js";
import { runCli } from "./lib/cli.js";
import { rootDirFromArgv } from "./lib/root.js";

async function main(): Promise<void> {
  console.log("FIT CLI — making FIT easier to use.\n");

  const { rootDir } = rootDirFromArgv(process.argv.slice(2));

  // Note - only very high-level workflows should go here. We don't want an overwhelming list of options at the top level.
  // Users can run smaller workflows and steps for debugging or development through the mini cli tools.
  const choice = await select({
    message: "What would you like to do?  [More options to follow - PRs welcome ;) ]",
    choices: [
      { name: "Run FIT functional tests", value: "functional-tests" },
    ],
  });

  switch (choice) {
    case "functional-tests":
      await runFunctionalTests(rootDir);
      break;
  }
}

runCli(main);
