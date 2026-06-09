import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeFitConfiguration } from "../write-fit-configuration.js";

test("writeFitConfiguration writes into instances/clusters/sessions/runs under the provided run directory", () => {
  const runDir = mkdtempSync(join(tmpdir(), "fit-cli-run-dir-"));
  const result = writeFitConfiguration({ hello: "world" }, { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0, runIndex: 0 }, runDir);

  assert.equal(result.path, `${runDir}/instances/0/clusters/0/sessions/0/runs/0/FITConfiguration.json`);
  assert.equal(result.artifact.filename, "instances/0/clusters/0/sessions/0/runs/0/FITConfiguration.json");
  assert.equal(result.artifact.explanation, "Generated FITConfiguration.json for the FIT test-driver");
  assert.deepEqual(JSON.parse(readFileSync(result.path, "utf8")), { hello: "world" });
});
