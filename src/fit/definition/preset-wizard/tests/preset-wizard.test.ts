import assert from "node:assert/strict";
import test from "node:test";
import { Separator } from "@inquirer/prompts";
import { PRESET_TYPES } from "../../generate-preset/generate-preset.js";
import { buildPresetTypeChoices } from "../preset-wizard.js";

test("buildPresetTypeChoices groups every preset under a separator, with valid values", () => {
  const choices = buildPresetTypeChoices();

  const separatorCount = choices.filter((c) => c instanceof Separator).length;
  const values = choices.filter((c): c is { value: string } => !(c instanceof Separator)).map((c) => c.value);

  assert.ok(separatorCount > 0);
  assert.ok(values.length >= PRESET_TYPES.length);
  for (const value of values) {
    assert.ok(PRESET_TYPES.includes(value), `${value} is not a known preset type`);
  }
  for (const type of PRESET_TYPES) {
    assert.ok(values.includes(type), `${type} is missing from the picker`);
  }
});
