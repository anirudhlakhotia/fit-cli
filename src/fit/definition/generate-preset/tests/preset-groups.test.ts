import assert from "node:assert/strict";
import test from "node:test";
import { expandPresetGroupNames } from "../preset-groups.js";

test("expandPresetGroupNames on an unknown name throws the same listing fit preset list shows", () => {
  assert.throws(() => expandPresetGroupNames("not-a-real-preset"), (err: Error) => {
    assert.match(err.message, /^Unknown preset or preset group: not-a-real-preset/);
    // The old compact "Known presets:\n  tag: a, b, c" format had no per-preset
    // descriptions — asserting one is present here locks in that the error now
    // reuses fit preset list's full listing rather than that compact form.
    assert.match(err.message, /op-onprem-func-lite\s+Operational SDK functional testing against an on-prem cluster/);
    return true;
  });
});
