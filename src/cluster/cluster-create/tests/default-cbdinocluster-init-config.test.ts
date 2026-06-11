import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultCbdinoclusterInitArgs,
  situationalCbdinoclusterConfigPatch,
  situationalCbdinoclusterInitArgs,
} from "../default-cbdinocluster-init-config.js";

test("default init args disable Capella (functional doesn't need it)", () => {
  assert.match(defaultCbdinoclusterInitArgs(), /--disable-capella/);
});

test("situational init args leave Capella enabled so `init --auto` populates it from CAPELLA_* env", () => {
  const args = situationalCbdinoclusterInitArgs();
  assert.doesNotMatch(args, /--disable-capella/);
  // AWS still disabled at init (the config patch flips aws.enabled on afterwards).
  assert.match(args, /--disable-aws/);
});

test("situational config patch only enables aws and must NOT carry a capella block", () => {
  // A capella block here would shallow-overwrite the one `init --auto` wrote from env.
  const patch = situationalCbdinoclusterConfigPatch();
  assert.deepEqual(patch, { aws: { enabled: "true" } });
  assert.equal("capella" in patch, false);
});
