/**
 * ROOT_DIR — the directory everything file-based is resolved against. The FIT
 * repos (transactions-fit-performer, couchbase-jvm-clients) live directly under
 * it, and other workspace-relative paths are resolved from it.
 *
 * Resolution order:
 *   1. --root <dir> / --root=<dir> / -r <dir> on the command line
 *   2. the FIT_ROOT environment variable
 *   3. the parent of the current working directory (process.cwd()/..)
 *
 * The default is the parent of the cwd so that running the tool from inside the
 * fit-cli checkout finds the repos as siblings (../transactions-fit-performer),
 * which is the usual layout. Override it to point fit-cli at a different
 * workspace.
 *
 * Note this governs the workspace repos only — the local Maven repo (~/.m2) and
 * the per-run temp files under /tmp/fit-cli are global locations and are not
 * relative to ROOT_DIR.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { extractInteractiveFlag, extractReplayFlag } from "../non-fit/replay.js";

/**
 * Resolve `override` (or the default) to an absolute ROOT_DIR and check it's a
 * real directory. `override` is typically a --root flag or the FIT_ROOT env var;
 * when undefined the default is process.cwd()/.. . Throws if the resolved path
 * does not exist or is not a directory, so a bad --root fails fast and clearly.
 */
export function resolveRootDir(override?: string): string {
  const raw = override ?? process.env.FIT_ROOT;
  const rootDir = raw
    ? isAbsolute(raw)
      ? raw
      : resolve(process.cwd(), raw)
    : resolve(process.cwd(), "..");

  if (!existsSync(rootDir)) {
    throw new Error(`ROOT_DIR does not exist: ${rootDir}`);
  }
  if (!statSync(rootDir).isDirectory()) {
    throw new Error(`ROOT_DIR is not a directory: ${rootDir}`);
  }
  return rootDir;
}

/**
 * Pull a --root / --port-style root flag out of `argv` and return it alongside
 * the remaining positional arguments. Supports `--root <dir>`, `--root=<dir>`,
 * `-r <dir>` and `-r=<dir>`. Pass process.argv.slice(2).
 */
export function extractRootFlag(argv: string[]): { override?: string; positionals: string[] } {
  const { positionals: replayArgs } = extractReplayFlag(argv);
  const { positionals: args } = extractInteractiveFlag(replayArgs);
  const positionals: string[] = [];
  let override: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--root" || arg === "-r") {
      override = args[++i];
    } else if (arg.startsWith("--root=")) {
      override = arg.slice("--root=".length);
    } else if (arg.startsWith("-r=")) {
      override = arg.slice("-r=".length);
    } else {
      positionals.push(arg);
    }
  }

  return { override, positionals };
}

/**
 * CLI entry-point helper: parse `argv` for a --root flag, resolve ROOT_DIR, and
 * announce it so it's always clear where fit-cli is looking. Used by the wizard
 * and by each step's standalone CLI; library/step functions instead take an
 * explicit `rootDir`. Pass process.argv.slice(2).
 */
export function rootDirFromArgv(argv: string[]): { rootDir: string; positionals: string[] } {
  const { override, positionals } = extractRootFlag(argv);
  const rootDir = resolveRootDir(override);
  console.log(
    `Using ROOT_DIR: ${rootDir}\nOverride with --root <dir>, -r <dir>, or FIT_ROOT=/path.\n`,
  );
  return { rootDir, positionals };
}
