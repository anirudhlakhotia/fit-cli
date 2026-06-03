/**
 * Step: write the generated FITConfiguration.json to a fresh file under
 * /tmp/fit-cli so test-driver can consume it via `-Dfit.config=<path>`.
 *
 * Run on its own (dry run — reports where a fresh file would be written):
 *   npx tsx src/workflows/fit-functional/steps/write-fit-configuration.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { FIT_PERFORMER, repoPath } from "../../../util/fit/repos.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";

const FIT_CONFIG_DIR = "/tmp/fit-cli";

/** Absolute path to a fresh FITConfiguration.json under /tmp/fit-cli. */
export function fitConfigPath(): string {
  return join(FIT_CONFIG_DIR, `FITConfiguration-${timestamp()}.json`);
}

/** Absolute path to the FITConfiguration.md reference doc, under ROOT_DIR. */
export function fitConfigDocPath(rootDir: string): string {
  return join(repoPath(FIT_PERFORMER, rootDir), "test-driver", "FITConfiguration.md");
}

/** A filesystem-safe timestamp like 2026-06-03T12-34-56-789Z. */
function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export interface WriteResult {
  /** Where the config was written. */
  path: string;
}

/** Write `config` to a fresh file under /tmp/fit-cli and return its path. */
export function writeFitConfiguration(config: Record<string, unknown>): WriteResult {
  mkdirSync(FIT_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const path = fitConfigPath();
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return { path };
}

if (isMain(import.meta.url)) {
  runCli(() => {
    rootDirFromArgv(process.argv.slice(2));
    console.log(`A generated config would be written to a fresh file like:\n${fitConfigPath()}`);
    return Promise.resolve();
  });
}
