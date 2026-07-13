import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDotPathOverride,
  autoDescribeName,
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
    "op-onprem-func-lite",
    "--performer-image-name",
    "java-fit-performer:refs-changes-67-246067-3",
    "--output",
    "/tmp/generated-fit.yaml",
  ]);

  assert.deepEqual(args, {
    type: "op-onprem-func-lite",
    image: "java-fit-performer:refs-changes-67-246067-3",
    outputPath: "/tmp/generated-fit.yaml",
    pushGistVisibility: undefined,
  });
});

test("parseGeneratePresetArgs normalises a fully-qualified GHCR image to short form", () => {
  const args = parseGeneratePresetArgs([
    "--type=op-onprem-func-lite",
    "--performer-image-name=ghcr.io/couchbase/java-fit-performer:refs-changes-67-246067-3",
    "--output=/tmp/generated-fit.yaml",
  ]);

  assert.equal(args.type, "op-onprem-func-lite");
  assert.equal(args.image, "java-fit-performer:refs-changes-67-246067-3");
  assert.equal(args.outputPath, "/tmp/generated-fit.yaml");
});

test("parseGeneratePresetArgs requires a performer image name", () => {
  assert.throws(
    () =>
      parseGeneratePresetArgs([
        "--type=op-onprem-func-lite",
      ]),
    /--performer-image-name is required/,
  );
});

test("parseGeneratePresetArgs rejects an SDK without prebuilt images", () => {
  assert.throws(
    () =>
      parseGeneratePresetArgs([
        "--type=op-onprem-func-lite",
        "--performer-image-name=python-fit-performer:main",
      ]),
    /publish prebuilt performer images/,
  );
});

test("parseGeneratePresetArgs rejects the removed sdk flag", () => {
  assert.throws(
    () =>
      parseGeneratePresetArgs([
        "--type=op-onprem-func-lite",
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
        "--type=op-onprem-func-lite",
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
    "--type=op-onprem-func-lite",
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
    type: "op-onprem-func-lite",
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
    type: "op-onprem-func-lite",
    image: "java-fit-performer:refs-changes-67-246067-3",
    outputPath,
    overrides: { "setup.repos.transactions-fit-performer.gerritRef": "refs/changes/32/247532/1" },
  });

  const written = readFileSync(outputPath, "utf8");
  assert.match(written, /gerritRef: refs\/changes\/32\/247532\/1/);
});

test("presetUsesAnalyticsDriver detects analytics presets but not operational ones", () => {
  assert.equal(presetUsesAnalyticsDriver("enterprise-analytics-func-lite"), true);
  assert.equal(presetUsesAnalyticsDriver("enterprise-analytics-func-sanity"), true);
  assert.equal(presetUsesAnalyticsDriver("op-onprem-func-lite"), false);
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
    { type: "a", tags: ["cng", "capella"] },
    { type: "b", tags: ["cng"] },
  ]);
  const byTag = new Map(groups.map(({ tag, items }) => [tag, items.map((i) => i.type)]));
  assert.deepEqual(byTag.get("cng"), ["a", "b"]);
  assert.deepEqual(byTag.get("capella"), ["a"]);
});

test("groupPresetsByTag orders groups by each tag's order in presets/tags.json5, with unknown tags after known ones and untagged last", () => {
  const groups = groupPresetsByTag([
    { type: "z", tags: [] },
    { type: "a", tags: ["not-a-real-tag"] },
    // Item name order here is deliberately the opposite of tag order (cng=30,
    // pe=50 in tags.json5), to assert groups sort by *tag* order.
    { type: "b", tags: ["pe"] },
    { type: "c", tags: ["cng"] },
  ]);
  assert.deepEqual(groups.map((g) => g.tag), ["cng", "pe", "not-a-real-tag", "(untagged)"]);
});

test("groupPresetsByTag breaks a group-order tie alphabetically by tag", () => {
  const groups = groupPresetsByTag([
    { type: "a", tags: ["zzz"] },
    { type: "b", tags: ["aaa"] },
  ]);
  assert.deepEqual(groups.map((g) => g.tag), ["aaa", "zzz"]);
});

test("groupPresetsByTag sorts items within a tag alphabetically", () => {
  const groups = groupPresetsByTag([
    { type: "zebra", tags: ["cng"] },
    { type: "apple", tags: ["cng"] },
  ]);
  assert.deepEqual(groups[0].items.map((i) => i.type), ["apple", "zebra"]);
});

test("groupPresetsByTag hides a tag marked hiddenFromList in presets/tags.json5 by default, but shows it when showHidden is passed", () => {
  const items = [{ type: "a", tags: ["functional", "cng"] }];
  const hidden = groupPresetsByTag(items);
  assert.deepEqual(hidden.map((g) => g.tag), ["cng"]);
  const shown = groupPresetsByTag(items, { showHidden: true });
  assert.deepEqual(shown.map((g) => g.tag).sort(), ["cng", "functional"]);
});

test("autoDescribeName describes a preset from its name and tags, leading with the SDK family", () => {
  assert.equal(
    autoDescribeName("op-capella-sit-lite", ["capella", "situational"]),
    "Operational SDK situational testing against a real Capella cluster (lite-tier testing).",
  );
  assert.equal(
    autoDescribeName("op-capella-pe-func-release", ["pe", "functional"]),
    "Operational SDK functional testing against a real Capella cluster via Private Endpoint (PrivateLink) (release sign-off testing).",
  );
  assert.equal(
    autoDescribeName("columnar-func-lite", ["columnar", "functional"]),
    "Columnar SDK functional testing against a Capella Analytics (cloud) cluster (lite-tier testing).",
  );
});

test("autoDescribeName describes an on-prem preset/group with its own explicit cluster token, distinguishing it from op-multi-*", () => {
  assert.equal(
    autoDescribeName("op-onprem-sanity", ["onprem", "functional"]),
    "Operational SDK functional testing against an on-prem cluster (quick sanity testing).",
  );
});

test("autoDescribeName describes a group from its tags, not by parsing a func/sit token out of its name", () => {
  assert.equal(
    autoDescribeName("op-cng-lite", ["cng", "functional", "situational"]),
    "Operational SDK functional and situational testing against a CNG cluster (lite-tier testing).",
  );
});

test("autoDescribeName scopes a cross-axis 'multi' group to one SDK family, never mixing families", () => {
  assert.equal(
    autoDescribeName("op-multi-sanity", ["operational", "functional", "situational"]),
    "Operational SDK functional and situational testing across every axis (quick sanity testing).",
  );
  assert.equal(
    autoDescribeName("op-multi-func-lite", ["operational", "functional"]),
    "Operational SDK functional testing across every axis (lite-tier testing).",
  );
  assert.equal(
    autoDescribeName("columnar-multi-func-release", ["columnar", "functional"]),
    "Columnar SDK functional testing across every axis (release sign-off testing).",
  );
});
