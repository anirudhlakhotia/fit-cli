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

test("formatTimestampedChunk prefixes each non-empty line", () => {
  assert.deepEqual(
    formatTimestampedChunk("\nhello\nworld", true, () => "12:34:56"),
    { text: "\n[12:34:56] hello\n[12:34:56] world", atLineStart: false },
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
