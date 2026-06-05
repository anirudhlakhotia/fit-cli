/**
 * Unit tests for hostedDatabaseFromEnv.
 *
 * Run on their own:
 *   node --import tsx --test src/workflows/fit-situational/tests/choose-results-database.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hostedDatabaseFromEnv,
  HOSTED_RESULTS_DB_JDBC,
  RESULTS_DB_PASSWORD_ENV,
} from "../choose-results-database/choose-results-database.js";

test("returns undefined when the password is missing or blank", () => {
  assert.equal(hostedDatabaseFromEnv({}), undefined);
  assert.equal(hostedDatabaseFromEnv({ [RESULTS_DB_PASSWORD_ENV]: "   " }), undefined);
});

test("builds the hosted connection from the password, defaulting the username", () => {
  assert.deepEqual(hostedDatabaseFromEnv({ [RESULTS_DB_PASSWORD_ENV]: "secret" }), {
    jdbc: HOSTED_RESULTS_DB_JDBC,
    username: "postgres",
    password: "secret",
  });
});

test("an explicit username overrides the default", () => {
  const database = hostedDatabaseFromEnv({
    [RESULTS_DB_PASSWORD_ENV]: "secret",
    FIT_RESULTS_DB_USERNAME: "readonly",
  });
  assert.equal(database?.username, "readonly");
});
