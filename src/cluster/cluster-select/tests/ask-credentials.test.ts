/**
 * Unit tests for ask-credentials prompt policy.
 *
 * Run on their own:
 *   npm test
 *   node --import tsx --test src/workflows/cluster/cluster-select/tests/ask-credentials.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { credentialPromptPolicy, DEFAULT_CREDENTIALS } from "../ask-credentials.js";

test("self-managed clusters keep the built-in default credentials", () => {
  assert.deepEqual(credentialPromptPolicy("self-managed"), {
    usernameDefault: DEFAULT_CREDENTIALS.username,
    passwordDefault: DEFAULT_CREDENTIALS.password,
  });
});

test("internal Capella clusters require explicit credentials and show guidance", () => {
  const policy = credentialPromptPolicy("internal-capella");
  assert.equal(policy.usernameDefault, undefined);
  assert.equal(policy.passwordDefault, undefined);
  assert.deepEqual(policy.guidance, [
    "→ Capella reminder: create a database user in the Capella UI for FIT to use.",
    "→ Also whitelist this machine's IP address there (or allow all IPs while testing).",
  ]);
});

test("production Capella clusters use the same explicit-credentials guidance", () => {
  assert.deepEqual(credentialPromptPolicy("production-capella"), credentialPromptPolicy("internal-capella"));
});
