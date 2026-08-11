/**
 * Loads caps.json5 — fit-cli's curated catalogue of FIT capabilities.
 *
 * Why a checked-in file rather than reading the protos: performers report caps as
 * bare enum *numbers*, so something has to map number → name, and we want somewhere
 * to hang information the proto doesn't carry (the Jira ticket tracking the cap,
 * notes on what it really means). Doing both in one file keeps the mapping and the
 * metadata from drifting apart, and means `fit caps` needs no checkout of
 * transactions-fit-performer.
 *
 * Keep it in step with the protos with `fit caps sync <path-to-transactions-fit-performer>`,
 * which adds newly-defined caps without touching the human-written fields.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";

/** The three independent cap enums a performer reports. All start numbering at 0. */
export const CAP_GROUPS = ["sdk", "transactions", "performer"] as const;
export type CapGroup = (typeof CAP_GROUPS)[number];

export interface CapMetadata {
  /** The enum value on the wire. Unique within its group, not across groups. */
  number: number;
  /** Jira ticket tracking this cap, e.g. "CBD-5161". Blank until someone fills it in. */
  jira?: string;
  /** What the cap means — seeded from the proto comment, then edited by hand. */
  description?: string;
  /** Anything else worth recording (deprecations, gotchas, who owns it). */
  notes?: string;
}

/** caps.json5's shape: group → cap name → metadata. */
export type CapsFile = Record<CapGroup, Record<string, CapMetadata>>;

/** A cap resolved for display: its name, its metadata, and the group it came from. */
export interface Cap extends CapMetadata {
  name: string;
  group: CapGroup;
}

export const DEFAULT_CAPS_PATH = fileURLToPath(new URL("../../../../caps.json5", import.meta.url));

// Bun's --compile bundles assets rather than shipping the repo tree, so in the
// compiled binary we resolve caps.json5 through the bundler. Mirrors environments.ts.
const bundledCapsPath = import.meta.url.includes("/$bunfs/")
  ? ((await import("../../../../caps.json5", { with: { type: "file" } })) as { default: string }).default
  : undefined;

let cached: CapsFile | undefined;

/** Load and validate caps.json5. Cached when reading the default path. */
export function loadCapsFile(path: string = DEFAULT_CAPS_PATH): CapsFile {
  if (path === DEFAULT_CAPS_PATH && cached) return cached;

  const resolvedPath = path === DEFAULT_CAPS_PATH && bundledCapsPath ? bundledCapsPath : path;
  const parsed = JSON5.parse<CapsFile>(readFileSync(resolvedPath, "utf8"));

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Caps file at ${path} must be a JSON5 object.`);
  }
  for (const group of CAP_GROUPS) {
    if (!parsed[group] || typeof parsed[group] !== "object") {
      throw new Error(`Caps file at ${path} must define a "${group}" section.`);
    }
    for (const [name, meta] of Object.entries(parsed[group])) {
      if (typeof meta?.number !== "number") {
        throw new Error(`Cap ${group}.${name} in ${path} is missing a numeric "number".`);
      }
    }
  }

  if (path === DEFAULT_CAPS_PATH) cached = parsed;
  return parsed;
}

/**
 * Index one group by enum number, so a reported cap can be named.
 *
 * Duplicate numbers within a group would silently hide a cap, so reject them.
 */
export function capsByNumber(capsFile: CapsFile, group: CapGroup): Map<number, Cap> {
  const byNumber = new Map<number, Cap>();
  for (const [name, meta] of Object.entries(capsFile[group])) {
    const existing = byNumber.get(meta.number);
    if (existing) {
      throw new Error(`Caps file has two ${group} caps with number ${meta.number}: ${existing.name} and ${name}.`);
    }
    byNumber.set(meta.number, { ...meta, name, group });
  }
  return byNumber;
}

/** Every cap in a group, ordered by enum number — the order they appear in the proto. */
export function capsInGroup(capsFile: CapsFile, group: CapGroup): Cap[] {
  return [...capsByNumber(capsFile, group).values()].sort((a, b) => a.number - b.number);
}

/**
 * Find a cap by name, across all three groups (case-insensitive).
 *
 * Names are only guaranteed unique within a group, not across groups, so this
 * returns every match rather than picking one — callers should treat more than
 * one match as ambiguous.
 */
export function findCap(capsFile: CapsFile, name: string): Cap[] {
  const needle = name.toLowerCase();
  const matches: Cap[] = [];
  for (const group of CAP_GROUPS) {
    for (const [capName, meta] of Object.entries(capsFile[group])) {
      if (capName.toLowerCase() === needle) matches.push({ ...meta, name: capName, group });
    }
  }
  return matches;
}

/**
 * Name a cap number a performer reported.
 *
 * A number we don't know about means the protos have gained a cap that caps.json5
 * hasn't caught up with — surface it rather than dropping it, so it's obvious that
 * a `fit caps sync` (and a Jira ticket) is due.
 */
export function capDisplayName(byNumber: Map<number, Cap>, number: number): string {
  return byNumber.get(number)?.name ?? `#${number} (unknown — run 'fit caps sync')`;
}
