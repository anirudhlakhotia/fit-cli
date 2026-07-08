import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDotPathOverride,
  describeTag,
  generatePreset,
  groupPresetsByTag,
  parseGeneratePresetArgs,
  presetDescriptions,
  presetUsesAnalyticsDriver,
} from "../generate-preset.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("parseGeneratePresetArgs derives sdk from performer image and accepts output", () => {
  const args = parseGeneratePresetArgs([
    "--type",
    "functional",
    "--performer-image-name",
    "java-fit-performer:refs-changes-67-246067-3",
    "--output",
    "/tmp/generated-fit.yaml",
  ]);

  assert.deepEqual(args, {
    type: "functional",
    image: "java-fit-performer:refs-changes-67-246067-3",
    outputPath: "/tmp/generated-fit.yaml",
    pushGistVisibility: undefined,
  });
});

test("parseGeneratePresetArgs normalises a fully-qualified GHCR image to short form", () => {
  const args = parseGeneratePresetArgs([
    "--type=functional",
    "--performer-image-name=ghcr.io/couchbase/java-fit-performer:refs-changes-67-246067-3",
    "--output=/tmp/generated-fit.yaml",
  ]);

  assert.equal(args.type, "functional");
  assert.equal(args.image, "java-fit-performer:refs-changes-67-246067-3");
  assert.equal(args.outputPath, "/tmp/generated-fit.yaml");
});

test("parseGeneratePresetArgs requires a performer image name", () => {
  assert.throws(
    () =>
      parseGeneratePresetArgs([
        "--type=functional",
      ]),
    /--performer-image-name is required/,
  );
});

test("parseGeneratePresetArgs rejects an SDK without prebuilt images", () => {
  assert.throws(
    () =>
      parseGeneratePresetArgs([
        "--type=functional",
        "--performer-image-name=python-fit-performer:main",
      ]),
    /publish prebuilt performer images/,
  );
});

test("parseGeneratePresetArgs rejects the removed sdk flag", () => {
  assert.throws(
    () =>
      parseGeneratePresetArgs([
        "--type=functional",
        "--sdk=java",
        "--performer-image-name=java-fit-performer:refs-changes-67-246067-3",
      ]),
    /Unexpected argument: --sdk=java/,
  );
});

test("parseGeneratePresetArgs rejects the removed cluster-version flag", () => {
  assert.throws(
    () =>
      parseGeneratePresetArgs([
        "--type=functional",
        "--cluster-version=8.0-stable",
        "--performer-image-name=java-fit-performer:refs-changes-67-246067-3",
      ]),
    /Unexpected argument: --cluster-version=8\.0-stable/,
  );
});

test("applyDotPathOverride sets a nested string value", () => {
  const obj: Record<string, unknown> = {};
  applyDotPathOverride(obj, "setup.repos.transactions-fit-performer.gerritRef", "refs/changes/32/247532/1");
  assert.deepEqual(obj, {
    setup: { repos: { "transactions-fit-performer": { gerritRef: "refs/changes/32/247532/1" } } },
  });
});

test("applyDotPathOverride coerces boolean and numeric strings", () => {
  const obj: Record<string, unknown> = {};
  applyDotPathOverride(obj, "a.b", "true");
  applyDotPathOverride(obj, "a.c", "42");
  assert.equal((obj.a as Record<string, unknown>).b, true);
  assert.equal((obj.a as Record<string, unknown>).c, 42);
});

test("applyDotPathOverride overwrites an existing leaf", () => {
  const obj = { setup: { repos: { "transactions-fit-performer": { gerritRef: "old" } } } };
  applyDotPathOverride(obj as unknown as Record<string, unknown>, "setup.repos.transactions-fit-performer.gerritRef", "new");
  assert.equal(obj.setup.repos["transactions-fit-performer"].gerritRef, "new");
});

test("applyDotPathOverride handles a single-segment path", () => {
  const obj: Record<string, unknown> = { existing: 1 };
  applyDotPathOverride(obj, "version", "2");
  assert.equal(obj.version, 2);
  assert.equal(obj.existing, 1);
});

