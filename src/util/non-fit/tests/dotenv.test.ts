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

test("trims whitespace around key and value", () => {
  assert.deepEqual(parseDotenv("  AWS_REGION =  us-east-1  "), { AWS_REGION: "us-east-1" });
});

test("strips a leading export and matching surrounding quotes", () => {
  const text = `export AWS_SECRET_ACCESS_KEY="abc=def"\nAWS_ACCESS_KEY_ID='AKIA123'`;
  assert.deepEqual(parseDotenv(text), {
    AWS_SECRET_ACCESS_KEY: "abc=def",
    AWS_ACCESS_KEY_ID: "AKIA123",
  });
});

test("keeps only the first = as the separator", () => {
  assert.deepEqual(parseDotenv("URL=https://example.com/?a=1&b=2"), {
    URL: "https://example.com/?a=1&b=2",
  });
});

test("skips lines without an = and lines with an empty key", () => {
  assert.deepEqual(parseDotenv("garbage line\n=novalue\nAWS_REGION=us-east-1"), {
    AWS_REGION: "us-east-1",
  });
});

test("empty input yields an empty object", () => {
  assert.deepEqual(parseDotenv(""), {});
});
