import assert from "node:assert/strict";
import { test } from "node:test";
import { renderSlackRunSummary } from "../util/slack-results.js";

test("renderSlackRunSummary marks an all-pass run with a ✅ header and fallback", () => {
  const { text, blocks } = renderSlackRunSummary({
    title: "op-func-lite",
    passed: true,
    results: [
      { label: "aws1 / java:main / func", sdk: "java:main", ok: true, testsRun: 412, failures: 0, errors: 0, skipped: 0, durationMs: 842000 },
    ],
  });
  assert.match(text, /^✅ op-func-lite/);
  const header = blocks[0] as { type: string; text: { text: string } };
  assert.equal(header.type, "header");
  assert.match(header.text.text, /^✅ op-func-lite/);
});

test("renderSlackRunSummary marks failures with ❌ and includes a failing-tests code block", () => {
  const { text, blocks } = renderSlackRunSummary({
    title: "op-capella-sit-lite",
    passed: false,
    results: [
      {
        label: "aws1 / java:main / func",
        sdk: "java:main",
        ok: false,
        testsRun: 388,
        failures: 3,
        errors: 0,
        skipped: 0,
        durationMs: 1001000,
        failingTests: [{ name: "ReplaceTest.concurrentReplace", detail: "assertion failed" }],
      },
    ],
  });
  assert.match(text, /^❌ op-capella-sit-lite — 1\/1 run failed/);
  const serialized = JSON.stringify(blocks);
  assert.match(serialized, /ReplaceTest\.concurrentReplace/);
  assert.match(serialized, /```/);
});

test("renderSlackRunSummary adds a GitHub Actions run link when provided", () => {
  const { blocks } = renderSlackRunSummary({
    title: "x",
    passed: true,
    results: [{ label: "l", sdk: "s", ok: true }],
    ghaRunUrl: "https://github.com/o/r/actions/runs/42",
  });
  assert.match(JSON.stringify(blocks), /actions\/runs\/42/);
});
