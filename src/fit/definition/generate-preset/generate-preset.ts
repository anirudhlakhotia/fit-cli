/**
 * `bun run definition generate-preset` — emit a ready-to-run definition file
 * from a named preset template, parameterised by performer image.
 *
 * Usage:
 *   bun run definition generate-preset --type functional --performer-image-name java-fit-performer:refs-changes-67-246067-3
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { printFileContent } from "../../../util/non-fit/fit-cli-log.js";
import { resolveOutputFormat } from "../../util/config.js";
import { analysePerformerImage, performerImageShortName } from "../../performers/util/performer-image.js";
import {
  formatFitDefinition,
  writeFitDefinition,
  type DefinitionFormat,
} from "../../shared/definition/generate-definition.js";
import { describeDefinition } from "../../shared/definition/generate-desc.js";
import type { FitDefinition } from "../../shared/definition/types.js";
import { printDefinitionRunGuidance } from "../../shared/definition/run-guidance.js";
import { pushGist, type GistVisibility } from "../../shared/definition/push-gist.js";

/** `presets/tags.json5` holds tag metadata, not a preset — never treat it as one. */
const TAGS_FILENAME = "tags.json5";

/**
 * Returns a map of { "<name>": "<contents>" } for every preset in `presets/`.
 *
 * Dev mode (bun run): reads `presets/` from disk — any .json5 file (other than
 * `tags.json5`) is picked up automatically.
 *
 * Compiled binary (/$bunfs/): `bun build --compile` embeds files referenced by static import()
 * calls at bundle time; import.meta.glob is not supported in compiled binaries. Add one line
 * here per preset so the compiler knows to include it.
 */
async function loadPresetMap(): Promise<Record<string, string>> {
  if (!import.meta.url.includes("/$bunfs/")) {
    const presetsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../presets");
    return Object.fromEntries(
      readdirSync(presetsDir)
        .filter(f => f.endsWith(".json5") && f !== TAGS_FILENAME)
        .map(f => [f.replace(/\.json5$/, ""), readFileSync(join(presetsDir, f), "utf8")]),
    );
  }
  // Path AND import options must be literals — bun build --compile only embeds modules it can
  // see as static references; passing either through a variable hides them from the bundler.
  return {
    "capella-analytics-qe-set": ((await import("../../../../presets/capella-analytics-qe-set.json5", { with: { type: "text" } })) as { default: string }).default,
    "capella-analytics-functional": ((await import("../../../../presets/capella-analytics-functional.json5", { with: { type: "text" } })) as { default: string }).default,
    "capella-analytics-functional-quick-sanity": ((await import("../../../../presets/capella-analytics-functional-quick-sanity.json5", { with: { type: "text" } })) as { default: string }).default,
    "capella-functional":          ((await import("../../../../presets/capella-functional.json5",          { with: { type: "text" } })) as { default: string }).default,
    "capella-quick-sanity":        ((await import("../../../../presets/capella-quick-sanity.json5",        { with: { type: "text" } })) as { default: string }).default,
    "cng-functional":              ((await import("../../../../presets/cng-functional.json5",              { with: { type: "text" } })) as { default: string }).default,
    "cng-functional-quick-sanity": ((await import("../../../../presets/cng-functional-quick-sanity.json5", { with: { type: "text" } })) as { default: string }).default,
    "cng-situational":             ((await import("../../../../presets/cng-situational.json5",             { with: { type: "text" } })) as { default: string }).default,
    "cng-situational-quick-sanity": ((await import("../../../../presets/cng-situational-quick-sanity.json5",             { with: { type: "text" } })) as { default: string }).default,
    "cng-everything":              ((await import("../../../../presets/cng-everything.json5",              { with: { type: "text" } })) as { default: string }).default,
    "enterprise-analytics-functional": ((await import("../../../../presets/enterprise-analytics-functional.json5", { with: { type: "text" } })) as { default: string }).default,
    "enterprise-analytics-functional-quick-sanity": ((await import("../../../../presets/enterprise-analytics-functional-quick-sanity.json5", { with: { type: "text" } })) as { default: string }).default,
    "enterprise-analytics-qe-set":     ((await import("../../../../presets/enterprise-analytics-qe-set.json5",     { with: { type: "text" } })) as { default: string }).default,
    "everything-quick-sanity":     ((await import("../../../../presets/everything-quick-sanity.json5",     { with: { type: "text" } })) as { default: string }).default,
    "functional":                  ((await import("../../../../presets/functional.json5",                  { with: { type: "text" } })) as { default: string }).default,
    "functional-quick-sanity":     ((await import("../../../../presets/functional-quick-sanity.json5",     { with: { type: "text" } })) as { default: string }).default,
    "qe-set":                      ((await import("../../../../presets/qe-set.json5",                     { with: { type: "text" } })) as { default: string }).default,
    "qe-set-release":              ((await import("../../../../presets/qe-set-release.json5",             { with: { type: "text" } })) as { default: string }).default,
    "situational-quick-sanity":    ((await import("../../../../presets/situational-quick-sanity.json5",   { with: { type: "text" } })) as { default: string }).default,
    "situational-everything":    ((await import("../../../../presets/situational-everything.json5",   { with: { type: "text" } })) as { default: string }).default,
    "private-endpoint-quick-sanity":    ((await import("../../../../presets/private-endpoint-quick-sanity.json5",   { with: { type: "text" } })) as { default: string }).default,
    "private-endpoint-everything":    ((await import("../../../../presets/private-endpoint-everything.json5",   { with: { type: "text" } })) as { default: string }).default,
    "private-endpoint-situational":    ((await import("../../../../presets/private-endpoint-situational.json5",   { with: { type: "text" } })) as { default: string }).default,
  };
}

