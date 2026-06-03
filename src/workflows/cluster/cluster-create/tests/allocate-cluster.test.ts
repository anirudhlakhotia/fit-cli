import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeClusterDef } from "../allocate-cluster.js";

test("writeClusterDef writes into the provided run directory", () => {
  const runDir = mkdtempSync(join(tmpdir(), "fit-cli-run-dir-"));
  const def = "services:\n  - kv\n";
  const result = writeClusterDef(def, runDir);

  assert.equal(result.path, `${runDir}/cbdinocluster.yaml`);
  assert.equal(result.artifact.filename, "cbdinocluster.yaml");
  assert.equal(result.artifact.explanation, "cbdinocluster definition used to allocate the cluster");
  assert.equal(readFileSync(result.path, "utf8"), def);
});
