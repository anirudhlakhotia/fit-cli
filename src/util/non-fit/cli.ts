import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactFromPath,
  formatArtifactsSection,
  formatDetailsSection,
  combineRunOutputs,
  type RunOutput,
} from "./artifacts.js";
import { installFitCliConsoleFormatting } from "./fit-cli-log.js";
import { startSessionLog } from "./proc.js";
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
export function runCli(main: () => Promise<void | Partial<RunOutput>>): void {
  installFitCliConsoleFormatting();
  const promptSession = ensurePromptSession(process.argv.slice(2));
  const sessionLog = startSessionLog(join(promptSession.runDir, "session.log"));
  const sessionLogArtifact = artifactFromPath(
    sessionLog.path,
    "Full log of this fit-cli session",
    promptSession.runDir,
  );
  let summaryOutput: string | undefined;
  Promise.resolve()
    .then(() => main())
    .then((result) => {
      const output = combineRunOutputs(result ?? undefined, { artifacts: [sessionLogArtifact] });
      const sections = [
        formatArtifactsSection(promptSession.runDir, output.artifacts),
        formatDetailsSection(output.details),
      ].filter(Boolean);
      summaryOutput = sections.join("\n\n") || undefined;
      return promptSession.finishReplay();
    })
    .then(() => {
      if (summaryOutput) {
        console.log(`\n${summaryOutput}`);
      }
    })
    .finally(() => {
      const replayReminder = promptSession.formatReplayReminder();
      if (replayReminder) {
        console.log(`\n${replayReminder}`);
      }
    })
    .catch(async (err) => {
      if (err instanceof Error && err.name === "ExitPromptError") {
        console.log("\nCancelled.");
        await sessionLog.flush();
        process.exit(0);
      }
      console.error(err instanceof Error ? err.message : err);
      // Flush the tee'd log before exiting so the error above is actually
      // persisted to session.log, not lost to a truncated write buffer.
      await sessionLog.flush();
      process.exit(1);
    });
}
