import assert from "node:assert/strict";
import { test } from "node:test";
import { fitInstanceName } from "../fit-instance.js";

test("fitInstanceName includes fit-cli, the creator and the UTC launch time to the minute", () => {
  // 10:37:42 UTC must render to the minute (no seconds) and in UTC regardless of
  // the local timezone.
  const at = new Date("2026-06-12T10:37:42.500Z");
  assert.equal(fitInstanceName("alice", at), "fit-cli-alice-20260612-1037");
});

test("fitInstanceName keeps a non-IAM-user creator identifier", () => {
  const at = new Date("2026-01-02T03:04:00.000Z");
  assert.equal(fitInstanceName("some-sso-session", at), "fit-cli-some-sso-session-20260102-0304");
});
