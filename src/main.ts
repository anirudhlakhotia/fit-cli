#!/usr/bin/env node
/**
 * The FIT CLI wizard. This file only presents the top-level menu and hands off
 * to a definition-focused flow. Each flow lives in its own directory and can be
 * run on its own for debugging — see the header of its entrypoint.
 */
import { existsSync } from "node:fs";
import { type RunOutput } from "./util/non-fit/artifacts.js";
import { isMain, runCli } from "./util/non-fit/cli.js";
import { loadDotenv } from "./util/non-fit/dotenv.js";
import { input, select } from "./util/non-fit/prompts.js";
import { ensurePromptSession, type PromptSession } from "./util/non-fit/replay.js";
import { createFitDefinition } from "./workflows/fit-shared/create-definition/create-definition.js";
import { rootDirFromArgv } from "./util/fit/root.js";
import { runFromDefinition } from "./workflows/fit-functional/run-from-definition/run-from-definition.js";

const WORKFLOW_PROMPT_MESSAGE = "What would you like to do?";

const WORKFLOW_CHOICES = [
  { name: "Build a FIT definition file", value: "create-definition" },
  { name: "Run a FIT definition file", value: "run-definition" },
] as const;

export type WorkflowChoice = (typeof WORKFLOW_CHOICES)[number]["value"];
const WORKFLOW_PROMPT_ID = "workflow.choose";
const DEFINITION_PATH_PROMPT_ID = "workflow.definition.path";

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
    if (storedWorkflow === "functional-tests") {
      throw new Error(
        "Replay log references the removed top-level workflow 'functional-tests'. Recreate it as a FIT definition run instead.",
      );
    }
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

export async function askDefinitionPath(): Promise<string> {
  const definitionPath = await input({
    promptId: DEFINITION_PATH_PROMPT_ID,
    message: "Path to the FIT definition file to run:",
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return "Enter a path to a FIT definition file.";
      }
      if (!existsSync(trimmed)) {
        return `Definition file not found: ${trimmed}`;
      }
      return true;
    },
  });
  return definitionPath.trim();
}

export async function runWorkflow(choice: WorkflowChoice, rootDir: string, definitionPath?: string): Promise<RunOutput> {
  switch (choice) {
    case "create-definition":
      return createFitDefinition(rootDir);
    case "run-definition":
      return runFromDefinition(definitionPath ?? await askDefinitionPath(), rootDir);
  }
}

export async function main(): Promise<RunOutput> {
  console.log("FIT CLI — making FIT easier to use, one vibe-coding session at a time.\n");

  // Load any .env so secrets like the hosted results-DB password are available
  // without being passed on the command line. Real exported vars still win.
  loadDotenv();

  const { rootDir, positionals } = rootDirFromArgv(process.argv.slice(2));
  if (positionals.length > 1) {
    throw new Error("Usage: npm start [definition-file.yaml] [--root <dir>]");
  }
  if (positionals[0]) {
    ensurePromptSession().setWorkflow("run-definition");
    return runFromDefinition(positionals[0], rootDir);
  }
  const choice = await chooseWorkflow();
  return runWorkflow(choice, rootDir, positionals[0]);
}

if (isMain(import.meta.url)) {
  runCli(main);
}
