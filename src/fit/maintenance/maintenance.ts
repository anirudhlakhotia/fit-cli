#!/usr/bin/env node
/**
 * Top-level `fit maintenance` — housekeeping actions that keep the fit-cli repo
 * and its releases tidy. These mirror what the scheduled Maintenance workflow
 * (.github/workflows/maintenance.yaml) runs, so they can be tested from the CLI.
 *
 * Command groups:
 *   channels   Publish git branches as installable release channels, and prune
 *              channels whose branch has been deleted.
 *
 *   bun run maintenance channels list
 *   bun run maintenance channels sync --prune
 *
 * Debug directly (not a stable CLI path):
 *   bun src/fit/maintenance/maintenance.ts channels list
 */
import { isMain } from "../../util/non-fit/cli.js";
import { runScriptPrefix } from "../../util/non-fit/fit-cli-log.js";
import { runChannelsDispatch } from "./channels/channels.js";

function helpText(): string {
  const p = runScriptPrefix("maintenance");
  return `fit-cli repository & release maintenance.

Usage:
  ${p} channels [list|publish|sync|prune] [...]
  ${p} --help

Command groups:
  channels   Publish git branches as installable release channels, and prune
             channels whose branch has been deleted. See '${p} channels --help'.`;
}

export async function runMaintenanceDispatch(argv: string[]): Promise<void> {
  const [group, ...rest] = argv;
  const HELP = new Set(["-h", "--help", "help"]);
  if (!group || (HELP.has(group) && rest.length === 0)) {
    console.log(helpText());
    if (!group) process.exit(2);
    return;
  }
  switch (group) {
    case "channels":
      await runChannelsDispatch(rest);
      return;
    default:
      console.error(`Unknown maintenance group: ${group}\n`);
      console.error(helpText());
      process.exit(2);
  }
}

export function runMaintenanceMain(): void {
  runMaintenanceDispatch(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

if (isMain(import.meta.url)) {
  runMaintenanceMain();
}
