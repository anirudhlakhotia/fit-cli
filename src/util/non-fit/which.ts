/**
 * findOnPath — locate an executable on the PATH, the way a shell would. Pure
 * logic (the only IO is checking whether candidate files are executable), with
 * `env` injectable so it can be unit tested (see tests/which.test.ts).
 */
import { accessSync, constants } from "node:fs";
import { delimiter, join, sep } from "node:path";

/**
 * Find an executable named `command` on the PATH, returning its full path, or
 * null if it isn't found. Searches the PATH entries in order and returns the
 * first executable match — the same resolution a shell uses.
 */
export function findOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // A bare executable name never contains a path separator; reject anything that does
  // rather than letting it escape the PATH directory being searched.
  if (command.includes(sep) || command.includes("/") || command.includes("..")) {
    return null;
  }
  const path = env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this directory, or not executable — keep looking.
    }
  }
  return null;
}
