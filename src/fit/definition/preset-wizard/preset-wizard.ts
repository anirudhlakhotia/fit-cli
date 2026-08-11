/**
 * Wizard sub-flow: export or run a named preset.
 *
 * A preset is a ready-made definition template (functional tests, a quick
 * sanity, the QE set, …) that only needs a performer image filling in. This
 * flow asks which preset, which SDK + performer tag, and whether to just write
 * the definition file (export) or write-and-run it immediately (run). It is the
 * interactive front-end to `fit preset generate` / `fit run preset <preset>`.
 *
 * Run on its own:
 *   bun src/fit/definition/preset-wizard/preset-wizard.ts
 */
import { Separator } from "@inquirer/prompts";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { combineRunOutputs, type RunOutput } from "../../../util/non-fit/artifacts.js";
import { select } from "../../../util/non-fit/prompts.js";
import { chooseAnalyticsFunctionalSdk, chooseSdk } from "../../../util/sdk/choose-sdk.js";
import { askPerformerTag } from "../../performers/util/ask-performer-image.js";
import { performerImageShortName } from "../../performers/util/performer-image.js";
import { runFromDefinition } from "../../functional/run-from-definition/run-from-definition.js";
import type { DefinitionFormat } from "../../shared/definition/generate-definition.js";
import type { GistVisibility } from "../../shared/definition/push-gist.js";
import {
  describeTag,
  generatePreset,
  groupPresetsByTag,
  presetDescriptions,
  presetUsesAnalyticsDriver,
} from "../generate-preset/generate-preset.js";
import { expandPresetGroupNames, presetGroupDescriptions } from "../generate-preset/preset-groups.js";

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
      { name: "Run a preset — write the definition file and execute it now", value: "run" },
      { name: "Export a preset — write a ready-to-run definition file you can edit, share, or hand to CI", value: "export" },
    ],
  });
}

/**
 * Build the preset picker's choice list, grouped by tag with a separator header per
 * group — presets and preset groups (e.g. `op-multi-lite`) intermingled, same as
 * `fit preset list`. A group's "description" is its immediate members, since a full
 * description gets long fast (see `formatPresetsAndGroupsListing`).
 */
export function buildPresetTypeChoices(): unknown[] {
  const entries = [
    ...presetDescriptions().map((p) => ({ type: p.type, tags: p.tags, description: p.description })),
    ...presetGroupDescriptions().map((g) => ({ type: g.name, tags: g.tags, description: `[groups: ${g.presets.join(", ")}]`, isGroup: true })),
  ];
  const col = entries.reduce((max, e) => Math.max(max, e.type.length), 0);
  const groups = groupPresetsByTag(entries);
  return groups.flatMap(({ tag, items }) => [
    new Separator(`── ${tag}${describeTag(tag) ? `: ${describeTag(tag)}` : ""} ──`),
    ...items.map((e) => ({ name: `${e.type.padEnd(col)}  ${e.description}`, value: e.type })),
  ]);
}

/** Returns a preset or preset-group name — see `expandPresetGroupNames` for resolving it. */
async function choosePresetType(): Promise<string> {
  return select<string>({
    promptId: TYPE_PROMPT_ID,
    message: "Which preset?",
    choices: buildPresetTypeChoices(),
  });
}

/**
 * Drive the interactive "export or run a preset" wizard flow. Returns the
 * RunOutput of the definition run when running, or an empty output when only
 * exporting.
 */
export async function runPresetWizard(options: RunPresetWizardOptions = {}): Promise<RunOutput> {
  const action = await choosePresetAction();
  const name = await choosePresetType();
  const types = expandPresetGroupNames(name);
  if (types.length > 1) {
    console.log(`"${name}" expands to ${types.length} presets, run in sequence: ${types.join(", ")}\n`);
  }
  // A group's presets share one SDK family (see generate-preset.ts's `<family>-multi-*`
  // comment), so checking the first expanded preset is representative of the whole group.
  const sdk = presetUsesAnalyticsDriver(types[0])
    ? await chooseAnalyticsFunctionalSdk("Which Analytics SDK's performer should the preset run against?", PROMPT_PREFIX)
    : await chooseSdk("Which SDK's performer should the preset run against?", PROMPT_PREFIX);
  const tag = await askPerformerTag(sdk, PROMPT_PREFIX);
  const image = performerImageShortName(sdk, tag);

  if (action === "run") {
    const outputs: RunOutput[] = [];
    for (const [index, type] of types.entries()) {
      if (types.length > 1) {
        console.log(`\n=== Running preset ${index + 1}/${types.length}: ${type} ===\n`);
      }
      const { path } = await generatePreset({ type, image, skipGuidance: true });
      // Presets in a group run in one process, so scope per-run prompt ids by preset
      // name — see run.ts's identical handling for why single-preset runs stay unscoped.
      const output = await runFromDefinition(path, types.length > 1 ? { promptScope: type } : undefined);
      if (output) outputs.push(output);
    }
    return combineRunOutputs(...outputs);
  }

  for (const type of types) {
    await generatePreset({ type, image, format: options.format, pushGistVisibility: options.pushGistVisibility });
  }
  return { artifacts: [], details: [] };
}

if (isMain(import.meta.url)) {
  runCli(() => runPresetWizard());
}
