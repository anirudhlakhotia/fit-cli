/**
 * Unit tests for parseSecurityGroupId.
 *
 * Run on their own:
 *   node --import tsx --test src/util/non-fit/aws/tests/parse-security-group.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSecurityGroupId } from "../parse-security-group.js";

test("returns the first group's id", () => {
  const response = { SecurityGroups: [{ GroupId: "sg-123", GroupName: "fit-cli" }] };
  assert.equal(parseSecurityGroupId(response), "sg-123");
});

test("returns null when no groups match", () => {
  assert.equal(parseSecurityGroupId({ SecurityGroups: [] }), null);
  assert.equal(parseSecurityGroupId({}), null);
});
