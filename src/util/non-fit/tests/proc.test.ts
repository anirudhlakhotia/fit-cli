import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { capture, captureValueSync, createLogFile, streamToFile } from "../proc.js";

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

test("captureValueSync returns stdout for a successful command", () => {
  const out = captureValueSync(process.execPath, ["-e", "process.stdout.write('the-value')"]);
  assert.equal(out, "the-value");
});

test("captureValueSync throws on a non-zero exit by default", () => {
  assert.throws(() => captureValueSync(process.execPath, ["-e", "process.exit(3)"]), /exited with code 3/);
});

test("captureValueSync with allowFailure yields empty string instead of throwing", () => {
  assert.equal(captureValueSync(process.execPath, ["-e", "process.exit(3)"], { allowFailure: true }), "");
  assert.equal(captureValueSync("definitely-not-a-real-binary-xyz", [], { allowFailure: true }), "");
});

test("captureValueSync allowExitCodes treats a listed code as success", () => {
  const out = captureValueSync(
    process.execPath,
    ["-e", "process.stdout.write('ok'); process.exit(2)"],
    { allowExitCodes: [0, 2] },
  );
  assert.equal(out, "ok");
});

test("streamToFile writes stdout and stderr to a log file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-proc-"));
  const logFile = join(dir, "test-driver.log");

  await streamToFile(
    process.execPath,
    ["-e", "console.log('fit stdout'); console.error('fit stderr');"],
    logFile,
  );

  const output = readFileSync(logFile, "utf8");
  assert.match(output, /fit stdout/);
  assert.match(output, /fit stderr/);
});

test("streamToFile does not echo the command's output to the terminal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-proc-"));
  const logFile = join(dir, "test-driver.log");
  const procModule = new URL("../proc.ts", import.meta.url).href;

  // Run streamToFile in a child process so we can observe its real stdout
  // without monkeypatching this process's streams (which confuses the test
  // runner's own reporter). streamToFile echoes the command line it's about to
  // run, so the grandchild assembles its output marker at runtime — that way the
  // marker never appears in the echoed command, and anything matching it on
  // stdout can only be the grandchild's output leaking through.
  const driver = [
    `import { streamToFile } from ${JSON.stringify(procModule)};`,
    `await streamToFile(${JSON.stringify(process.execPath)}, ["-e", "console.log(['fit','marker'].join('-'))"], ${JSON.stringify(logFile)});`,
  ].join("\n");

  const terminal = await capture(process.execPath, ["--import", "tsx", "--input-type=module", "-e", driver]);

  assert.doesNotMatch(terminal, /fit-marker/);
  assert.match(readFileSync(logFile, "utf8"), /fit-marker/);
});

test("run tees child output into the session log by default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fit-cli-proc-"));
  const logFile = join(dir, "session.info.log");
  const procModule = new URL("../proc.ts", import.meta.url).href;

  const driver = [
    `import { run, startSessionLog } from ${JSON.stringify(procModule)};`,
    `const sessionLog = startSessionLog(${JSON.stringify(logFile)});`,
    `await run(${JSON.stringify(process.execPath)}, ["-e", "console.log('child stdout'); console.error('child stderr');"]);`,
    "await sessionLog.flush();",
  ].join("\n");

  const terminal = await capture(process.execPath, ["--import", "tsx", "--input-type=module", "-e", driver]);
  const sessionOutput = readFileSync(logFile, "utf8");

  assert.match(terminal, /child stdout/);
  assert.match(sessionOutput, /child stdout/);
  assert.match(sessionOutput, /child stderr/);
});
