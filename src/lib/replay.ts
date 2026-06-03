import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

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

interface PromptLogFile {
  version: 1;
  createdAt: string;
  prompts: PromptLogEntry[];
}

const LOG_DIR = "/tmp/fit-cli";

export function extractReplayFlag(argv: string[]): {
  replayRequested: boolean;
  replayFile?: string;
  positionals: string[];
} {
  const positionals: string[] = [];
  let replayRequested = false;
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
    } else {
      positionals.push(arg);
    }
  }

  return { replayRequested, replayFile, positionals };
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
  return { version: 1, createdAt: raw.createdAt, prompts: raw.prompts };
}

function createLogFile(): string {
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  return `${LOG_DIR}/fit-cli-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`;
}

export class PromptSession {
  private nextPromptNumber = 1;
  private replayIndex = 0;

  private constructor(
    private readonly mode: "record" | "replay",
    public readonly logFile: string,
    private readonly createdAt: string,
    private readonly prompts: PromptLogEntry[],
  ) {}

  static fromArgv(argv: string[]): PromptSession {
    const { replayRequested, replayFile } = extractReplayFlag(argv);
    if (replayRequested && !replayFile) {
      throw new Error("Missing replay log file. Usage: npm run replay <logfile>");
    }
    if (replayFile) {
      const resolved = isAbsolute(replayFile) ? replayFile : resolve(process.cwd(), replayFile);
      const log = loadPromptLog(resolved);
      console.log(`Replaying prompt log: ${resolved}\n`);
      return new PromptSession("replay", resolved, log.createdAt, log.prompts);
    }

    const logFile = createLogFile();
    const createdAt = new Date().toISOString();
    const session = new PromptSession("record", logFile, createdAt, []);
    session.persist();
    console.log(`Prompt log: ${logFile}\n`);
    return session;
  }

  async resolvePrompt<T>(kind: PromptKind, message: string, prompt: () => Promise<T>): Promise<T> {
    const id = `prompt-${this.nextPromptNumber++}`;

    if (this.mode === "replay") {
      const entry = this.prompts[this.replayIndex++];
      if (!entry) {
        throw new Error(`Replay log ended before ${id} (${message})`);
      }
      if (entry.id !== id || entry.kind !== kind || entry.message !== message) {
        throw new Error(
          `Replay log mismatch at ${id}: expected ${kind} "${message}", got ${entry.kind} "${entry.message}"`,
        );
      }
      console.log(`[replay] ${message}`);
      return entry.response as T;
    }

    const response = await prompt();
    this.prompts.push({ id, kind, message, response });
    this.persist();
    return response;
  }

  private persist(): void {
    writeFileSync(
      this.logFile,
      `${JSON.stringify({ version: 1, createdAt: this.createdAt, prompts: this.prompts }, null, 2)}\n`,
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
