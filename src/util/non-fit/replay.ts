import * as prompts from "@inquirer/prompts";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { inspect } from "node:util";

export type PromptKind =
  | "checkbox"
  | "confirm"
  | "input"
  | "number"
  | "password"
  | "select";

export interface PromptLogEntry {
  id: string;
  kind: PromptKind;
  message: string;
  response: unknown;
}

export interface PromptResolveOptions<T> {
  serializeResponse?: (response: T) => unknown;
  deserializeResponse?: (response: unknown) => T;
}

export interface PromptSessionHooks {
  onUnusedReplayPrompts?: (entries: readonly PromptLogEntry[]) => Promise<"continue" | "exit">;
}

interface PromptLogFile {
  version: 1;
  createdAt: string;
  workflow?: string;
  prompts: PromptLogEntry[];
}

type PromptSessionMode = "record" | "replay" | "defaults";

const RUN_ROOT_DIR = "/tmp/fit-cli";

export function extractReplayFlag(
  argv: string[],
  env?: NodeJS.ProcessEnv,
): {
  replayRequested: boolean;
  replayDefaults: boolean;
  replayFile?: string;
  positionals: string[];
} {
  env ??= process.env;
  const positionals: string[] = [];
  let replayRequested = false;
  let replayDefaults = false;
  let replayFile: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--replay") {
      replayRequested = true;
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        replayFile = next;
        i++;
      }
    } else if (arg.startsWith("--replay=")) {
      replayRequested = true;
      replayFile = arg.slice("--replay=".length);
    } else if (arg === "--defaults") {
      replayRequested = true;
      replayDefaults = true;
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        replayFile = next;
        i++;
      }
    } else if (arg.startsWith("--defaults=")) {
      replayRequested = true;
      replayDefaults = true;
      replayFile = arg.slice("--defaults=".length);
    } else {
      positionals.push(arg);
    }
  }

  const npmReplayDefaults = env.npm_lifecycle_event === "replay" ? env.npm_config_defaults : undefined;
  if (replayRequested && !replayDefaults && npmReplayDefaults !== undefined && npmReplayDefaults !== "false") {
    replayDefaults = true;
    if (!replayFile && npmReplayDefaults !== "true" && npmReplayDefaults.length > 0) {
      replayFile = npmReplayDefaults;
    }
  }

  return { replayRequested, replayDefaults, replayFile, positionals };
}

