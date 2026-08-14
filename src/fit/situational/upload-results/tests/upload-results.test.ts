/**
 * Unit tests for planResultsUpload.
 *
 * Run on their own:
 *   bun test src/fit/situational/upload-results/tests/upload-results.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { planResultsUpload, type ResultsRunDir } from "../upload-results.js";

const RUN_A = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const RUN_B = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const SIT = "11111111-2222-3333-4444-555555555555";

function runDir(runUuid: string): ResultsRunDir {
  return {
    dirName: runUuid.slice(0, 8),
    runJson5: JSON.stringify({ forDatabase: { runUuid, cluster: "7.6-stable" } }),
  };
}

test("uploads each run under incoming/<situational>/<full run uuid>/", () => {
  const plan = planResultsUpload([runDir(RUN_A), runDir(RUN_B)], SIT);
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(
    plan.uploads.map((u) => u.keyPrefix),
    [`incoming/${SIT}/${RUN_A}`, `incoming/${SIT}/${RUN_B}`],
  );
});

test("groups all runs under one generated situational id when none is given", () => {
  const plan = planResultsUpload([runDir(RUN_A), runDir(RUN_B)], undefined, () => SIT);
  assert.equal(plan.situationalRunUuid, SIT);
  assert.deepEqual(
    plan.uploads.map((u) => u.keyPrefix),
    [`incoming/${SIT}/${RUN_A}`, `incoming/${SIT}/${RUN_B}`],
  );
});

test("lowercases the given situational id, since S3 keys are case-sensitive", () => {
  const plan = planResultsUpload([runDir(RUN_A)], SIT.toUpperCase());
  assert.equal(plan.situationalRunUuid, SIT);
});

test("skips a run dir with no run.json5", () => {
  const plan = planResultsUpload([{ dirName: "aaaaaaaa" }, runDir(RUN_B)], SIT);
  assert.equal(plan.uploads.length, 1);
  assert.match(plan.skipped[0], /^aaaaaaaa: no run\.json5/);
});

test("skips unparseable run.json5 and a uuid that doesn't match the dir", () => {
  const plan = planResultsUpload(
    [
      { dirName: "aaaaaaaa", runJson5: "{not json" },
      { dirName: "12345678", runJson5: JSON.stringify({ forDatabase: { runUuid: RUN_A } }) },
      { dirName: "bbbbbbbb", runJson5: JSON.stringify({ forDatabase: {} }) },
      { dirName: "cccccccc", runJson5: JSON.stringify({ forDatabase: { runUuid: 12345678 } }) },
    ],
    SIT,
  );
  assert.deepEqual(plan.uploads, []);
  assert.equal(plan.skipped.length, 4);
  assert.match(plan.skipped.find((s) => s.startsWith("12345678"))!, /is for run/);
  assert.match(plan.skipped.find((s) => s.startsWith("bbbbbbbb"))!, /no valid forDatabase\.runUuid/);
  assert.match(plan.skipped.find((s) => s.startsWith("cccccccc"))!, /no valid forDatabase\.runUuid/);
});

test("run.json5 written by the driver's JsonObject (json5 name, plain json content) parses", () => {
  // The exact JSON that SituationalRunner.writeRun produces
  const content =
    `{"forDatabase":{"runUuid":"${RUN_A}","cluster":"7.6-stable","privateEndpointsEnabled":false,` +
    `"impl":{"language":"java","version":"3.7.0"},"workload":{"situational":"CbDinoTest"},"vars":{},` +
    `"debug":{"items":[]}}}`;
  const plan = planResultsUpload([{ dirName: RUN_A.slice(0, 8), runJson5: content }], SIT);
  assert.equal(plan.uploads[0].runUuid, RUN_A);
});
