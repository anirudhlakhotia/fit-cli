/**
 * Unit tests for isTransientAwsFailure. The inputs are plain objects shaped like
 * AWS SDK v3 errors — no mocks, no IO.
 *
 * Run on their own:
 *   bun test
 *   node --import tsx --test src/cloud/util/aws/tests/transient-failure.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isTransientAwsFailure } from "../transient-failure.js";

/** An SDK error that got an HTTP response with `status`. */
function responded(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

test("isTransientAwsFailure: no HTTP response at all is transient (the dropped-socket case)", () => {
  const err = new Error("The socket connection was closed unexpectedly");
  assert.equal(isTransientAwsFailure(err), true);
});

test("isTransientAwsFailure: an error with $metadata but no status is transient", () => {
  assert.equal(isTransientAwsFailure(Object.assign(new Error("no response"), { $metadata: {} })), true);
});

test("isTransientAwsFailure: 5xx and 429 are transient", () => {
  assert.equal(isTransientAwsFailure(responded("InternalError", 500)), true);
  assert.equal(isTransientAwsFailure(responded("SlowDown", 503)), true);
  assert.equal(isTransientAwsFailure(responded("TooManyRequests", 429)), true);
});

test("isTransientAwsFailure: definitive 4xx answers are not transient", () => {
  assert.equal(isTransientAwsFailure(responded("AccessDenied", 403)), false);
  assert.equal(isTransientAwsFailure(responded("NoSuchBucket", 404)), false);
  assert.equal(isTransientAwsFailure(responded("InvalidRequest", 400)), false);
});

test("isTransientAwsFailure: expired credentials are transient despite being 4xx", () => {
  // The provider re-assumes fit-cli-role between attempts, so the next attempt
  // starts with a fresh session — worth retrying, unlike other 4xx answers.
  assert.equal(isTransientAwsFailure(responded("ExpiredToken", 400)), true);
  assert.equal(isTransientAwsFailure(responded("ExpiredTokenException", 403)), true);
  assert.equal(isTransientAwsFailure(responded("RequestExpired", 403)), true);
});

test("isTransientAwsFailure: the Code field is honoured as well as name", () => {
  const err = Object.assign(new Error("expired"), { Code: "ExpiredToken", $metadata: { httpStatusCode: 403 } });
  assert.equal(isTransientAwsFailure(err), true);
});

test("isTransientAwsFailure: a non-object throw is not transient", () => {
  assert.equal(isTransientAwsFailure("boom"), false);
  assert.equal(isTransientAwsFailure(null), false);
  assert.equal(isTransientAwsFailure(undefined), false);
});
