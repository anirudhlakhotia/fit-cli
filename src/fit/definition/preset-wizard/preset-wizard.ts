/**
 * Wizard sub-flow: export or run a named preset.
 *
 * A preset is a ready-made definition template (functional tests, a quick
 * sanity, the QE set, …) that only needs a performer image filling in. This
 * flow asks which preset, which SDK + performer tag, and whether to just write
 * the definition file (export) or write-and-run it immediately (run). It is the
 * interactive front-end to `definition generate-preset` / `execute-preset`.
 *
 * Run on its own:
 *   bun src/fit/definition/preset-wizard/preset-wizard.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { type RunOutput } from "../../../util/non-fit/artifacts.js";
import { select } from "../../../util/non-fit/prompts.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import { askPerformerTag } from "../../performers/util/ask-performer-image.js";
import { performerImageShortName } from "../../performers/util/performer-image.js";
import { runFromDefinition } from "../../functional/run-from-definition/run-from-definition.js";
import type { DefinitionFormat } from "../../shared/definition/generate-definition.js";
import type { GistVisibility } from "../../shared/definition/push-gist.js";
import { generatePreset, presetDescriptions, type PresetType } from "../generate-preset/generate-preset.js";

const PROMPT_PREFIX = "preset";
const ACTION_PROMPT_ID = `${PROMPT_PREFIX}.action`;
const TYPE_PROMPT_ID = `${PROMPT_PREFIX}.type`;

type PresetAction = "export" | "run";

export interface RunPresetWizardOptions {
  format?: DefinitionFormat;
  pushGistVisibility?: GistVisibility;
}

async function choosePresetAction(): Promise<PresetAction> {
  return select<PresetAction>({
    promptId: ACTION_PROMPT_ID,
    message: "What would you like to do with a preset?",
    choices: [
      { name: "Export a preset — write a ready-to-run definition file you can edit, share, or hand to CI", value: "export" },
      { name: "Run a preset — write the definition file and execute it now", value: "run" },
    ],
  });
}

async function choosePresetType(): Promise<PresetType> {
  const presets = await presetDescriptions();
  const col = presets.reduce((max, p) => Math.max(max, p.type.length), 0);
  return select<PresetType>({
    promptId: TYPE_PROMPT_ID,
    message: "Which preset?",
    choices: presets.map((p) => ({ name: `${p.type.padEnd(col)}  ${p.description}`, value: p.type })),
  });
}

/**
 * Drive the interactive "export or run a preset" wizard flow. Returns the
 * RunOutput of the definition run when running, or an empty output when only
 * exporting.
 */
export async function runPresetWizard(rootDir: string, options: RunPresetWizardOptions = {}): Promise<RunOutput> {
  const action = await choosePresetAction();
  const type = await choosePresetType();
  const sdk = await chooseSdk("Which SDK's performer should the preset run against?", PROMPT_PREFIX);
  const tag = await askPerformerTag(sdk, PROMPT_PREFIX);
  const image = performerImageShortName(sdk, tag);

  if (action === "run") {
    const { path } = await generatePreset({ type, image, skipGuidance: true });
    return runFromDefinition(path, rootDir);
  }

  await generatePreset({ type, image, format: options.format, pushGistVisibility: options.pushGistVisibility });
  return { artifacts: [], details: [] };
}

if (isMain(import.meta.url)) {
  runCli(() => runPresetWizard(process.cwd()));
}
