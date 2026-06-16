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
    sdkValue: "java",
    performerImageName: "refs-changes-67-246067-3",
    clusterVersion: undefined,
    outputPath: "/tmp/generated-fit.yaml",
    pushGistVisibility: undefined,
  });
});

test("parseGeneratePresetArgs accepts equals-style output flag", () => {
  const args = parseGeneratePresetArgs([
    "--type=preset-functional-tests",
    "--performer-image-name=ghcr.io/couchbase/java-fit-performer:refs-changes-67-246067-3",
    "--output=/tmp/generated-fit.yaml",
  ]);

  assert.equal(args.type, "preset-functional-tests");
  assert.equal(args.sdkValue, "java");
  assert.equal(args.performerImageName, "refs-changes-67-246067-3");
  assert.equal(args.outputPath, "/tmp/generated-fit.yaml");
});

test("parseGeneratePresetArgs requires an sdk-specific performer image name", () => {
  assert.throws(
    () =>
      parseGeneratePresetArgs([
        "--type=preset-functional-tests",
      ]),
    /--performer-image-name is required and must include an SDK-specific image/,
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

test("parseGeneratePresetArgs accepts --cluster-version", () => {
  const args = parseGeneratePresetArgs([
    "--type=preset-functional-tests",
    "--cluster-version=7.6.5",
    "--performer-image-name=java-fit-performer:refs-changes-67-246067-3",
  ]);
  assert.equal(args.clusterVersion, "7.6.5");
});

test("generatePreset writes YAML when the output path ends in .yaml", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-generate-preset-"));
  const outputPath = join(dir, "generated.yaml");

  await generatePreset({
    type: "preset-functional-tests",
    sdkValue: "java",
    performerImageName: "refs-changes-67-246067-3",
    outputPath,
  });

  const written = readFileSync(outputPath, "utf8");
  assert.match(written, /^version: 1$/m);
  assert.match(written, /^type: fit$/m);
  assert.doesNotMatch(written, /^\{$/m);
});

test("generatePreset substitutes cluster version and defaults to 8.0-stable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-generate-preset-"));

  const defaultPath = join(dir, "default.yaml");
  await generatePreset({ type: "preset-functional-tests", sdkValue: "java", outputPath: defaultPath });
  assert.match(readFileSync(defaultPath, "utf8"), /version: 8\.0-stable/);

  const customPath = join(dir, "custom.yaml");
  await generatePreset({ type: "preset-functional-tests", sdkValue: "java", clusterVersion: "7.6.5", outputPath: customPath });
  assert.match(readFileSync(customPath, "utf8"), /version: 7\.6\.5/);
});
