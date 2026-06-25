/**
 * A custom @inquirer/core prompt that behaves like the stock `input` prompt
 * but adds filesystem path tab-completion.
 *
 * Tab behaviour (mirrors bash):
 *  - Empty value + default present → fill default (stock input behaviour).
 *  - Single match → complete it (trailing `/` for directories).
 *  - Multiple matches → extend to the longest common prefix and show candidates.
 *  - No match → do nothing.
 *  - Dotfiles are hidden unless the typed partial itself starts with `.`.
 *
 * Run on their own:
 *   bun src/util/non-fit/path-input.ts
 */
import {
  createPrompt,
  isBackspaceKey,
  isEnterKey,
  isTabKey,
  makeTheme,
  type Status,
  useEffect,
  useKeypress,
  usePrefix,
  useState,
} from "@inquirer/core";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";

// ─── Pure completion logic (unit-testable, no FS) ────────────────────────────

export interface DirEntry {
  name: string;
  isDir: boolean;
}

export interface CompletionResult {
  /** The longest common prefix of all matching names (may equal `partial`). */
  prefix: string;
  /** Matching names — dirs have a trailing `/`. */
  candidates: string[];
}

/**
 * Compute path completions from a directory listing and the current partial
 * name being typed (the part after the last `/`).
 *
 * - Dotfiles are hidden unless `partial` starts with `.`.
 * - Directory entries get a trailing `/` so the next Tab can descend.
 */
export function computePathCompletions(entries: DirEntry[], partial: string): CompletionResult {
  const showDotfiles = partial.startsWith(".");
  const candidates = entries
    .filter((e) => e.name.startsWith(partial) && (showDotfiles || !e.name.startsWith(".")))
    .map((e) => (e.isDir ? e.name + "/" : e.name));

  if (candidates.length === 0) {
    return { prefix: partial, candidates: [] };
  }

  const prefix = longestCommonPrefix(candidates);
  return { prefix, candidates };
}

function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return "";
  let prefix = strs[0];
  for (let i = 1; i < strs.length; i++) {
    while (!strs[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

// ─── FS-layer: resolve completions for a typed value ─────────────────────────

function expandTilde(value: string): string {
  if (value === "~" || value.startsWith("~/")) {
    return homedir() + value.slice(1);
  }
  return value;
}

interface ResolvedCompletions {
  /** The new full value to put in the input (dir part + completed name). */
  newValue: string;
  /** Full paths of all candidates (empty when there's a single unambiguous match). */
  candidates: string[];
}

export function resolveCompletions(rawValue: string): ResolvedCompletions | null {
  const value = expandTilde(rawValue);

  let dir: string;
  let partial: string;
  if (value === "" || value.endsWith("/")) {
    dir = value === "" ? "." : value;
    partial = "";
  } else {
    dir = dirname(value);
    partial = basename(value);
  }

  let dirEntries: DirEntry[];
  try {
    const raw = readdirSync(dir, { withFileTypes: true });
    dirEntries = raw.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return null;
  }

  const { prefix, candidates } = computePathCompletions(dirEntries, partial);
  if (candidates.length === 0) return null;

  const completedDir = dir === "." ? "" : dir.endsWith("/") ? dir : dir + "/";
  const newValue = completedDir + prefix;

  return {
    newValue,
    candidates: candidates.length === 1 ? [] : candidates.map((c) => completedDir + c),
  };
}

// ─── Custom prompt ────────────────────────────────────────────────────────────

const pathInputTheme = { validationFailureMode: "keep" as const };

export interface PathInputConfig {
  message: string;
  default?: string;
  validate?: (value: string) => boolean | string | Promise<string | boolean>;
  transformer?: (value: string, meta: { isFinal: boolean }) => string;
  prefill?: "tab" | "editable";
  theme?: Parameters<typeof makeTheme>[1];
}

export const pathInputPrompt = createPrompt<string, PathInputConfig>((config, done) => {
  const { prefill = "tab" } = config;
  const theme = makeTheme(pathInputTheme, config.theme);
  const [status, setStatus] = useState<Status>("idle");
  const [defaultValue = "", setDefaultValue] = useState(config.default);
  const [errorMsg, setError] = useState<string | undefined>();
  const [value, setValue] = useState("");
  const [candidates, setCandidates] = useState<string[]>([]);
  const prefix = usePrefix({ status, theme });

  async function validate(v: string): Promise<true | string> {
    if (typeof config.validate === "function") {
      const result = await config.validate(v);
      if (result !== true) return typeof result === "string" ? result : "Invalid value";
    }
    return true;
  }

  useKeypress(async (key, rl) => {
    if (status !== "idle") return;

    if (isEnterKey(key)) {
      const answer = value || defaultValue;
      setStatus("loading");
      const isValid = await validate(answer);
      if (isValid === true) {
        setValue(answer);
        setStatus("done");
        setCandidates([]);
        done(answer);
      } else {
        rl.write(value);
        setError(isValid);
        setStatus("idle");
      }
      return;
    }

    if (isBackspaceKey(key) && !value) {
      setDefaultValue(undefined);
      setCandidates([]);
      return;
    }

    if (isTabKey(key)) {
      if (!value && defaultValue) {
        // Stock behaviour: Tab on empty fills the default.
        rl.clearLine(0);
        rl.write(defaultValue);
        setValue(defaultValue);
        setCandidates([]);
        return;
      }

      // Path completion on whatever is currently typed.
      const result = resolveCompletions(value || "");
      if (result) {
        rl.clearLine(0);
        rl.write(result.newValue);
        setValue(result.newValue);
        setCandidates(result.candidates);
      }
      // No match: leave the line untouched.
      return;
    }

    // Any other key: update value and clear candidate list.
    setValue(rl.line);
    setError(undefined);
    setCandidates([]);
  });

  useEffect((rl) => {
    if (prefill === "editable" && defaultValue) {
      rl.write(defaultValue);
      setValue(defaultValue);
    }
  }, []);

  const message = theme.style.message(config.message, status);
  let formattedValue = value;
  if (typeof config.transformer === "function") {
    formattedValue = config.transformer(value, { isFinal: status === "done" });
  } else if (status === "done") {
    formattedValue = theme.style.answer(value);
  }

  let defaultStr: string | undefined;
  if (defaultValue && status !== "done" && !value) {
    defaultStr = theme.style.defaultAnswer(defaultValue);
  }

  const error = errorMsg ? theme.style.error(errorMsg) : "";

  let candidatesLine = "";
  if (candidates.length > 1) {
    candidatesLine = "\n" + candidates.join("  ");
  }

  return [
    [prefix, message, defaultStr, formattedValue].filter((v) => v !== undefined).join(" "),
    error + candidatesLine,
  ];
});

// ─── Mini CLI (for manual testing) ───────────────────────────────────────────

if (import.meta.main) {
  const result = await pathInputPrompt({
    message: "Path:",
    default: process.env.HOME,
  });
  console.log(`\nYou entered: ${result}`);
}
