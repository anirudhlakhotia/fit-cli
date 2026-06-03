/**
 * Test overrides for the environment checks the steps make. Every "does this
 * path exist?" / "is this build stale?" question goes through here, so while
 * developing a step you can pretend a different answer and exercise each branch
 * without touching the real filesystem.
 *
 * Drive it with env vars holding comma-separated check keys. They work both in
 * the full wizard and when running a single step on its own, e.g.:
 *
 *   # pretend fit-grpc isn't built, to test the "build FIT" branch
 *   FIT_CLI_PRETEND_MISSING=fit-grpc npx tsx src/workflows/fit-functional/steps/ensure-fit-grpc.ts
 *
 *   # pretend a missing repo is present, to skip past the clone branch
 *   FIT_CLI_PRETEND_PRESENT=jvm-clients npx tsx src/steps/ensure-repo.ts jvm-clients
 *
 *   # pretend a present fit-grpc build is over a month old, to test the rebuild prompt
 *   FIT_CLI_PRETEND_STALE=fit-grpc npx tsx src/workflows/fit-functional/steps/ensure-fit-grpc.ts
 *
 * Check keys currently in use:
 *   fit-performer, jvm-clients   ensureRepo (repoExists)
 *   fit-grpc                     ensureFitGrpc (presence + staleness)
 *   performer                    checkPerformer
 */
import { existsSync } from "node:fs";

/** Parse a comma-separated env var into a set of trimmed, non-empty keys. */
function envKeys(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter(Boolean),
  );
}

/** Note on the console that a check was overridden, so it's never silent. */
function note(message: string): void {
  console.log(`  (override: ${message})`);
}

/**
 * Existence check for `key` at `path`, honouring the pretend env vars:
 * FIT_CLI_PRETEND_MISSING forces false, FIT_CLI_PRETEND_PRESENT forces true.
 * With neither set (the normal case) this is just existsSync(path).
 */
export function pathExists(key: string, path: string): boolean {
  if (envKeys("FIT_CLI_PRETEND_MISSING").has(key)) {
    note(`pretending ${key} is missing`);
    return false;
  }
  if (envKeys("FIT_CLI_PRETEND_PRESENT").has(key)) {
    note(`pretending ${key} is present`);
    return true;
  }
  return existsSync(path);
}

/**
 * True if `key` should be treated as a stale (too old) build, via
 * FIT_CLI_PRETEND_STALE. Lets a step exercise its "needs rebuilding" branch
 * even when the real artifact is fresh.
 */
export function pretendStale(key: string): boolean {
  if (envKeys("FIT_CLI_PRETEND_STALE").has(key)) {
    note(`pretending ${key} is stale`);
    return true;
  }
  return false;
}
