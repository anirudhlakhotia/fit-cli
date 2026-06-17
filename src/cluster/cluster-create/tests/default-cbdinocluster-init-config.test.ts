import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultCbdinoclusterInitArgs,
  situationalCbdinoclusterInitArgs,
} from "../default-cbdinocluster-init-config.js";

test("default init args disable Capella (functional doesn't need it)", () => {
  assert.match(defaultCbdinoclusterInitArgs(), /--disable-capella/);
});

test("default init args disable AWS (functional doesn't need it)", () => {
  assert.match(defaultCbdinoclusterInitArgs(), /--disable-aws/);
});

test("situational init args leave Capella enabled so `init --auto` populates it from CAPELLA_* env", () => {
  assert.doesNotMatch(situationalCbdinoclusterInitArgs(), /--disable-capella/);
});

test("situational init args include --aws-region so init --auto enables the aws block directly", () => {
  const args = situationalCbdinoclusterInitArgs();
  assert.doesNotMatch(args, /--disable-aws/);
  assert.match(args, /--aws-region /);
});