const PRESET_MAP = await loadPresetMap();

interface TagMeta {
  order: number;
  description: string;
}

/**
 * Returns { "<tag>": { order, description } } from `presets/tags.json5` — metadata for
 * the tags referenced by presets' `preset.tags`. A tag used by a preset but missing here
 * simply displays without a description and sorts after every tag that is listed.
 */
async function loadTagMeta(): Promise<Record<string, TagMeta>> {
  const raw = !import.meta.url.includes("/$bunfs/")
    ? readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../presets", TAGS_FILENAME), "utf8")
    : ((await import("../../../../presets/tags.json5", { with: { type: "text" } })) as { default: string }).default;
  return JSON5.parse(raw) as Record<string, TagMeta>;
}

const TAG_META = await loadTagMeta();

/** Tags without an `order` in `presets/tags.json5` sort after every tag that has one. */
const UNKNOWN_TAG_ORDER = Number.MAX_SAFE_INTEGER;

/** Long-form description of a tag from `presets/tags.json5`, if one is defined. */
export function describeTag(tag: string): string | undefined {
  return TAG_META[tag]?.description;
}

/** Display order of a tag from `presets/tags.json5`; unlisted tags sort last. */
function tagOrder(tag: string): number {
  return TAG_META[tag]?.order ?? UNKNOWN_TAG_ORDER;
}

export const PRESET_TYPES: string[] = Object.entries(PRESET_MAP)
  .map(([name, content]) => {
    const { order } = extractPresetMeta(content);
    return { name, order };
  })
  .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  .map(({ name }) => name);

export type PresetType = string;

export function isPresetType(value: string): value is PresetType {
  return PRESET_TYPES.includes(value);
}

interface PresetMeta {
  order: number;
  description: string;
  tags: string[];
}

/** Extract metadata from a preset template's `preset` block. */
function extractPresetMeta(raw: string): PresetMeta {
  try {
    const filled = raw.replace(/\{\{PERFORMER_IMAGE\}\}/g, "placeholder");
    const parsed = JSON5.parse(filled) as {
      preset?: { order?: number; description?: string; tags?: string[] };
    };
    return {
      order: parsed.preset?.order ?? 50,
      description: parsed.preset?.description ?? "(no description)",
      tags: parsed.preset?.tags ?? [],
    };
  } catch {
    return { order: 50, description: "(no description)", tags: [] };
  }
}

/**
 * Whether a preset has any `analytics-functional` run (Analytics tests via the
 * Analytics test-driver). Such presets need an Analytics SDK performer image
 * (Columnar SDK or Enterprise Analytics SDK), so the interactive flow offers
 * those rather than the operational SDKs.
 */
export function presetUsesAnalyticsDriver(type: PresetType): boolean {
  try {
    const filled = loadPresetTemplate(type).replace(/\{\{PERFORMER_IMAGE\}\}/g, "placeholder");
    const parsed = JSON5.parse(filled) as FitDefinition;
    return (parsed.instances ?? []).some((instance) =>
      [...(instance.clusterlessSessions ?? []), ...(instance.clusters ?? []).flatMap((c) => c.sessions)]
        .flatMap((s) => s.runs)
        .some((run) => run.type === "analytics-functional"),
    );
  } catch {
    return false;
  }
}

function sortedPresetItems<T extends { order: number; type: PresetType }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.order - b.order || a.type.localeCompare(b.type));
}

const UNTAGGED = "(untagged)";

/**
 * Group presets by tag for display. A preset with multiple tags (e.g. a
 * private-endpoint preset that's also functional) appears under each of its
 * tags' groups, since tags here represent cross-cutting concerns rather than
 * a strict single category.
 */
