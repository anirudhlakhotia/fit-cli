import assert from "node:assert/strict";
import { test } from "node:test";
import { warningBox } from "../check-platform.js";

test("warningBox pads both lines to the same width and closes the border", () => {
  const box = warningBox("Windows");
  const lines = box.trimEnd().split("\n");

  assert.equal(lines.length, 4);
  const [top, first, second, bottom] = lines;
  assert.equal(top.length, bottom.length);
  assert.equal(first.length, second.length);
  assert.equal(first.length, top.length);
  assert.match(first, /WARNING: FIT CLI has not been tested on Windows\./);
});