function loadPromptLog(logFile: string): PromptLogFile {
  let raw: Partial<PromptLogFile>;
  try {
    raw = JSON.parse(readFileSync(logFile, "utf8")) as Partial<PromptLogFile>;
  } catch (err) {
    throw new Error(`Could not read replay log ${logFile}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (raw.version !== 1 || !Array.isArray(raw.prompts) || typeof raw.createdAt !== "string") {
    throw new Error(`Invalid replay log file: ${logFile}`);
  }
  return {
    version: 1,
    createdAt: raw.createdAt,
    workflow: typeof raw.workflow === "string" ? raw.workflow : undefined,
    prompts: raw.prompts,
  };
}

function createRunDir(): string {
  mkdirSync(RUN_ROOT_DIR, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(RUN_ROOT_DIR, "run-"));
}

function createLogFile(runDir: string): string {
  return join(runDir, `fit-cli-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`);
}

function formatReplayResponse(kind: PromptKind, response: unknown): string {
  if (kind === "password") {
    return "[hidden]";
  }
  if (typeof response === "string") {
    return JSON.stringify(response);
  }
  return inspect(response, { depth: null, breakLength: Infinity });
}

export class PromptSession {
  private replayIndex = 0;
  private readonly usedPromptIds = new Set<string>();

  private constructor(
    private readonly mode: PromptSessionMode,
    public readonly runDir: string,
    public readonly logFile: string,
    private readonly createdAt: string,
    private workflow: string | undefined,
    private readonly prompts: PromptLogEntry[],
    private readonly hooks: PromptSessionHooks,
  ) {}

  static fromArgv(argv: string[], hooks: PromptSessionHooks = {}): PromptSession {
    const { replayRequested, replayDefaults, replayFile } = extractReplayFlag(argv);
    const runDir = createRunDir();
    if (replayRequested && !replayFile) {
      throw new Error(
        "Missing replay log file. Usage: npm run replay <logfile> or npm run replay --defaults <logfile>",
      );
    }
    if (replayFile) {
      const resolved = isAbsolute(replayFile) ? replayFile : resolve(process.cwd(), replayFile);
      const log = loadPromptLog(resolved);
      console.log(`ARTIFACT_DIR: ${runDir}`);
      console.log(
        `${replayDefaults ? "Replaying prompt log as defaults" : "Replaying prompt log"}: ${resolved}\n`,
      );
      return new PromptSession(
        replayDefaults ? "defaults" : "replay",
        runDir,
        resolved,
        log.createdAt,
        log.workflow,
        log.prompts,
        hooks,
      );
    }

    const logFile = createLogFile(runDir);
    const createdAt = new Date().toISOString();
    const session = new PromptSession("record", runDir, logFile, createdAt, undefined, [], hooks);
    session.persist();
    console.log(`ARTIFACT_DIR: ${runDir}`);
    console.log(`Prompt log: ${logFile}\n`);
    return session;
  }

  getWorkflow(): string | undefined {
    return this.workflow;
  }

  replaysStoredWorkflow(): boolean {
    return this.mode === "replay";
  }

  setWorkflow(workflow: string): void {
    this.workflow = workflow;
    if (this.mode === "record") {
      this.persist();
    }
  }

  consumeLegacyWorkflowPrompt(workflow: string): void {
    if (this.mode !== "replay") {
      return;
    }

    const entry = this.prompts[this.replayIndex];
    if (entry?.kind === "select" && entry.response === workflow) {
      this.replayIndex++;
    }
  }

  async finishReplay(): Promise<void> {
    if (this.mode === "record") {
      return;
    }

    if (this.mode === "defaults") {
      await this.handleUnusedReplayPrompts(this.prompts.filter((entry) => !this.usedPromptIds.has(entry.id)));
      return;
    }

    if (this.replayIndex >= this.prompts.length) {
      return;
    }

    await this.handleUnusedReplayPrompts(this.prompts.slice(this.replayIndex));
    this.replayIndex = this.prompts.length;
  }

  formatReplayReminder(): string | undefined {
    if (this.mode !== "record") {
      return undefined;
    }
    return [
      "Prompt replay:",
      `  Log file: ${this.logFile}`,
      `  Replay: npm run replay ${this.logFile}`,
      `  Replay with defaults: npm run replay --defaults ${this.logFile}`,
    ].join("\n");
  }

  formatRunReminder(): string {
    return ["Run files:", `  ARTIFACT_DIR: ${this.runDir}`].join("\n");
  }

  async resolvePrompt<T>(
    id: string,
    kind: PromptKind,
    message: string,
    prompt: (replayDefault?: T) => Promise<T>,
    options: PromptResolveOptions<T> = {},
  ): Promise<T> {
    if (this.usedPromptIds.has(id)) {
      throw new Error(`Prompt id ${id} was used more than once in this run.`);
    }
    this.usedPromptIds.add(id);

    if (this.mode === "defaults") {
      const entry = this.findPromptById(id);
      if (!entry) {
        console.log(`[${this.replayLabel()}] No saved answer for ${id}; asking now.`);
        return prompt();
      }
      if (entry.kind !== kind) {
        console.log(`[${this.replayLabel()}] Saved answer for ${id} was recorded as ${entry.kind}, but the code now expects ${kind}. Asking now.`);
        return prompt();
      }
      const response = options.deserializeResponse ? options.deserializeResponse(entry.response) : (entry.response as T);
      console.log(`[${this.replayLabel()}] ${message}\n  -> ${formatReplayResponse(kind, entry.response)}`);
      return prompt(response);
    }

    if (this.mode === "replay") {
      const replayMatchIndex = this.findReplayPromptIndex(id);
      if (replayMatchIndex === undefined) {
        if (this.replayIndex < this.prompts.length) {
          await this.handleUnusedReplayPrompts(this.prompts.slice(this.replayIndex));
          this.replayIndex = this.prompts.length;
        }
        console.log(`[${this.replayLabel()}] No saved answer for ${id}; asking now.`);
        return prompt();
      }

      if (replayMatchIndex > this.replayIndex) {
        await this.handleUnusedReplayPrompts(this.prompts.slice(this.replayIndex, replayMatchIndex));
        this.replayIndex = replayMatchIndex;
      }

      const entry = this.prompts[this.replayIndex];
      if (!entry || entry.id !== id) {
        throw new Error(`Replay state error while resolving ${id}.`);
      }
      this.replayIndex++;

      if (entry.kind !== kind) {
        console.log(`[${this.replayLabel()}] Saved answer for ${id} was recorded as ${entry.kind}, but the code now expects ${kind}. Asking now.`);
        return prompt();
      }
      const response = options.deserializeResponse ? options.deserializeResponse(entry.response) : (entry.response as T);
      console.log(
        `[${this.replayLabel()}] ${message}\n  -> ${formatReplayResponse(kind, entry.response)}`,
      );
      return response;
    }

    const response = await prompt();
    this.prompts.push({
      id,
      kind,
      message,
      response: options.serializeResponse ? options.serializeResponse(response) : response,
    });
    this.persist();
    return response;
  }

  private findReplayPromptIndex(id: string): number | undefined {
    for (let index = this.replayIndex; index < this.prompts.length; index++) {
      if (this.prompts[index]?.id === id) {
        return index;
      }
    }
    return undefined;
  }

  private findPromptById(id: string): PromptLogEntry | undefined {
    return this.prompts.find((entry) => entry.id === id);
  }

  private replayLabel(): "replay" | "replay defaults" {
    return this.mode === "defaults" ? "replay defaults" : "replay";
  }

  private async handleUnusedReplayPrompts(entries: readonly PromptLogEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const action = this.hooks.onUnusedReplayPrompts
      ? await this.hooks.onUnusedReplayPrompts(entries)
      : await prompts.select<"continue" | "exit">({
          message:
            entries.length === 1
              ? `Replay log contains a saved answer for ${entries[0].id} that is no longer used. What do you want to do?`
              : `Replay log contains ${entries.length} saved answers that are no longer used. What do you want to do?`,
          choices: [
            { name: "Ignore them and continue", value: "continue" },
            { name: "Stop replay so I can review the log", value: "exit" },
          ],
        });

    if (action === "exit") {
      throw new Error("Replay stopped because the log contains answers for prompts that are no longer used.");
    }
  }

  private persist(): void {
    writeFileSync(
      this.logFile,
      `${JSON.stringify(
        { version: 1, createdAt: this.createdAt, workflow: this.workflow, prompts: this.prompts },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }
}

let activePromptSession: PromptSession | undefined;

export function ensurePromptSession(argv: string[] = process.argv.slice(2)): PromptSession {
  if (!activePromptSession) {
    activePromptSession = PromptSession.fromArgv(argv);
  }
  return activePromptSession;
}

export function ensureRunDir(argv: string[] = process.argv.slice(2)): string {
  return ensurePromptSession(argv).runDir;
}
