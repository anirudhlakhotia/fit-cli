import * as prompts from "@inquirer/prompts";
import { withRawTerminalWrites } from "./fit-cli-log.js";
import { ensurePromptSession, type PromptKind, type PromptResolveOptions } from "./replay.js";

type PromptContext = Parameters<typeof prompts.input>[1];
type InputConfig = Parameters<typeof prompts.input>[0];
type ConfirmConfig = Parameters<typeof prompts.confirm>[0];

/**
 * Drain any stale data buffered on stdin before a prompt starts. Between
 * prompts the terminal is in cooked mode, so a stray Enter presses during
 * long output (e.g. scrolling through test results) arrive as a buffered
 * "\n" that the next @inquirer readline interprets as an immediate Enter,
 * resolving the prompt to its default value without waiting for input.
 */
function drainStdin(): void {
  if (!process.stdin.isTTY) return;

  // Toggle raw mode to flush the terminal driver's line buffer into the
  // kernel file-descriptor buffer so we can read it all out.
  process.stdin.setRawMode(true);
  process.stdin.resume();

  // Read and discard any pending data from Node.js's internal stdin buffer.
  while (process.stdin.read() !== null) {
    // discard stale input
  }

  // Restore cooked mode — @inquirer's readline will re-enable raw mode.
  process.stdin.setRawMode(false);
}
type PasswordConfig = Parameters<typeof prompts.password>[0];
type PromptConfigWithId = { promptId: string; message: string };

export function qualifyPromptId(promptId: string, prefix?: string): string {
  return prefix ? `${prefix}.${promptId}` : promptId;
}

function firstChoiceValue<Value>(choices: readonly unknown[]): Value | undefined {
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") {
      return choice as Value;
    }
    if ("disabled" in choice && choice.disabled) {
      continue;
    }
    if ("value" in choice) {
      return choice.value as Value;
    }
  }
  return undefined;
}

function checkedChoiceValues<Value>(choices: readonly unknown[]): Value[] {
  const values: Value[] = [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object" || !("value" in choice) || !("checked" in choice)) {
      continue;
    }
    if (choice.checked) {
      values.push(choice.value as Value);
    }
  }
  return values;
}

async function ensureNonInteractiveValue<T>(
  promptId: string,
  value: T,
  validate?: (value: T) => boolean | string | Promise<string | boolean>,
): Promise<T> {
  if (!validate) {
    return value;
  }
  const result = await validate(value);
  if (result === true) {
    return value;
  }
  throw new Error(
    typeof result === "string"
      ? `Prompt ${promptId} has no usable default for non-interactive mode: ${result}. Rerun with --interactive to answer it yourself.`
      : `Prompt ${promptId} has no usable default for non-interactive mode. Rerun with --interactive to answer it yourself.`,
  );
}

function missingNonInteractiveDefault(promptId: string, detail?: string): never {
  throw new Error(
    detail
      ? `Prompt ${promptId} has no usable default for non-interactive mode: ${detail}. Rerun with --interactive to answer it yourself.`
      : `Prompt ${promptId} has no usable default for non-interactive mode. Rerun with --interactive to answer it yourself.`,
  );
}

function applyCheckboxDefaults<Value>(choices: readonly unknown[], selectedValues: readonly Value[]): readonly unknown[] {
  const selected = new Set(selectedValues);
  return choices.map((choice) => {
    if (!choice || typeof choice !== "object" || !("value" in choice)) {
      return choice;
    }

    const entry = choice as { value?: Value; checked?: boolean };
    return { ...entry, checked: entry.value !== undefined && selected.has(entry.value) };
  });
}

function runPrompt<T>(
  promptId: string,
  kind: PromptKind,
  message: string,
  prompt: (replayDefault?: T) => Promise<T>,
  options?: PromptResolveOptions<T>,
): Promise<T> {
  return ensurePromptSession().resolvePrompt(
    promptId,
    kind,
    message,
    (replayDefault) => withRawTerminalWrites(() => {
      drainStdin();
      return prompt(replayDefault);
    }),
    options,
  );
}

export function input(config: InputConfig & PromptConfigWithId, context?: PromptContext): Promise<string> {
  const { promptId, ...promptConfig } = config;
  return runPrompt(promptId, "input", config.message, (replayDefault) =>
    prompts.input({ ...promptConfig, default: replayDefault ?? promptConfig.default }, context), {
      nonInteractiveDefault: () =>
        ensureNonInteractiveValue(promptId, String(promptConfig.default ?? ""), promptConfig.validate),
    },
  );
}

export function confirm(config: ConfirmConfig & PromptConfigWithId, context?: PromptContext): Promise<boolean> {
  const { promptId, ...promptConfig } = config;
  return runPrompt(promptId, "confirm", config.message, (replayDefault) =>
    prompts.confirm({ ...promptConfig, default: replayDefault ?? promptConfig.default }, context), {
      nonInteractiveDefault: () => promptConfig.default ?? true,
    },
  );
}

