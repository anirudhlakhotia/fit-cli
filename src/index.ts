#!/usr/bin/env node
/**
 * The FIT CLI wizard. This file only presents the top-level menu and hands off
 * to a flow. Each flow lives in its own directory (e.g. fit-functional-guided/)
 * and can be run on its own for debugging — see the header of its index.ts.
 */
import { select } from "@inquirer/prompts";
import { runFunctionalTests } from "./fit-functional-guided/index.js";
import { runCli } from "./lib/cli.js";

async function main(): Promise<void> {
  console.log("FIT CLI — making FIT easier to use.\n");

  const choice = await select({
    message: "What would you like to do?",
    choices: [
      { name: "Run functional tests", value: "functional-tests" },
      // More options will follow.
    ],
  });

  switch (choice) {
    case "functional-tests":
      await runFunctionalTests();
      break;
  }
}

runCli(main);
