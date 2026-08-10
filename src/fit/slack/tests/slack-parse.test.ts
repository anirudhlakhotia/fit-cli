import assert from "node:assert/strict";
import { test } from "node:test";
import { matchMessages, parseArgs, parseSlackMessageRef } from "../util/slack-parse.js";

test("parseArgs pulls value flags and leaves positionals", () => {
  assert.deepEqual(parseArgs(["hello", "world", "--channel", "C0123"], ["channel", "limit"]), {
    values: { channel: "C0123" },
    positionals: ["hello", "world"],
  });
});

test("parseArgs supports --flag=value form", () => {
  assert.deepEqual(parseArgs(["--limit=50", "text"], ["channel", "limit"]), {
    values: { limit: "50" },
    positionals: ["text"],
  });
});

test("parseSlackMessageRef passes through a raw ts", () => {
  assert.deepEqual(parseSlackMessageRef("1720000000.123456"), { ts: "1720000000.123456" });
});

test("parseSlackMessageRef converts a p-number", () => {
  assert.deepEqual(parseSlackMessageRef("p1720000000123456"), { ts: "1720000000.123456" });
});

test("parseSlackMessageRef extracts channel and ts from a permalink", () => {
  assert.deepEqual(
    parseSlackMessageRef("https://couchbase.slack.com/archives/C08FV3X1CCA/p1720000000123456"),
    { channel: "C08FV3X1CCA", ts: "1720000000.123456" },
  );
});

test("parseSlackMessageRef prefers thread_ts query param over the message p-number", () => {
  assert.deepEqual(
    parseSlackMessageRef(
      "https://couchbase.slack.com/archives/C08FV3X1CCA/p1720000009999999?thread_ts=1720000000.123456",
    ),
    { channel: "C08FV3X1CCA", ts: "1720000000.123456" },
  );
});

test("parseSlackMessageRef parses the compact channel:ts form", () => {
  assert.deepEqual(parseSlackMessageRef("C08FV3X1CCA:1720000000.123456"), {
    channel: "C08FV3X1CCA",
    ts: "1720000000.123456",
  });
});

test("parseSlackMessageRef rejects unrecognised input", () => {
  assert.throws(() => parseSlackMessageRef("not-a-ref"));
});

test("matchMessages is a case-insensitive substring filter", () => {
  const messages = [
    { ts: "1", text: "cxx nightly FAILED" },
    { ts: "2", text: "java nightly passed" },
    { ts: "3" },
  ];
  assert.deepEqual(
    matchMessages(messages, "failed").map((m) => m.ts),
    ["1"],
  );
});
