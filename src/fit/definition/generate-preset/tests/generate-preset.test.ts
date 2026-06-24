import assert from "node:assert/strict";
import test from "node:test";
import { applyDotPathOverride, generatePreset, parseGeneratePresetArgs, presetUsesAnalyticsDriver } from "../generate-preset.js";
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
  assert.equal(presetUsesAnalyticsDriver("functional"), false);
});
