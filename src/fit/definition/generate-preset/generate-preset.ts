/**
 * `bun run definition -- generate-preset` — emit a ready-to-run definition file
 * from a named preset template, parameterised by SDK, cluster version, and
 * (optionally) a performer Docker image tag.
 *
 * Usage:
 *   bun run definition -- generate-preset --type preset-functional-tests --sdk java --cluster-version 7.6.5
 *   bun run definition -- generate-preset --type preset-functional-tests --sdk java --cluster-version 8.0.0 --performer-image-name main
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import YAML from "yaml";
import { printWithoutTimestamps } from "../../../util/non-fit/fit-cli-log.js";
import { resolveOutputFormat } from "../../util/config.js";
import { sdkByValue, type SdkValue } from "../../../util/sdk/sdks.js";
import {
  formatFitDefinition,
  writeFitDefinition,
  type DefinitionFormat,
} from "../../shared/definition/generate-definition.js";
import type { FitDefinition, SessionLifetime } from "../../shared/definition/types.js";
import { printDefinitionRunGuidance } from "../../shared/definition/run-guidance.js";
import { pushGist, type GistVisibility } from "../../shared/definition/push-gist.js";

export const PRESET_TYPES = ["preset-functional-tests"] as const;
export type PresetType = (typeof PRESET_TYPES)[number];

export function isPresetType(value: string): value is PresetType {
  return PRESET_TYPES.includes(value as PresetType);
}

const PRESET_TEMPLATE_FILES: Record<PresetType, string> = {
  "preset-functional-tests": "preset-functional-tests.yaml",
};

function loadPresetTemplate(type: PresetType): string {
  const presetsDir = join(dirname(fileURLToPath(import.meta.url)), "../presets");
  return readFileSync(join(presetsDir, PRESET_TEMPLATE_FILES[type]), "utf8");
}

/**
 * Fill in the template placeholders and return a parsed FitDefinition.
 * If `performerImageName` is provided it is written into every performer's
 * `version` field (it is the Docker image tag for the GHCR performer image).
 */
function applyPresetParams(
  template: string,
  sdkValue: SdkValue,
  clusterVersion: string,
  performerImageName?: string,
): FitDefinition {
  const filled = template
    .replace(/\{\{SDK\}\}/g, sdkValue)
    .replace(/\{\{CLUSTER_VERSION\}\}/g, clusterVersion);
  const definition = YAML.parse(filled) as FitDefinition;

  if (performerImageName) {
    const tag = performerImageName.trim();
    for (const instance of definition.instances) {
      const sessions: SessionLifetime[] = [
        ...instance.clusters.flatMap((c) => c.sessions),
        ...(instance.clusterlessSessions ?? []),
      ];
      for (const session of sessions) {
        session.performer = { ...session.performer, version: tag };
      }
    }
  }

  return definition;
}

export interface GeneratePresetArgs {
  type: PresetType;
  sdkValue: SdkValue;
  clusterVersion: string;
  performerImageName?: string;
  format?: DefinitionFormat;
  pushGistVisibility?: GistVisibility;
}

export async function generatePreset(args: GeneratePresetArgs): Promise<void> {
  const { type, sdkValue, clusterVersion, performerImageName, format, pushGistVisibility } = args;
  const sdk = sdkByValue(sdkValue);
  if (!sdk) {
    throw new Error(`Unknown SDK: ${sdkValue}`);
  }

  const template = loadPresetTemplate(type);
  const definition = applyPresetParams(template, sdkValue, clusterVersion, performerImageName);
  const outputFormat = format ?? resolveOutputFormat();
  const result = writeFitDefinition(definition, undefined, outputFormat);
  const formatted = formatFitDefinition(definition, outputFormat);

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
  let sdkValue: string | undefined;
  let clusterVersion: string | undefined;
  let performerImageName: string | undefined;
  let pushGistVisibility: GistVisibility | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--type") {
      type = argv[++i];
    } else if (arg.startsWith("--type=")) {
      type = arg.slice("--type=".length);
    } else if (arg === "--sdk") {
      sdkValue = argv[++i];
    } else if (arg.startsWith("--sdk=")) {
      sdkValue = arg.slice("--sdk=".length);
    } else if (arg === "--cluster-version") {
      clusterVersion = argv[++i];
    } else if (arg.startsWith("--cluster-version=")) {
      clusterVersion = arg.slice("--cluster-version=".length);
    } else if (arg === "--performer-image-name") {
      performerImageName = argv[++i];
    } else if (arg.startsWith("--performer-image-name=")) {
      performerImageName = arg.slice("--performer-image-name=".length);
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

  if (!type) throw new Error("--type is required");
  if (!isPresetType(type)) {
    throw new Error(`Unknown preset type: ${type}\nKnown types: ${PRESET_TYPES.join(", ")}`);
  }
  if (!sdkValue) throw new Error("--sdk is required");
  if (!sdkByValue(sdkValue)) {
    throw new Error(`Unknown SDK: ${sdkValue}\nKnown SDKs: java, kotlin, scala, cpp, dotnet, go, node, python, ruby, rust`);
  }
  if (!clusterVersion) throw new Error("--cluster-version is required");

  return { type, sdkValue: sdkValue as SdkValue, clusterVersion, performerImageName, pushGistVisibility };
}
