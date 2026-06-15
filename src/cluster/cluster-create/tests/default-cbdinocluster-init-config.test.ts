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

test("situational config patch enables aws with region and must NOT carry a capella block", () => {
  // A capella block here would shallow-overwrite the one `init --auto` wrote from env.
  const patch = situationalCbdinoclusterConfigPatch();
  assert.equal((patch as any).aws?.enabled, "true");
  assert.ok((patch as any).aws?.region, "region must be set — cbdinocluster cleanup fails with 'Missing Region' without it");
  assert.equal("capella" in patch, false);
});
