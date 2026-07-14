import assert from "node:assert/strict";
import test from "node:test";
import { normaliseGenerateArgs } from "../preset.js";

test("normaliseGenerateArgs turns the preset positional into --type", () => {
  assert.deepEqual(
    normaliseGenerateArgs(["op-onprem-func-lite", "--performer-image-name", "java-fit-performer:main"]),
    ["--type", "op-onprem-func-lite", "--performer-image-name", "java-fit-performer:main"],
  );
});

test("normaliseGenerateArgs rewrites the --performer alias to --performer-image-name", () => {
  assert.deepEqual(normaliseGenerateArgs(["op-onprem-func-lite", "--performer", "java-fit-performer:main"]), [
    "--type",
    "op-onprem-func-lite",
    "--performer-image-name",
    "java-fit-performer:main",
  ]);
  assert.deepEqual(normaliseGenerateArgs(["--performer=java-fit-performer:main"]), [
    "--performer-image-name=java-fit-performer:main",
  ]);
});

test("normaliseGenerateArgs leaves an explicit --type alone", () => {
  assert.deepEqual(normaliseGenerateArgs(["--type", "op-onprem-func-lite"]), ["--type", "op-onprem-func-lite"]);
});

// A value-taking flag's value is a bare token, so it must not be mistaken for the
// preset positional — the bug this function exists to avoid.
test("normaliseGenerateArgs does not mistake a flag's value for the preset", () => {
  assert.deepEqual(normaliseGenerateArgs(["--output", "out.yaml", "op-onprem-func-lite"]), [
    "--type",
    "op-onprem-func-lite",
    "--output",
    "out.yaml",
  ]);
  assert.deepEqual(normaliseGenerateArgs(["--override", "a.b=c", "op-onprem-func-lite"]), [
    "--type",
    "op-onprem-func-lite",
    "--override",
    "a.b=c",
  ]);
});

// `--push-gist [public|private]` takes an *optional* value, so `public` is a bare
// token that would otherwise look like the preset positional.
test("normaliseGenerateArgs handles --push-gist's optional value", () => {
  assert.deepEqual(normaliseGenerateArgs(["op-onprem-func-lite", "--push-gist", "public"]), [
    "--type",
    "op-onprem-func-lite",
    "--push-gist",
    "public",
  ]);
  assert.deepEqual(normaliseGenerateArgs(["op-onprem-func-lite", "--push-gist"]), [
    "--type",
    "op-onprem-func-lite",
    "--push-gist",
  ]);
});

test("normaliseGenerateArgs passes an extra positional through for the parser to reject", () => {
  assert.deepEqual(normaliseGenerateArgs(["preset-a", "preset-b"]), ["--type", "preset-a", "preset-b"]);
});
