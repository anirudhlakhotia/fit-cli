import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSlackToken } from "../../util/config.js";

// fetchSecret is injected (not mocked with a library) and returns a resolved
// Promise without `async`, matching the codebase's resolveGithubToken tests and
// keeping the require-await lint rule happy.

test("resolveSlackToken prefers SLACK_BOT_TOKEN from the env", async () => {
  const token = await resolveSlackToken({
    env: { SLACK_BOT_TOKEN: "xoxb-from-env" },
    fetchSecret: () => Promise.resolve({ token: "xoxb-from-aws" }),
  });
  assert.equal(token, "xoxb-from-env");
});

test("resolveSlackToken falls back to the AWS secret's token field", async () => {
  const token = await resolveSlackToken({
    env: {},
    fetchSecret: () => Promise.resolve({ token: "xoxb-from-aws" }),
  });
  assert.equal(token, "xoxb-from-aws");
});

test("resolveSlackToken returns undefined when neither env nor secret is available", async () => {
  const token = await resolveSlackToken({
    env: {},
    fetchSecret: () => Promise.reject(new Error("no secret")),
  });
  assert.equal(token, undefined);
});
