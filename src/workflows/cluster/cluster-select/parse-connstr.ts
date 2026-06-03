/**
 * parseConnstr — pull the connection string out of `cbdinocluster connstr <id>`
 * output. Pure string logic, so it can be unit tested (see tests/parse-connstr.test.ts).
 *
 * The output looks like:
 *
 *   2026-06-03T13:08:23.288+0100    INFO    logger initialized
 *   2026-06-03T13:08:23.288+0100    INFO    attempting to identify cluster  {...}
 *   couchbase://172.18.0.2
 *
 * The connection string is the tool's real output (its log lines are timestamped
 * INFO/WARN noise); we take the last line that looks like a Couchbase connection
 * string, so stray log lines on the same stream don't trip us up.
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";

const CONNSTR_LINE = /^(?:couchbases?|couchbase2):\/\/\S+$/i;

/**
 * Extract the connection string from `cbdinocluster connstr` output, or null if
 * there isn't one (e.g. the cluster couldn't be identified).
 */
export function parseConnstr(output: string): string | null {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CONNSTR_LINE.test(lines[i])) {
      return lines[i];
    }
  }
  return null;
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const raw = process.argv[2] ?? "";
    console.log(parseConnstr(raw) ?? "(no connection string found)");
    return Promise.resolve();
  });
}
