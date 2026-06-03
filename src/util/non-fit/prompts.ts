import * as prompts from "@inquirer/prompts";
import { ensurePromptSession, type PromptKind, type PromptResolveOptions } from "./replay.js";

type PromptContext = Parameters<typeof prompts.input>[1];
type InputConfig = Parameters<typeof prompts.input>[0];
type ConfirmConfig = Parameters<typeof prompts.confirm>[0];
type PasswordConfig = Parameters<typeof prompts.password>[0];

function runPrompt<T>(
  kind: PromptKind,
  message: string,
  prompt: () => Promise<T>,
  options?: PromptResolveOptions<T>,
): Promise<T> {
  return ensurePromptSession().resolvePrompt(kind, message, prompt, options);
}

export function input(config: InputConfig, context?: PromptContext): Promise<string> {
  return runPrompt("input", config.message, () => prompts.input(config, context));
}

export function confirm(config: ConfirmConfig, context?: PromptContext): Promise<boolean> {
  return runPrompt("confirm", config.message, () => prompts.confirm(config, context));
}

export function password(config: PasswordConfig, context?: PromptContext): Promise<string> {
  return runPrompt("password", config.message, () => prompts.password(config, context));
}

export function select<Value>(
  config: {
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
  return runPrompt("select", config.message, () =>
    prompts.select<Value>(config as never, context),
  );
}

export function checkbox<Value>(
  config: {
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
  const { replay, ...promptConfig } = config;
  return runPrompt("checkbox", config.message, () =>
    prompts.checkbox<Value>(promptConfig as never, context),
    replay,
  );
}

export function number<Required extends boolean>(
  config: {
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
  return runPrompt("number", config.message, () =>
    prompts.number<Required>(config as never, context),
  );
}
