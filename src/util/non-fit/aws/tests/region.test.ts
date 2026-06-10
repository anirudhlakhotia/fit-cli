import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_AWS_REGION,
  awsRegionPromptMessage,
  defaultAwsRegionMessage,
  resolveAwsRegion,
} from "../region.js";

test("resolveAwsRegion prefers an explicit region", () => {
  assert.deepEqual(resolveAwsRegion({ region: "eu-west-1", env: { AWS_REGION: "us-east-2" } }), {
    region: "eu-west-1",
    source: "option",
  });
});

test("resolveAwsRegion falls back to the environment", () => {
  assert.deepEqual(resolveAwsRegion({ env: { AWS_DEFAULT_REGION: "us-west-2" } }), {
    region: "us-west-2",
    source: "env",
  });
});

test("resolveAwsRegion defaults to us-west-2 when nothing is set", () => {
  assert.deepEqual(resolveAwsRegion({ env: {} }), {
    region: DEFAULT_AWS_REGION,
    source: "default",
  });
});

test("region guidance mentions how to override the default", () => {
  assert.match(defaultAwsRegionMessage(), /defaulting to us-west-2/);
  assert.match(defaultAwsRegionMessage(), /AWS_REGION/);
  assert.match(defaultAwsRegionMessage(), /npm run init/);
  assert.match(awsRegionPromptMessage("eu-west-1"), /default: eu-west-1/);
  assert.match(awsRegionPromptMessage("eu-west-1"), /--region/);
});