test("parseGeneratePresetArgs collects --override flags", () => {
  const args = parseGeneratePresetArgs([
    "--type=functional",
    "--performer-image-name=java-fit-performer:main",
    "--override",
    "setup.repos.transactions-fit-performer.gerritRef=refs/changes/32/247532/1",
    "--override=setup.repos.transactions-fit-performer.otherField=hello",
  ]);
  assert.deepEqual(args.overrides, {
    "setup.repos.transactions-fit-performer.gerritRef": "refs/changes/32/247532/1",
    "setup.repos.transactions-fit-performer.otherField": "hello",
  });
});

test("generatePreset writes YAML when the output path ends in .yaml", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-generate-preset-"));
  const outputPath = join(dir, "generated.yaml");

  await generatePreset({
    type: "functional",
    image: "java-fit-performer:refs-changes-67-246067-3",
    outputPath,
  });

  const written = readFileSync(outputPath, "utf8");
  assert.match(written, /^version: 1$/m);
  assert.match(written, /^type: fit$/m);
  assert.doesNotMatch(written, /^\{$/m);
});

test("generatePreset applies overrides to the written file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-generate-preset-"));
  const outputPath = join(dir, "generated.yaml");

  await generatePreset({
    type: "functional",
    image: "java-fit-performer:refs-changes-67-246067-3",
    outputPath,
    overrides: { "setup.repos.transactions-fit-performer.gerritRef": "refs/changes/32/247532/1" },
  });

  const written = readFileSync(outputPath, "utf8");
  assert.match(written, /gerritRef: refs\/changes\/32\/247532\/1/);
});

test("presetUsesAnalyticsDriver detects analytics presets but not operational ones", () => {
  assert.equal(presetUsesAnalyticsDriver("enterprise-analytics-functional"), true);
  assert.equal(presetUsesAnalyticsDriver("enterprise-analytics-functional-quick-sanity"), true);
  assert.equal(presetUsesAnalyticsDriver("functional"), false);
});

test("presetDescriptions reports every preset with at least one tag", () => {
  const presets = presetDescriptions();
  assert.ok(presets.length > 0);
  for (const preset of presets) {
    assert.ok(preset.tags.length > 0, `${preset.type} has no tags`);
  }
});

test("every tag used by a preset has a description in presets/tags.json5", () => {
  const usedTags = new Set(presetDescriptions().flatMap((p) => p.tags));
  for (const tag of usedTags) {
    assert.ok(describeTag(tag), `tag "${tag}" is missing a description in presets/tags.json5`);
  }
});

test("describeTag returns undefined for a tag with no metadata", () => {
  assert.equal(describeTag("not-a-real-tag"), undefined);
});

test("groupPresetsByTag puts a multi-tagged preset under each of its tags", () => {
  const groups = groupPresetsByTag([
    { type: "a", order: 10, tags: ["functional", "situational"] },
    { type: "b", order: 20, tags: ["functional"] },
  ]);
  const byTag = new Map(groups.map(({ tag, items }) => [tag, items.map((i) => i.type)]));
  assert.deepEqual(byTag.get("functional"), ["a", "b"]);
  assert.deepEqual(byTag.get("situational"), ["a"]);
});

test("groupPresetsByTag orders groups by each tag's order in presets/tags.json5, with unknown tags after known ones and untagged last", () => {
  const groups = groupPresetsByTag([
    { type: "z", order: 10, tags: [] },
    { type: "a", order: 20, tags: ["not-a-real-tag"] },
    // Preset order here is deliberately the opposite of tag order (functional=10,
    // situational=20 in tags.json5), to assert groups sort by *tag* order, not by
    // any member preset's own order.
    { type: "b", order: 5, tags: ["situational"] },
    { type: "c", order: 30, tags: ["functional"] },
  ]);
  assert.deepEqual(groups.map((g) => g.tag), ["functional", "situational", "not-a-real-tag", "(untagged)"]);
});

test("groupPresetsByTag breaks a group-order tie alphabetically by tag", () => {
  const groups = groupPresetsByTag([
    { type: "a", order: 10, tags: ["zzz"] },
    { type: "b", order: 10, tags: ["aaa"] },
  ]);
  assert.deepEqual(groups.map((g) => g.tag), ["aaa", "zzz"]);
});
