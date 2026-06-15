/**
 * Unit tests for the results-database helpers.
 *
 * Run on their own:
 *   bun run test src/fit/shared/tests/choose-results-database.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildHostedDatabase,
  DEFAULT_RESULTS_HOST,
  resultsDbJdbc,
  resultsHostFromJdbc,
  situationalResultsUrl,
} from "../../situational/choose-results-database/choose-results-database.js";

test("builds the hosted connection, deriving the JDBC URL from the host", () => {
  assert.deepEqual(buildHostedDatabase({ host: "faas.couchbase.com", username: "postgres", password: "secret" }), {
    jdbc: "jdbc:postgresql://faas.couchbase.com:5432/perf",
    username: "postgres",
    password: "secret",
  });
});

test("the host selects the results environment (DB + UI)", () => {
  assert.equal(resultsDbJdbc("performance-sdk.couchbase.com"), "jdbc:postgresql://performance-sdk.couchbase.com:5432/perf");
  assert.equal(
    situationalResultsUrl("performance-sdk.couchbase.com"),
    "https://performance-sdk.couchbase.com/results/situational",
  );
});

test("resultsHostFromJdbc round-trips the host out of a JDBC URL", () => {
  assert.equal(resultsHostFromJdbc(resultsDbJdbc("faas.couchbase.com")), "faas.couchbase.com");
  assert.equal(resultsHostFromJdbc("not a jdbc url"), DEFAULT_RESULTS_HOST);
});
