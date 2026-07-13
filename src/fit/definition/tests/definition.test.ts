import assert from "node:assert/strict";
import test from "node:test";
import { isMachineOutputDefinitionSubcommand } from "../definition.js";

// main.ts uses this to decide whether to install the timestamped stdout wrapper
// and print the "Ran with:" banner. A false negative here means CI's
// `presets=$(fit definition expand-preset-group ... --json)` captures log noise
// instead of the payload, and GHA rejects $GITHUB_OUTPUT with "Invalid format".
test("machine-output subcommands are recognised whatever flags follow", () => {
  assert.equal(isMachineOutputDefinitionSubcommand(["expand-preset-group", "op-multi-release", "--json"]), true);
  assert.equal(isMachineOutputDefinitionSubcommand(["expand-preset-group", "op-multi-release"]), true);
  assert.equal(isMachineOutputDefinitionSubcommand(["generate-desc", "test.json5"]), true);
});

test("human-facing subcommands keep their normal logging", () => {
  assert.equal(isMachineOutputDefinitionSubcommand(["list-presets"]), false);
  assert.equal(isMachineOutputDefinitionSubcommand(["validate", "test.json5"]), false);
  assert.equal(isMachineOutputDefinitionSubcommand(["generate-preset", "--type", "op-onprem-func-release"]), false);
  assert.equal(isMachineOutputDefinitionSubcommand([]), false);
});
