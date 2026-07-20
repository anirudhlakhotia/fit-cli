import assert from "node:assert/strict";
import test from "node:test";
import { PREBUILT_PERFORMER_SDKS } from "../../../../util/sdk/sdks.js";
import { resolvePerformerListSdks } from "../list-performer.js";

test("resolvePerformerListSdks with no arg returns every prebuilt-performer SDK", () => {
  const result = resolvePerformerListSdks();
  assert.ok(Array.isArray(result));
  assert.deepEqual(
    result.map((s) => s.value),
    PREBUILT_PERFORMER_SDKS.map((s) => s.value),
  );
});

test("resolvePerformerListSdks resolves an SDK by value", () => {
  const result = resolvePerformerListSdks("scala");
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 1);
  assert.equal(result[0].value, "scala");
});

test("resolvePerformerListSdks resolves C++ by its image basename cxx", () => {
  const result = resolvePerformerListSdks("cxx");
  assert.ok(Array.isArray(result));
  assert.equal(result[0]?.value, "cpp");
});

test("resolvePerformerListSdks ignores surrounding whitespace", () => {
  const result = resolvePerformerListSdks("  scala  ");
  assert.ok(Array.isArray(result));
  assert.equal(result[0]?.value, "scala");
});

test("resolvePerformerListSdks rejects an unknown SDK", () => {
  const result = resolvePerformerListSdks("banana");
  assert.ok("error" in result);
  assert.match(result.error, /Unknown SDK/);
});

test("resolvePerformerListSdks rejects an SDK that publishes no performer image", () => {
  const result = resolvePerformerListSdks("node");
  assert.ok("error" in result);
  assert.match(result.error, /does not publish/);
});