export function password(
  config: PasswordConfig & PromptConfigWithId & { replay?: PromptResolveOptions<string> },
  context?: PromptContext,
): Promise<string> {
  const { promptId, replay, ...promptConfig } = config;
  return runPrompt(promptId, "password", config.message, async (replayDefault) => {
    const validate = promptConfig.validate;
    const response = await prompts.password(
      replayDefault === undefined || validate === undefined
        ? promptConfig
        : {
            ...promptConfig,
            validate: async (value) => (value.length === 0 ? true : validate(value)),
          },
      context,
    );
    return response || replayDefault || "";
  }, {
    ...replay,
    nonInteractiveDefault: () => ensureNonInteractiveValue(promptId, "", promptConfig.validate),
  });
}

export function select<Value>(
  config: {
    promptId: string;
    message: string;
    choices: readonly unknown[];
    pageSize?: number;
    loop?: boolean;
    default?: unknown;
    instructions?: { navigation: string; pager: string };
    theme?: unknown;
  },
  context?: PromptContext,
): Promise<Value> {
  const { promptId, ...promptConfig } = config;
  return runPrompt<Value>(promptId, "select", config.message, (replayDefault) =>
    prompts.select<Value>({ ...promptConfig, default: replayDefault ?? promptConfig.default } as never, context), {
      nonInteractiveDefault: () => {
        const choice = (promptConfig.default as Value | undefined) ?? firstChoiceValue<Value>(promptConfig.choices);
        return choice === undefined
          ? missingNonInteractiveDefault(promptId)
          : choice;
      },
    },
  );
}

export function search<Value>(
  config: {
    promptId: string;
    message: string;
    source: Parameters<typeof prompts.search<Value>>[0]["source"];
    validate?: (value: Value) => boolean | string | Promise<string | boolean>;
    pageSize?: number;
    instructions?: { navigation: string; pager: string };
    theme?: unknown;
    replay?: PromptResolveOptions<Value>;
  },
  context?: PromptContext,
): Promise<Value> {
  const { promptId, replay, ...promptConfig } = config;
  return runPrompt(
    promptId,
    "search",
    config.message,
    () => prompts.search<Value>(promptConfig as never, context),
    {
      ...replay,
      nonInteractiveDefault: () =>
        missingNonInteractiveDefault(
          promptId,
          "search prompts need an explicit saved answer; use --replay --defaults instead.",
        ),
    },
  );
}

export function checkbox<Value>(
  config: {
    promptId: string;
    message: string;
    choices: readonly unknown[];
    prefix?: string;
    pageSize?: number;
    instructions?: string | boolean;
    loop?: boolean;
    required?: boolean;
    validate?: (choices: readonly unknown[]) => boolean | string | Promise<string | boolean>;
    theme?: unknown;
    shortcuts?: { all?: string | null; invert?: string | null };
    replay?: PromptResolveOptions<Value[]>;
  },
  context?: PromptContext,
): Promise<Value[]> {
  const { promptId, replay, ...promptConfig } = config;
  return runPrompt(promptId, "checkbox", config.message, (replayDefault) =>
    prompts.checkbox<Value>(
      {
        ...promptConfig,
        choices:
          replayDefault !== undefined
            ? applyCheckboxDefaults(promptConfig.choices, replayDefault)
            : promptConfig.choices,
      } as never,
      context,
    ),
    {
      ...replay,
      nonInteractiveDefault: () => {
        const selected = checkedChoiceValues<Value>(promptConfig.choices);
        return selected.length > 0 || !promptConfig.required
          ? ensureNonInteractiveValue(promptId, selected, promptConfig.validate)
          : missingNonInteractiveDefault(promptId);
      },
    },
  );
}

export function number<Required extends boolean>(
  config: {
    promptId: string;
    message: string;
    default?: number;
    min?: number;
    max?: number;
    step?: number | "any";
    required?: Required;
    validate?: (
      value: Required extends true ? number : number | undefined,
    ) => boolean | string | Promise<string | boolean>;
    theme?: unknown;
  },
  context?: PromptContext,
): Promise<Required extends true ? number : number | undefined> {
  const { promptId, ...promptConfig } = config;
  return runPrompt(promptId, "number", config.message, (replayDefault) =>
    prompts.number<Required>({ ...promptConfig, default: replayDefault ?? promptConfig.default } as never, context), {
      nonInteractiveDefault: () => {
        if (promptConfig.default === undefined) {
          return missingNonInteractiveDefault(promptId);
        }
        return ensureNonInteractiveValue(
          promptId,
          promptConfig.default as Required extends true ? number : number | undefined,
          promptConfig.validate,
        );
      },
    },
  );
}
