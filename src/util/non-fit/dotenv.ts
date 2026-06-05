/**
 * dotenv — a tiny `.env` loader, so we don't take a dependency just to read a
 * handful of `KEY=VALUE` lines into the environment. Pure parsing
 * (`parseDotenv`) is separated from the IO (`loadDotenv`) so it can be unit
 * tested (see tests/dotenv.test.ts).
 *
 * Run on its own (loads ./.env and prints which keys it would set):
 *   npx tsx src/util/non-fit/dotenv.ts
 *   npx tsx src/util/non-fit/dotenv.ts path/to/.env
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMain, runCli } from "./cli.js";

/**
 * Parse `.env` file contents into a plain object. Blank lines and `#` comments
 * are ignored; each remaining line is split on its first `=`. An optional
 * leading `export ` is dropped, keys and values are trimmed, and a value fully
 * wrapped in matching single or double quotes is unquoted. Lines without an `=`
 * are skipped rather than throwing, so a stray line can't break a whole file.
 */
export function parseDotenv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length) : line;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = withoutExport.slice(0, eq).trim();
    if (key === "") {
      continue;
    }
    let value = withoutExport.slice(eq + 1).trim();
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/** The outcome of trying to load a `.env` file. */
export interface DotenvResult {
  /** Whether the file existed and was read. */
  loaded: boolean;
  /** Absolute path we looked at. */
  path: string;
  /** Keys that were set into the environment (already-set keys are left alone). */
  applied: string[];
}

/**
 * Load a `.env` file (default `./.env`) into `process.env`. Variables that are
 * already set in the environment win and are left untouched, so real exported
 * credentials and CI-injected values take precedence over the file. Returns what
 * happened; a missing file is not an error (`loaded: false`).
 */
export function loadDotenv(path: string = resolve(process.cwd(), ".env")): DotenvResult {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    return { loaded: false, path: absolute, applied: [] };
  }
  const parsed = parseDotenv(readFileSync(absolute, "utf8"));
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return { loaded: true, path: absolute, applied };
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const path = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
    const result = loadDotenv(path);
    if (!result.loaded) {
      console.log(`No .env file at ${result.path}`);
      return Promise.resolve();
    }
    console.log(`Loaded ${result.path}`);
    console.log(result.applied.length ? `Set: ${result.applied.join(", ")}` : "Nothing new to set (all keys already in env).");
    return Promise.resolve();
  });
}
