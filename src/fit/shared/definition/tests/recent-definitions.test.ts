import assert from "node:assert/strict";
import test from "node:test";
import { trimRecentDefinitions, type RecentDefinitionEntry } from "../recent-definitions.js";

function makeEntry(path: string, description = "desc"): RecentDefinitionEntry {
  return { path, createdAt: "2026-01-01T00:00:00.000Z", description };
}

test("trimRecentDefinitions: prepends new entry", () => {
  const existing = [makeEntry("/tmp/fit-cli/old/fit.json5")];
  const result = trimRecentDefinitions(existing, makeEntry("/tmp/fit-cli/new/fit.json5"));
  assert.equal(result[0].path, "/tmp/fit-cli/new/fit.json5");
  assert.equal(result[1].path, "/tmp/fit-cli/old/fit.json5");
});

test("trimRecentDefinitions: works when existing is empty", () => {
  const result = trimRecentDefinitions([], makeEntry("/tmp/fit-cli/a/fit.json5"));
  assert.equal(result.length, 1);
  assert.equal(result[0].path, "/tmp/fit-cli/a/fit.json5");
});

test("trimRecentDefinitions: trims to 15 entries", () => {
  const existing = Array.from({ length: 15 }, (_, i) => makeEntry(`/tmp/fit-cli/${i}/fit.json5`));
  const result = trimRecentDefinitions(existing, makeEntry("/tmp/fit-cli/new/fit.json5"));
  assert.equal(result.length, 15);
  assert.equal(result[0].path, "/tmp/fit-cli/new/fit.json5");
  assert.equal(result[14].path, "/tmp/fit-cli/13/fit.json5");
});

test("trimRecentDefinitions: does not mutate the existing array", () => {
  const existing = [makeEntry("/tmp/fit-cli/a/fit.json5")];
  const snapshot = [...existing];
  trimRecentDefinitions(existing, makeEntry("/tmp/fit-cli/b/fit.json5"));
  assert.deepEqual(existing, snapshot);
});
