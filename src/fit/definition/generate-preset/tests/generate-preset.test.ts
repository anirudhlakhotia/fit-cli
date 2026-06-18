import assert from "node:assert/strict";
import test from "node:test";
import { generatePreset, parseGeneratePresetArgs } from "../generate-preset.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("parseGeneratePresetArgs derives sdk from performer image and accepts output", () => {
  const args = parseGeneratePresetArgs([
    "--type",
    "preset-functional-tests",
    "--performer-image-name",
    "java-fit-performer:refs-changes-67-246067-3",
    "--output",
    "/tmp/generated-fit.yaml",
  ]);

  assert.deepEqual(args, {
    type: "preset-functional-tests",
    image: "java-fit-performer:refs-changes-67-246067-3",
    outputPath: "/tmp/generated-fit.yaml",
    pushGistVisibility: undefined,
  });
});

test("parseGeneratePresetArgs normalises a fully-qualified GHCR image to short form", () => {
  const args = parseGeneratePresetArgs([
    "--type=preset-functional-tests",
    "--performer-image-name=ghcr.io/couchbase/java-fit-performer:refs-changes-67-246067-3",
    "--output=/tmp/generated-fit.yaml",
  ]);

  assert.equal(args.type, "preset-functional-tests");
  assert.equal(args.image, "java-fit-performer:refs-changes-67-246067-3");
  assert.equal(args.outputPath, "/tmp/generated-fit.yaml");
});

test("parseGeneratePresetArgs requires a performer image name", () => {
  assert.throws(
    () =>
      parseGeneratePresetArgs([
        "--type=preset-functional-tests",
      ]),
    /--performer-image-name is required/,
  );
});

test("parseGeneratePresetArgs rejects an SDK without prebuilt images", () => {
  assert.throws(
    () =>
      parseGeneratePresetArgs([
        "--type=preset-functional-tests",
        "--performer-image-name=python-fit-performer:main",
      ]),
    /publish prebuilt performer images/,
  );
});

test("parseGeneratePresetArgs rejects the removed sdk flag", () => {
  assert.throws(
    () =>
      parseGeneratePresetArgs([
        "--type=preset-functional-tests",
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
        "--type=preset-functional-tests",
        "--cluster-version=8.0-stable",
        "--performer-image-name=java-fit-performer:refs-changes-67-246067-3",
      ]),
    /Unexpected argument: --cluster-version=8\.0-stable/,
  );
});

test("generatePreset writes YAML when the output path ends in .yaml", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-generate-preset-"));
  const outputPath = join(dir, "generated.yaml");

  await generatePreset({
    type: "preset-functional-tests",
    image: "java-fit-performer:refs-changes-67-246067-3",
    outputPath,
  });

  const written = readFileSync(outputPath, "utf8");
  assert.match(written, /^version: 1$/m);
  assert.match(written, /^type: fit$/m);
  assert.doesNotMatch(written, /^\{$/m);
});
