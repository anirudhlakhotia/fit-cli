import { spawn } from "node:child_process";

/**
 * Run a command, streaming its output straight to the console, and resolve when
 * it finishes. Rejects if the command can't start or exits non-zero. Used for
 * the long-running external tools FIT shells out to (git, mvn).
 */
export function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}
