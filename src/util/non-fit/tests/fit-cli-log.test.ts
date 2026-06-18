import assert from "node:assert/strict";
import { test } from "node:test";
import { capture } from "../proc.js";
import {
  formatFitCliError,
  formatFitCliWarn,
  formatTimestampedChunk,
} from "../fit-cli-log.js";

test("formatFitCliError prefixes and colours errors", () => {
  assert.equal(
    formatFitCliError("\n✗ Something broke"),
    "\nFitCliError: \u001b[31mSomething broke\u001b[0m",
  );
});

test("formatFitCliWarn prefixes and colours warnings", () => {
  assert.equal(
    formatFitCliWarn("\n→ Skipping this step"),
    "\nFitCliWarn: \u001b[33mSkipping this step\u001b[0m",
  );
});

test("formatFitCliError avoids duplicating an existing prefix", () => {
  assert.equal(
    formatFitCliError("FitCliError: already prefixed"),
    "FitCliError: \u001b[31malready prefixed\u001b[0m",
  );
});

test("formatFitCliError appends a failure classification to the label", () => {
  assert.equal(
    formatFitCliError({ classification: "FatalToRun" }, "\n✗ No JUnit reports"),
    "\nFitCliError/FatalToRun: [31mNo JUnit reports[0m",
  );
});

test("formatFitCliWarn appends a failure classification to the label", () => {
  assert.equal(
    formatFitCliWarn({ classification: "FatalToCluster" }, "Cluster sanity check failed"),
    "FitCliWarn/FatalToCluster: [33mCluster sanity check failed[0m",
  );
});

test("formatTimestampedChunk prefixes each non-empty line", () => {
  assert.deepEqual(
    formatTimestampedChunk("\nhello\nworld", true, () => "12:34:56"),
    { text: "\n[12:34:56] hello\n[12:34:56] world", atLineStart: false },
  );
});

test("formatTimestampedChunk joins context fields with a dot separator", () => {
  const ctx = { env: "aws1", cluster: "cbdino1", performer: "java:main", run: "func" };
  assert.deepEqual(
    formatTimestampedChunk("hello\nworld", true, () => "12:34:56", () => ctx),
    {
      text: "[12:34:56·aws1·cbdino1·java:main·func] hello\n[12:34:56·aws1·cbdino1·java:main·func] world",
      atLineStart: false,
    },
  );
});

test("formatTimestampedChunk omits missing context fields", () => {
  const ctx = { env: "aws1" };
  assert.deepEqual(
    formatTimestampedChunk("hello", true, () => "12:34:56", () => ctx),
    { text: "[12:34:56·aws1] hello", atLineStart: false },
  );
});

test("installFitCliConsoleFormatting timestamps console output and direct stdout writes", async () => {
  const fitCliLogModule = new URL("../fit-cli-log.ts", import.meta.url).href;
  const driver = [
    `import { installFitCliConsoleFormatting, setFitCliTimestampProvider } from ${JSON.stringify(fitCliLogModule)};`,
    `setFitCliTimestampProvider(() => "12:34:56");`,
    "installFitCliConsoleFormatting();",
    `console.log("hello");`,
    `process.stdout.write("Checking SSH...");`,
    `console.log(" ready");`,
  ].join("\n");

  const output = await capture(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", driver],
  );

  assert.equal(output, "[12:34:56] hello\n[12:34:56] Checking SSH... ready\n");
});

test("withRawTerminalWrites bypasses timestamp prefixes while preserving later line state", async () => {
  const fitCliLogModule = new URL("../fit-cli-log.ts", import.meta.url).href;
  const driver = [
    `import { installFitCliConsoleFormatting, setFitCliTimestampProvider, withRawTerminalWrites } from ${JSON.stringify(fitCliLogModule)};`,
    `setFitCliTimestampProvider(() => "12:34:56");`,
    "installFitCliConsoleFormatting();",
    `console.log("before");`,
    `await withRawTerminalWrites(async () => { process.stdout.write("? "); console.log("(Y/n)"); });`,
    `console.log("after");`,
  ].join("\n");

  const output = await capture(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", driver],
  );

  assert.equal(output, "[12:34:56] before\n? (Y/n)\n[12:34:56] after\n");
});
