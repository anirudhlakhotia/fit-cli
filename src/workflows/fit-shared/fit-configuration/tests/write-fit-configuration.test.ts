import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeFitConfiguration } from "../write-fit-configuration.js";

test("writeFitConfiguration writes into cycles/N/itM under the provided run directory", () => {
  const runDir = mkdtempSync(join(tmpdir(), "fit-cli-run-dir-"));
  const result = writeFitConfiguration({ hello: "world" }, runDir, 0, 0);

  assert.equal(result.path, `${runDir}/cycles/0/it0/FITConfiguration.json`);
  assert.equal(result.artifact.filename, "cycles/0/it0/FITConfiguration.json");
  assert.equal(result.artifact.explanation, "Generated FITConfiguration.json for the FIT test-driver");
  assert.deepEqual(JSON.parse(readFileSync(result.path, "utf8")), { hello: "world" });
});