export function groupPresetsByTag<T extends { order: number; type: PresetType; tags: string[] }>(
  items: T[],
): { tag: string; items: T[] }[] {
  const byTag = new Map<string, T[]>();
  for (const item of items) {
    for (const tag of item.tags.length > 0 ? item.tags : [UNTAGGED]) {
      const list = byTag.get(tag) ?? [];
      list.push(item);
      byTag.set(tag, list);
    }
  }
  // Groups are ordered by each tag's `order` in presets/tags.json5 (ties broken
  // alphabetically); tags with no metadata there sort after every known tag, and
  // the untagged bucket always sorts last.
  return [...byTag.entries()]
    .map(([tag, tagItems]) => ({ tag, items: sortedPresetItems(tagItems) }))
    .sort((a, b) => {
      if (a.tag === UNTAGGED) return 1;
      if (b.tag === UNTAGGED) return -1;
      return tagOrder(a.tag) - tagOrder(b.tag) || a.tag.localeCompare(b.tag);
    });
}

interface PresetDescription {
  type: PresetType;
  description: string;
  tags: string[];
  order: number;
}

function allPresetDescriptions(): PresetDescription[] {
  const items = PRESET_TYPES.map((type) => {
    const { order, description, tags } = extractPresetMeta(loadPresetTemplate(type));
    return { type, description, tags, order };
  });
  return sortedPresetItems(items);
}

/** Available preset types paired with their descriptions and tags, for menus. */
export function presetDescriptions(): PresetDescription[] {
  return allPresetDescriptions();
}

/** Print a table of available preset types and their descriptions, grouped by tag. */
export function listPresets(): void {
  const groups = groupPresetsByTag(allPresetDescriptions());
  const col = groups.reduce(
    (max, { items }) => items.reduce((m, { type }) => Math.max(m, type.length), max),
    0,
  );
  console.log(`\nAvailable presets:\n`);
  for (const { tag, items } of groups) {
    const tagDescription = describeTag(tag);
    console.log(tagDescription ? `${tag}: ${tagDescription}` : `${tag}:`);
    for (const { type, description } of items) {
      console.log(`  ${type.padEnd(col)}  ${description}`);
    }
    console.log();
  }
}

/**
 * Bare preset names grouped by tag (no descriptions), for embedding in
 * "unknown preset" error and usage messages. Mirrors `listPresets()`'s grouping.
 */
export function formatKnownPresetsByTag(): string {
  const groups = groupPresetsByTag(allPresetDescriptions());
  return groups.map(({ tag, items }) => `  ${tag}: ${items.map(({ type }) => type).join(", ")}`).join("\n");
}

function resolvePresetOutputFormat(outputPath: string | undefined, format: DefinitionFormat | undefined): DefinitionFormat {
  if (format) {
    return format;
  }
  const extension = outputPath ? extname(outputPath).toLowerCase() : "";
  if (extension === ".yaml" || extension === ".yml") {
    return "yaml";
  }
  if (extension === ".json5") {
    return "json5";
  }
  return resolveOutputFormat();
}

function loadPresetTemplate(type: string): string {
  const content = PRESET_MAP[type];
  if (content === undefined) throw new Error(`Unknown preset: ${type}\nKnown presets:\n${formatKnownPresetsByTag()}`);
  return content;
}

/**
 * Fill the `{{PERFORMER_IMAGE}}` placeholder with the performer image and return
 * a parsed FitDefinition. `image` is the short-form `<sdk>-fit-performer:<tag>`.
 */
function applyPresetParams(template: string, image: string): FitDefinition {
  const filled = template.replace(/\{\{PERFORMER_IMAGE\}\}/g, image);
  const definition = JSON5.parse(filled) as FitDefinition & { preset?: unknown };
  delete definition.preset;
  // `preset.description` above is menu-only and already stripped; this is the separate,
  // optional file-level `description`. Synthesize one if the template didn't hand-author it.
  definition.description ??= describeDefinition(definition);
  return definition;
}

export interface GeneratePresetArgs {
  type: PresetType;
  /** Short-form performer image written into every session, e.g. java-fit-performer:main. */
  image: string;
  outputPath?: string;
  format?: DefinitionFormat;
  pushGistVisibility?: GistVisibility;
  /** When true, skip printing the "Run it later with…" guidance (used by `fit run <preset>` which runs it immediately). */
  skipGuidance?: boolean;
  /**
   * Dot-path overrides applied after template substitution, e.g.
   * `{ "setup.repos.transactions-fit-performer.gerritRef": "refs/changes/32/247532/1" }`.
   * Values are JSON-parsed where possible so booleans and numbers work naturally.
   */
  overrides?: Record<string, string>;
}

