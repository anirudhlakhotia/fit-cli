#!/usr/bin/env node
/**
 * The FIT CLI wizard. This file only presents the top-level menu and hands off
 * to a flow. Each flow lives in its own directory (e.g.
 * workflows/fit-functional/guided/) and can be run on its own for debugging —
 * see the header of its index.ts.
 */
import { type RunOutput } from "./util/non-fit/artifacts.js";
import { isMain, runCli } from "./util/non-fit/cli.js";
import { select } from "./util/non-fit/prompts.js";
import { ensurePromptSession, type PromptSession } from "./util/non-fit/replay.js";
import { runFunctionalTests } from "./workflows/fit-functional/workflows/guided/index.js";
import { rootDirFromArgv } from "./util/fit/root.js";

const WORKFLOW_PROMPT_MESSAGE =
  "What would you like to do?  [More options to follow - PRs welcome ;) ]";

const WORKFLOW_CHOICES = [
  { name: "Run FIT functional tests", value: "functional-tests" },
] as const;

export type WorkflowChoice = (typeof WORKFLOW_CHOICES)[number]["value"];
const WORKFLOW_PROMPT_ID = "workflow.choose";

function isWorkflowChoice(value: string): value is WorkflowChoice {
  return WORKFLOW_CHOICES.some((choice) => choice.value === value);
}

export async function chooseWorkflow(
  promptSession: PromptSession = ensurePromptSession(),
  selectWorkflow: (config: {
    promptId: string;
    message: string;
    choices: typeof WORKFLOW_CHOICES;
    default?: WorkflowChoice;
  }) => Promise<WorkflowChoice> = select,
): Promise<WorkflowChoice> {
  const storedWorkflow = promptSession.getWorkflow();
  let replayWorkflow: WorkflowChoice | undefined;
  if (storedWorkflow) {
    if (!isWorkflowChoice(storedWorkflow)) {
      throw new Error(`Unknown workflow in replay log: ${storedWorkflow}`);
    }
    replayWorkflow = storedWorkflow;
    if (promptSession.replaysStoredWorkflow()) {
      promptSession.consumeLegacyWorkflowPrompt(replayWorkflow);
      return replayWorkflow;
    }
  }

  // Note - only very high-level workflows should go here. We don't want an overwhelming list of options at the top level.
  // Users can run smaller workflows and steps for debugging or development through the mini cli tools.
  const choice = await selectWorkflow({
    promptId: WORKFLOW_PROMPT_ID,
    message: WORKFLOW_PROMPT_MESSAGE,
    choices: WORKFLOW_CHOICES,
    default: replayWorkflow,
  });
  promptSession.setWorkflow(choice);
  return choice;
}

export async function runWorkflow(choice: WorkflowChoice, rootDir: string): Promise<RunOutput> {
  switch (choice) {
    case "functional-tests":
      return runFunctionalTests(rootDir);
  }
}

export async function main(): Promise<RunOutput> {
  console.log("FIT CLI — making FIT easier to use, one vibe-coding session at a time.\n");

  const { rootDir } = rootDirFromArgv(process.argv.slice(2));
  const choice = await chooseWorkflow();
  return runWorkflow(choice, rootDir);
}

if (isMain(import.meta.url)) {
  runCli(main);
}
