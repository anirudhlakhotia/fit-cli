/**
 * Persistent registry of recently generated FIT definition files.
 *
 * bun src/fit/shared/definition/recent-definitions.ts [list | record <path> <description>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import { RUN_ROOT_DIR } from "../../../util/non-fit/replay.js";
import { isMain } from "../../../util/non-fit/cli.js";

const RECENT_DEFS_FILE = join(RUN_ROOT_DIR, "recent-definitions.json5");
const MAX_RECENT = 15;

export interface RecentDefinitionEntry {
  path: string;
  createdAt: string;
  description: string;
}

/** Pure: prepend newEntry to existing list, trim to MAX_RECENT. */
export function trimRecentDefinitions(
  existing: RecentDefinitionEntry[],
  newEntry: RecentDefinitionEntry,
): RecentDefinitionEntry[] {
  return [newEntry, ...existing].slice(0, MAX_RECENT);
}

/** Returns [] if the file is missing or unreadable — never throws. */
export function loadRecentDefinitions(): RecentDefinitionEntry[] {
  try {
    if (!existsSync(RECENT_DEFS_FILE)) return [];
    const raw = readFileSync(RECENT_DEFS_FILE, "utf8");
    const parsed = JSON5.parse<RecentDefinitionEntry[]>(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

/** Records a definition file into the registry.  Best-effort — swallows errors so it never breaks a run. */
export function recordRecentDefinition(path: string, description: string): void {
  try {
    mkdirSync(RUN_ROOT_DIR, { recursive: true });
    const existing = loadRecentDefinitions();
    const updated = trimRecentDefinitions(existing, { path, createdAt: new Date().toISOString(), description });
    writeFileSync(RECENT_DEFS_FILE, JSON5.stringify(updated, null, 2));
  } catch {
    // Best-effort
  }
}

if (isMain(import.meta.url)) {
  const [, , sub, ...rest] = process.argv;
  if (sub === "list" || !sub) {
    const entries = loadRecentDefinitions();
    if (entries.length === 0) {
      console.log("No recent definitions recorded.");
    } else {
      for (const e of entries) {
        const dt = new Date(e.createdAt).toLocaleString();
        console.log(`${dt}  ${e.description}`);
        console.log(`  ${e.path}`);
      }
    }
  } else if (sub === "record") {
    const [path, ...descParts] = rest;
    if (!path) {
      console.error("Usage: record <path> <description>");
      process.exit(1);
    }
    recordRecentDefinition(path, descParts.join(" "));
    console.log(`Recorded ${path}`);
  } else {
    console.error(`Unknown subcommand: ${sub}`);
    console.error("Usage: bun src/fit/shared/definition/recent-definitions.ts [list | record <path> <description>]");
    process.exit(1);
  }
}
