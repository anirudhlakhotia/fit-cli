import assert from "node:assert/strict";
import test from "node:test";
import { Separator } from "@inquirer/prompts";
import { PRESET_TYPES } from "../../generate-preset/generate-preset.js";
import { presetGroupDescriptions } from "../../generate-preset/preset-groups.js";
import { buildPresetTypeChoices } from "../preset-wizard.js";

test("buildPresetTypeChoices groups every preset and preset group under a separator, with valid values", () => {
  const choices = buildPresetTypeChoices();
  const groupNames = presetGroupDescriptions().map((g) => g.name);
  const knownNames = new Set([...PRESET_TYPES, ...groupNames]);

  const separatorCount = choices.filter((c) => c instanceof Separator).length;
  const values = choices.filter((c): c is { value: string } => !(c instanceof Separator)).map((c) => c.value);

  assert.ok(separatorCount > 0);
  assert.ok(values.length >= PRESET_TYPES.length + groupNames.length);
  for (const value of values) {
    assert.ok(knownNames.has(value), `${value} is not a known preset or preset group`);
  }
  for (const name of knownNames) {
    assert.ok(values.includes(name), `${name} is missing from the picker`);
  }
});
