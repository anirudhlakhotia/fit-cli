/**
 * Unit tests for parseAllocatedId.
 *
 * Run on their own:
 *   npm test
 *   node --import tsx --test src/workflows/cluster/cluster-create/tests/parse-allocated-id.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAllocatedId } from "../parse-allocated-id.js";

test("the cluster UUID is parsed off its own line", () => {
  assert.equal(
    parseAllocatedId("df45d6d0-cfbe-4905-bc8c-989a09c03817\n"),
    "df45d6d0-cfbe-4905-bc8c-989a09c03817",
  );
});

test("a stray log line on the same stream is ignored", () => {
  const output = `2026-06-03T13:08:23.288+0100    INFO    logger initialized
df45d6d0-cfbe-4905-bc8c-989a09c03817
`;
  assert.equal(parseAllocatedId(output), "df45d6d0-cfbe-4905-bc8c-989a09c03817");
});

test("the last UUID line wins", () => {
  const output = `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
df45d6d0-cfbe-4905-bc8c-989a09c03817`;
  assert.equal(parseAllocatedId(output), "df45d6d0-cfbe-4905-bc8c-989a09c03817");
});

test("a UUID embedded in a longer line is not treated as the id", () => {
  const output = "allocated cluster df45d6d0-cfbe-4905-bc8c-989a09c03817 ok";
  assert.equal(parseAllocatedId(output), null);
});

test("output with no UUID yields null", () => {
  assert.equal(parseAllocatedId("Clusters:\n  (none)\n"), null);
});

test("empty output yields null", () => {
  assert.equal(parseAllocatedId(""), null);
});