/**
 * Apply a dot-path override to an object in place.
 * `"setup.repos.transactions-fit-performer.gerritRef"` splits on `.` and creates
 * any missing intermediate objects. The value string is JSON-parsed where possible
 * so `true`/`false` and numbers work naturally; falls back to a raw string.
 */
export function applyDotPathOverride(obj: Record<string, unknown>, dotPath: string, rawValue: string): void {
  const parts = dotPath.split(".");
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (cursor[key] === undefined || cursor[key] === null || typeof cursor[key] !== "object") {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  let value: unknown;
  try {
    value = JSON.parse(rawValue);
  } catch {
    value = rawValue;
  }
  cursor[leaf] = value;
}

export async function generatePreset(args: GeneratePresetArgs): Promise<{ path: string }> {
  const { type, image, outputPath, format, pushGistVisibility, skipGuidance, overrides } = args;

  const template = loadPresetTemplate(type);
  const definition = applyPresetParams(template, image);
  if (overrides) {
    for (const [dotPath, rawValue] of Object.entries(overrides)) {
      applyDotPathOverride(definition as unknown as Record<string, unknown>, dotPath, rawValue);
    }
  }
  const outputFormat = resolvePresetOutputFormat(outputPath, format);
  const formatted = formatFitDefinition(definition, outputFormat);
  const result = outputPath
    ? (() => {
        const path = resolve(outputPath);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, formatted);
        return { path };
      })()
    : writeFitDefinition(definition, undefined, outputFormat);

  console.log(`\nWriting ${result.path}:\n`);
  printFileContent(formatted);
  console.log(`\n✓ Wrote ${result.path}`);

  if (pushGistVisibility) {
    console.log(`\nPushing ${pushGistVisibility} gist…`);
    const gist = await pushGist(result.path, formatted, pushGistVisibility);
    console.log(`✓ Gist created: ${gist.url}`);
  }

  if (!skipGuidance) {
    printDefinitionRunGuidance(result.path);
  }

  return { path: result.path };
}

/** Parse `generate-preset` flags out of a positional-free argv slice. */
export function parseGeneratePresetArgs(argv: string[]): GeneratePresetArgs {
  let type: string | undefined;
  let performerImageName: string | undefined;
  let outputPath: string | undefined;
  let pushGistVisibility: GistVisibility | undefined;
  const overrides: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--type") {
      type = argv[++i];
    } else if (arg.startsWith("--type=")) {
      type = arg.slice("--type=".length);
    } else if (arg === "--performer-image-name") {
      performerImageName = argv[++i];
    } else if (arg.startsWith("--performer-image-name=")) {
      performerImageName = arg.slice("--performer-image-name=".length);
    } else if (arg === "--output") {
      outputPath = argv[++i];
    } else if (arg.startsWith("--output=")) {
      outputPath = arg.slice("--output=".length);
    } else if (arg === "--override") {
      const kv = argv[++i];
      const eq = kv.indexOf("=");
      if (eq === -1) throw new Error(`--override value must be in key=value form, got: ${kv}`);
      overrides[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (arg.startsWith("--override=")) {
      const kv = arg.slice("--override=".length);
      const eq = kv.indexOf("=");
      if (eq === -1) throw new Error(`--override value must be in key=value form, got: ${kv}`);
      overrides[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (arg === "--push-gist") {
      // Optional value: --push-gist [public|private]; default public.
      const next = argv[i + 1];
      if (next === "public" || next === "private") {
        pushGistVisibility = next;
        i++;
      } else {
        pushGistVisibility = "public";
      }
    } else if (arg.startsWith("--push-gist=")) {
      const val = arg.slice("--push-gist=".length);
      if (val !== "public" && val !== "private") {
        throw new Error(`--push-gist value must be "public" or "private", got: ${val}`);
      }
      pushGistVisibility = val;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!type) throw new Error(`--type is required.\nAvailable presets:\n${formatKnownPresetsByTag()}`);
  if (!isPresetType(type)) {
    throw new Error(`Unknown preset type: ${type}\nKnown types:\n${formatKnownPresetsByTag()}`);
  }
  if (!performerImageName) {
    throw new Error("--performer-image-name is required, e.g. java-fit-performer:main");
  }
  const parsed = analysePerformerImage(performerImageName);
  if ("error" in parsed) {
    throw new Error(`--performer-image-name: ${parsed.error}`);
  }

  return {
    type,
    image: performerImageShortName(parsed.sdk, parsed.tag),
    outputPath,
    pushGistVisibility,
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
  };
}
