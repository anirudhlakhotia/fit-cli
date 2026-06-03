#!/usr/bin/env node
/**
 * The FIT CLI wizard. This file only presents the top-level menu and hands off
 * to a flow. Each flow lives in its own directory (e.g.
 * workflows/fit-functional/guided/) and can be run on its own for debugging —
 * see the header of its index.ts.
 */
import { isMain, runCli } from "./util/non-fit/cli.js";
import { select } from "./util/non-fit/prompts.js";
import { ensurePromptSession, type PromptSession } from "./util/non-fit/replay.js";
import { runFunctionalTests } from "./workflows/fit-functional/guided/index.js";
import { rootDirFromArgv } from "./util/fit/root.js";

const WORKFLOW_PROMPT_MESSAGE =
  "What would you like to do?  [More options to follow - PRs welcome ;) ]";

const WORKFLOW_CHOICES = [
  { name: "Run FIT functional tests", value: "functional-tests" },
] as const;

export type WorkflowChoice = (typeof WORKFLOW_CHOICES)[number]["value"];

function isWorkflowChoice(value: string): value is WorkflowChoice {
  return WORKFLOW_CHOICES.some((choice) => choice.value === value);
}

export async function chooseWorkflow(
  promptSession: PromptSession = ensurePromptSession(),
): Promise<WorkflowChoice> {
  const replayWorkflow = promptSession.getWorkflow();
  if (replayWorkflow) {
    if (!isWorkflowChoice(replayWorkflow)) {
      throw new Error(`Unknown workflow in replay log: ${replayWorkflow}`);
    }
    promptSession.consumeLegacyWorkflowPrompt(replayWorkflow);
    return replayWorkflow;
  }

  // Note - only very high-level workflows should go here. We don't want an overwhelming list of options at the top level.
  // Users can run smaller workflows and steps for debugging or development through the mini cli tools.
  const choice = await select<WorkflowChoice>({
    message: WORKFLOW_PROMPT_MESSAGE,
    choices: WORKFLOW_CHOICES,
  });
  promptSession.setWorkflow(choice);
  return choice;
}

export async function runWorkflow(choice: WorkflowChoice, rootDir: string): Promise<void> {
  switch (choice) {
    case "functional-tests":
      await runFunctionalTests(rootDir);
      break;
  }
}

export async function main(): Promise<void> {
  console.log("FIT CLI — making FIT easier to use.\n");

  const { rootDir } = rootDirFromArgv(process.argv.slice(2));
  const choice = await chooseWorkflow();
  await runWorkflow(choice, rootDir);
}

if (isMain(import.meta.url)) {
  runCli(main);
}
