/**
 * Unit tests for parseDotenv.
 *
 * Run on their own:
 *   node --import tsx --test src/util/non-fit/tests/dotenv.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDotenv } from "../dotenv.js";

test("parses simple KEY=VALUE pairs", () => {
  assert.deepEqual(parseDotenv("AWS_REGION=us-east-1\nAWS_PROFILE=dev"), {
    AWS_REGION: "us-east-1",
    AWS_PROFILE: "dev",
  });
});

test("ignores blank lines and # comments", () => {
  const text = `# AWS settings\n\nAWS_REGION=eu-west-2\n   # indented comment\n`;
  assert.deepEqual(parseDotenv(text), { AWS_REGION: "eu-west-2" });
});

test("drops a leading export and trims keys and values", () => {
  assert.deepEqual(parseDotenv("export  FOO = bar "), { FOO: "bar" });
});

test("unquotes values wrapped in matching quotes", () => {
  assert.deepEqual(parseDotenv(`A="hello world"\nB='single'`), { A: "hello world", B: "single" });
});

test("splits only on the first equals sign", () => {
  assert.deepEqual(parseDotenv("JDBC=jdbc:postgresql://host:5432/perf?a=b"), {
    JDBC: "jdbc:postgresql://host:5432/perf?a=b",
  });
});

test("skips lines without an equals sign", () => {
  assert.deepEqual(parseDotenv("NOPE\nOK=1"), { OK: "1" });
});
