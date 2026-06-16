#!/usr/bin/env node
/**
 * The FIT CLI wizard. This file only presents the top-level menu and hands off
 * to a definition-focused flow. Each flow lives in its own directory and can be
 * run on its own for debugging — see the header of its entrypoint.
 */
import { existsSync } from "node:fs";
import { type RunOutput } from "../../util/non-fit/artifacts.js";
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { loadDotenv } from "../../util/non-fit/dotenv.js";
import { input, select } from "../../util/non-fit/prompts.js";
import { ensurePromptSession, type PromptSession } from "../../util/non-fit/replay.js";
import { createFitDefinition } from "../shared/create-definition/create-definition.js";
import { resolveOutputFormat } from "../util/config.js";
import { rootDirFromArgv } from "../util/root.js";
import { runFromDefinition } from "../functional/run-from-definition/run-from-definition.js";
import type { DefinitionFormat } from "../shared/definition/generate-definition.js";
import { extractPushGistVisibility, type GistVisibility } from "../shared/definition/push-gist.js";
import { definitionDispatch } from "../definition/definition.js";

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

export async function runWorkflow(choice: WorkflowChoice, rootDir: string, definitionPath?: string, format?: DefinitionFormat, pushGistVisibility?: GistVisibility): Promise<RunOutput> {
  switch (choice) {
    case "create-definition":
      return createFitDefinition(rootDir, { format, pushGistVisibility });
    case "run-definition":
      return runFromDefinition(definitionPath ?? await askDefinitionPath(), rootDir);
  }
}

function extractOutputFormat(argv: readonly string[]): { format: DefinitionFormat; positionals: string[] } {
  const positionals: string[] = [];
  // Undefined until an explicit --output is seen; the config's output.format (then
  // the baked-in default) supplies the fallback below.
  let format: DefinitionFormat | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output") {
      const value = argv[i + 1];
      if (value !== "yaml" && value !== "json5") {
        throw new Error(`--output must be "yaml" or "json5"; got "${value ?? ""}"`);
      }
      format = value;
      i++;
    } else if (arg.startsWith("--output=")) {
      const value = arg.slice("--output=".length);
      if (value !== "yaml" && value !== "json5") {
        throw new Error(`--output must be "yaml" or "json5"; got "${value}"`);
      }
      format = value;
    } else {
      positionals.push(arg);
    }
  }
  return { format: format ?? resolveOutputFormat(), positionals };
}

function checkPlatform(): void {
  const platform = process.platform;
  if (platform === "win32") {
    console.error("FIT CLI does not support Windows. Please use Linux or macOS.");
    process.exit(1);
  }
  if (platform === "darwin") {
    console.warn(
      "╔══════════════════════════════════════════════════════════════════╗\n" +
      "║  WARNING: FIT CLI has not been tested on macOS.                  ║\n" +
      "║  Things may not work as expected. Contributions are welcome!     ║\n" +
      "╚══════════════════════════════════════════════════════════════════╝\n",
    );
  }
}

export async function main(): Promise<RunOutput> {
  checkPlatform();

  // Route `fit definition [...]` and `fit run definition [...]` directly to the
  // definition dispatcher, bypassing the wizard. This lets `--output <path>`
  // (a file path, used by generate-preset) reach the right parser instead of
  // being intercepted by the wizard's `--output yaml|json5` format flag below.
  const rawArgs = process.argv.slice(2);
  let definitionArgs: string[] | undefined;
  if (rawArgs[0] === "definition") {
    definitionArgs = rawArgs.slice(1);
  } else if (rawArgs[0] === "run" && rawArgs[1] === "definition") {
    definitionArgs = rawArgs.slice(2);
  }
  if (definitionArgs !== undefined) {
    loadDotenv();
    return (await definitionDispatch(definitionArgs)) ?? {};
  }

  console.log("FIT CLI — making FIT easier to use, one vibe-coding session at a time.\n");
  console.log(
    "This wizard guides you through building a FIT definition file — a single, reusable\n" +
      "description of the FIT tests you want to run: functional, situational, performance,\n" +
      "or a mix. Once you have a definition file you can:\n" +
      "  • test it locally on this machine for a fast inner loop,\n" +
      "  • test it the way CI will, on a clean cloud (EC2) instance, and\n" +
      "  • hand the file straight to CI to run there.\n",
  );

  // Load any .env so secrets like the hosted results-DB password are available
  // without being passed on the command line. Real exported vars still win.
  loadDotenv();

  const { format, positionals: afterOutput } = extractOutputFormat(process.argv.slice(2));
  const { rootDir, positionals: afterRoot } = rootDirFromArgv(afterOutput);
  const pushGistVisibility = extractPushGistVisibility(afterRoot);
  // Remove --push-gist (and its optional value) from positionals so the length
  // check and definition-path detection below work cleanly.
  const positionals = afterRoot.filter((arg, i) => {
    if (arg === "--push-gist") return false;
    if (arg === "public" || arg === "private") {
      return afterRoot[i - 1] !== "--push-gist";
    }
    if (arg.startsWith("--push-gist=")) return false;
    return true;
  });
  if (positionals.length > 1) {
    throw new Error("Usage: bun start [definition-file.json5] [--output yaml|json5] [--push-gist [public|private]] [--root <dir>]");
  }
  if (positionals[0]) {
    ensurePromptSession().setWorkflow("run-definition");
    return runFromDefinition(positionals[0], rootDir);
  }
  const choice = await chooseWorkflow();
  return runWorkflow(choice, rootDir, positionals[0], format, pushGistVisibility);
}

// import.meta.main is true in compiled Bun binaries where isMain() can't
// compare virtual /$bunfs/ paths against the real executable path.
if (isMain(import.meta.url) || import.meta.main) {
  runCli(main);
}
