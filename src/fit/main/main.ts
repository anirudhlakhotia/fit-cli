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
import { runDefinitionMain } from "../definition/definition.js";
import { runArchiveMain } from "../archive/archive.js";
import { runConfigMain } from "../config/config.js";
import { runEditWorkflow } from "../config/edit.js";
import { defaultFitCliConfigPath } from "../util/config.js";
import { runCloudInstancesMain } from "../../cloud/cloud-instances/cloud-instances.js";
import { runSecretsMain } from "../../cloud/util/aws/secrets-cli.js";
import { printVersion } from "../version/version.js";
import { main as replayMain } from "../../util/non-fit/replay-entry.js";
import { printLogo } from "./logo.js";

const WORKFLOW_PROMPT_MESSAGE = "What would you like to do?";

const WORKFLOW_CHOICES = [
  { name: "Build a FIT definition file", value: "create-definition" },
  { name: "Run a FIT definition file", value: "run-definition" },
  { name: "Configure fit-cli", value: "configure" },
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
    choices: readonly { name: string; value: WorkflowChoice }[];
    default?: WorkflowChoice;
  }) => Promise<WorkflowChoice> = select,
  configMissing: boolean = !existsSync(defaultFitCliConfigPath()),
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

  const choices = configMissing
    ? ([
        { name: "Build a FIT definition file", value: "create-definition" },
        { name: "Run a FIT definition file", value: "run-definition" },
        { name: "Configure fit-cli (recommended)", value: "configure" },
      ] as const)
    : WORKFLOW_CHOICES;

  // Note - only very high-level workflows should go here. We don't want an overwhelming list of options at the top level.
  // Users can run smaller workflows and steps for debugging or development through the mini cli tools.
  const choice = await selectWorkflow({
    promptId: WORKFLOW_PROMPT_ID,
    message: WORKFLOW_PROMPT_MESSAGE,
    choices,
    default: replayWorkflow ?? (configMissing ? "configure" : undefined),
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
    case "configure":
      await runEditWorkflow();
      return { artifacts: [], details: [] };
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

}

async function runWizard(): Promise<RunOutput> {
  checkPlatform();

  printLogo("making FIT easier to use, one vibe-coding session at a time.");
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
  // check below works cleanly.
  const positionals = afterRoot.filter((arg, i) => {
    if (arg === "--push-gist") return false;
    if (arg === "public" || arg === "private") {
      return afterRoot[i - 1] !== "--push-gist";
    }
    if (arg.startsWith("--push-gist=")) return false;
    return true;
  });
  if (positionals.length > 0) {
    throw new Error("Usage: fit wizard [--output yaml|json5] [--push-gist [public|private]] [--root <dir>]");
  }
  const choice = await chooseWorkflow();
  return runWorkflow(choice, rootDir, undefined, format, pushGistVisibility);
}

function runWizardMain(): void {
  runCli(runWizard);
}

function runReplayMain(): void {
  replayMain(["--replay", ...process.argv.slice(2)]);
}

function printHelp(): void {
  console.log(
    "fit — FIT CLI\n\n" +
    "Usage: fit [command] [...args]\n\n" +
    "Commands:\n" +
    "  wizard           Interactive walkthrough (default when no command given)\n" +
    "  definition       Run or validate a FIT definition file\n" +
    "  config           Manage fit-cli configuration\n" +
    "  cloud-instances  Manage cloud (EC2) instances\n" +
    "  secrets          Manage AWS secrets\n" +
    "  archive          Archive run artifacts\n" +
    "  replay           Replay a recorded session\n" +
    "  version          Print the fit-cli version\n" +
    "  help             Print this help message\n"
  );
}

// Single source of truth for all top-level commands.
// Anything listed here is available as both `fit <cmd>` and `bun run <cmd>`.
const COMMANDS: Record<string, (() => void)> = {
  "wizard": runWizardMain,
  "definition": runDefinitionMain,
  "config": runConfigMain,
  "cloud-instances": runCloudInstancesMain,
  "secrets": runSecretsMain,
  "archive": runArchiveMain,
  "replay": runReplayMain,
  "version": printVersion,
  "help": printHelp,
};

// import.meta.main is true in compiled Bun binaries where isMain() can't
// compare virtual /$bunfs/ paths against the real executable path.
if (isMain(import.meta.url) || import.meta.main) {
  const cmd = process.argv[2];

  // Resolve the command, with backward-compat support for `fit run <cmd>`.
  let command: (() => void) | undefined;
  let argsToRemove = 0;
  if (cmd === "run" && COMMANDS[process.argv[3]]) {
    command = COMMANDS[process.argv[3]];
    argsToRemove = 2;
  } else if (cmd && COMMANDS[cmd]) {
    command = COMMANDS[cmd];
    argsToRemove = 1;
  }

  if (command) {
    process.argv.splice(2, argsToRemove);
    command();
  } else if (!cmd || cmd.startsWith("-")) {
    // bare `fit` or flags only → wizard
    runCli(runWizard);
  } else {
    console.error(`Unknown command: ${cmd}\nRun 'fit help' for usage.`);
    process.exit(1);
  }
}
