import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensurePromptSession } from "./replay.js";

/**
 * Shared plumbing for the small per-step CLIs. Every file under steps/ exports
 * its step function(s) for the wizard to use, and also has a `if (isMain(...))`
 * block so it can be run on its own for debugging and development iteration.
 */

/** True when the module at `metaUrl` is the script node/tsx was invoked with. */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entry);
}

/**
 * Run a step's CLI entry point with consistent error handling: a clean Ctrl-C /
 * Esc from @inquirer throws ExitPromptError and exits quietly, anything else
 * prints and exits non-zero.
 */
export function runCli(main: () => Promise<void>): void {
  Promise.resolve()
    .then(() => {
      ensurePromptSession(process.argv.slice(2));
      return main();
    })
    .catch((err) => {
      if (err instanceof Error && err.name === "ExitPromptError") {
        console.log("\nCancelled.");
        process.exit(0);
      }
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
