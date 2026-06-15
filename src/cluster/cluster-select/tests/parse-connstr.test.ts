/**
 * Unit tests for parseConnstr.
 *
 * Run on their own:
 *   bun test
 *   node --import tsx --test src/workflows/cluster/cluster-select/tests/parse-connstr.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConnstr } from "../parse-connstr.js";

test("the connection string is parsed out, skipping the log lines", () => {
  const output = `2026-06-03T13:08:23.288+0100    INFO    logger initialized
2026-06-03T13:08:23.288+0100    INFO    attempting to identify cluster  {"input": "df45d6d0-cfbe-4905-bc8c-989a09c03817"}
2026-06-03T13:08:23.288+0100    INFO    identified available deployers  {"deployers": ["docker", "cao"]}
couchbase://172.18.0.2
`;
  assert.equal(parseConnstr(output), "couchbase://172.18.0.2");
});

test("a couchbases:// connection string is recognised", () => {
  assert.equal(parseConnstr("couchbases://cb.example.com"), "couchbases://cb.example.com");
});

test("surrounding whitespace is trimmed", () => {
  assert.equal(parseConnstr("  couchbase://172.18.0.2  \n"), "couchbase://172.18.0.2");
});

test("output with no connection string yields null", () => {
  const output = `2026-06-03T13:08:23.288+0100    INFO    logger initialized
2026-06-03T13:08:23.288+0100    ERROR   failed to identify cluster
`;
  assert.equal(parseConnstr(output), null);
});

test("empty output yields null", () => {
  assert.equal(parseConnstr(""), null);
});
