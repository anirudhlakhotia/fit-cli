/**
 * Unit tests for buildHostedDatabase.
 *
 * Run on their own:
 *   node --import tsx --test src/workflows/fit-shared/tests/choose-results-database.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildHostedDatabase,
  HOSTED_RESULTS_DB_JDBC,
} from "../../situational/choose-results-database/choose-results-database.js";

test("returns undefined when the password is missing or blank", () => {
  assert.equal(buildHostedDatabase({}), undefined);
  assert.equal(buildHostedDatabase({ password: "   " }), undefined);
});

test("builds the hosted connection from the password, defaulting the username", () => {
  assert.deepEqual(buildHostedDatabase({ password: "secret" }), {
    jdbc: HOSTED_RESULTS_DB_JDBC,
    username: "postgres",
    password: "secret",
  });
});

test("an explicit username overrides the default", () => {
  const database = buildHostedDatabase({ password: "secret", username: "readonly" });
  assert.equal(database?.username, "readonly");
});
