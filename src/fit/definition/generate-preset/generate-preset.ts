/**
 * `bun run definition generate-preset` — emit a ready-to-run definition file
 * from a named preset template, parameterised by performer image.
 *
 * Usage:
 *   bun run definition generate-preset --type preset-functional-tests --performer-image-name java-fit-performer:refs-changes-67-246067-3
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, extname, resolve } from "node:path";
import YAML from "yaml";
import { printWithoutTimestamps } from "../../../util/non-fit/fit-cli-log.js";
import { resolveOutputFormat } from "../../util/config.js";
import { analysePerformerImage, performerImageShortName } from "../../performers/util/performer-image.js";
import {
  formatFitDefinition,
  writeFitDefinition,
  type DefinitionFormat,
} from "../../shared/definition/generate-definition.js";
import type { FitDefinition } from "../../shared/definition/types.js";
import { printDefinitionRunGuidance } from "../../shared/definition/run-guidance.js";
import { pushGist, type GistVisibility } from "../../shared/definition/push-gist.js";

export const PRESET_TYPES = ["preset-functional-tests", "preset-cng-functional-tests", "preset-functional-quick-sanity", "preset-situational-quick-sanity", "preset-qe-set"] as const;
export type PresetType = (typeof PRESET_TYPES)[number];

export function isPresetType(value: string): value is PresetType {
  return PRESET_TYPES.includes(value as PresetType);
}

const PRESET_TEMPLATE_FILES: Record<PresetType, string> = {
  "preset-functional-tests": "preset-functional-tests.yaml",
  "preset-cng-functional-tests": "preset-cng-functional-tests.yaml",
  "preset-functional-quick-sanity": "preset-functional-quick-sanity.yaml",
  "preset-situational-quick-sanity": "preset-situational-quick-sanity.yaml",
  "preset-qe-set": "preset-qe-set.yaml",
};

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

function loadPresetTemplateFromDisk(type: PresetType): string {
  const presetsDir = join(dirname(fileURLToPath(import.meta.url)), "../presets");
  return readFileSync(join(presetsDir, PRESET_TEMPLATE_FILES[type]), "utf8");
}

async function loadBundledPresetTemplate(type: PresetType): Promise<string> {
  switch (type) {
    case "preset-functional-tests": {
      const templateModule = await import("../presets/preset-functional-tests.yaml", {
        with: { type: "text" },
      }) as { default: string };
      return templateModule.default;
    }
    case "preset-cng-functional-tests": {
      const templateModule = await import("../presets/preset-cng-functional-tests.yaml", {
        with: { type: "text" },
      }) as { default: string };
      return templateModule.default;
    }
    case "preset-functional-quick-sanity": {
      const templateModule = await import("../presets/preset-functional-quick-sanity.yaml", {
        with: { type: "text" },
      }) as { default: string };
      return templateModule.default;
    }
    case "preset-situational-quick-sanity": {
      const templateModule = await import("../presets/preset-situational-quick-sanity.yaml", {
        with: { type: "text" },
      }) as { default: string };
      return templateModule.default;
    }
    case "preset-qe-set": {
      const templateModule = await import("../presets/preset-qe-set.yaml", {
        with: { type: "text" },
      }) as { default: string };
      return templateModule.default;
    }
  }
}

async function loadPresetTemplate(type: PresetType): Promise<string> {
  try {
    return loadPresetTemplateFromDisk(type);
  } catch (err) {
    if (!(err instanceof Error) || !import.meta.url.includes("/$bunfs/")) {
      throw err;
    }
    return loadBundledPresetTemplate(type);
  }
}

/**
 * Fill the `{{PERFORMER_IMAGE}}` placeholder with the performer image and return
 * a parsed FitDefinition. `image` is the short-form `<sdk>-fit-performer:<tag>`.
 */
function applyPresetParams(template: string, image: string): FitDefinition {
  const filled = template.replace(/\{\{PERFORMER_IMAGE\}\}/g, image);
  return YAML.parse(filled) as FitDefinition;
}

export interface GeneratePresetArgs {
  type: PresetType;
  /** Short-form performer image written into every session, e.g. java-fit-performer:main. */
  image: string;
  outputPath?: string;
  format?: DefinitionFormat;
  pushGistVisibility?: GistVisibility;
}

export async function generatePreset(args: GeneratePresetArgs): Promise<void> {
  const { type, image, outputPath, format, pushGistVisibility } = args;

  const template = await loadPresetTemplate(type);
  const definition = applyPresetParams(template, image);
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
  printWithoutTimestamps(formatted);
  console.log(`\n✓ Wrote ${result.path}`);

  if (pushGistVisibility) {
    console.log(`\nPushing ${pushGistVisibility} gist…`);
    const gist = await pushGist(result.path, formatted, pushGistVisibility);
    console.log(`✓ Gist created: ${gist.url}`);
  }

  printDefinitionRunGuidance(result.path);
}

/** Parse `generate-preset` flags out of a positional-free argv slice. */
export function parseGeneratePresetArgs(argv: string[]): GeneratePresetArgs {
  let type: string | undefined;
  let performerImageName: string | undefined;
  let outputPath: string | undefined;
  let pushGistVisibility: GistVisibility | undefined;

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

  if (!type) throw new Error(`--type is required.\nAvailable presets: ${PRESET_TYPES.join(", ")}`);
  if (!isPresetType(type)) {
    throw new Error(`Unknown preset type: ${type}\nKnown types: ${PRESET_TYPES.join(", ")}`);
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
  };
}
