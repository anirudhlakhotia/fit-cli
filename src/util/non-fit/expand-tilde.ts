import { homedir } from "node:os";

/**
 * Expand a leading `~` or `~/` to the user's home directory. Node's fs layer
 * does not do this itself, so a configured path like `~/foo` fails existsSync
 * unless it is expanded first. Leaves any other value untouched.
 */
export function expandTilde(value: string, home: string = homedir()): string {
  if (value === "~" || value.startsWith("~/")) {
    return home + value.slice(1);
  }
  return value;
}
