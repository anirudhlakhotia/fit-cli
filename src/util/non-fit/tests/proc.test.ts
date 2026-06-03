import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLogFile, runAndCaptureToFile, streamToFileInBackground } from "../proc.js";

test("createLogFile writes under the shared fit-cli temp directory", () => {
  const path = createLogFile("performer");
  assert.match(path, /^\/tmp\/fit-cli\/\d{8}-\d{6}(?:-\d+)?\/performer\.log$/);
});

test("createLogFile appends a numeric suffix when a log name is reused", () => {
  const firstPath = createLogFile("driver");
  writeFileSync(firstPath, "");
  const secondPath = createLogFile("driver");

  assert.match(firstPath, /\/driver\.log$/);
  assert.match(secondPath, /\/driver-2\.log$/);
  assert.notEqual(firstPath, secondPath);
});

test("streamToFileInBackground writes output as the command runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-proc-"));
  const logFile = join(dir, "stream.log");

  await streamToFileInBackground(
    process.execPath,
    [
      "-e",
      "console.log('hello from stdout'); setTimeout(() => console.error('hello from stderr'), 20); setTimeout(() => process.exit(0), 40);",
    ],
    logFile,
  );

  await new Promise((resolve) => setTimeout(resolve, 150));
  const output = readFileSync(logFile, "utf8");
  assert.match(output, /hello from stdout/);
  assert.match(output, /hello from stderr/);
});

test("runAndCaptureToFile writes stdout and stderr to a log file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-proc-"));
  const logFile = join(dir, "test-driver.log");

  await runAndCaptureToFile(
    process.execPath,
    ["-e", "console.log('fit stdout'); console.error('fit stderr');"],
    logFile,
  );

  const output = readFileSync(logFile, "utf8");
  assert.match(output, /fit stdout/);
  assert.match(output, /fit stderr/);
});
