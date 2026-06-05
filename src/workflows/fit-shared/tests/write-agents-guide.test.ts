import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Artifact } from "../../../util/non-fit/artifacts.js";
import { formatAgentsGuide, writeAgentsGuide } from "../write-agents-guide.js";

const sampleArtifacts: Artifact[] = [
  { filename: "it0/FITConfiguration.json", explanation: "Generated FITConfiguration.json for the FIT test-driver" },
  { filename: "it0/driver.log", explanation: "FIT test-driver stdout/stderr captured for this run" },
];

test("formatAgentsGuide lists artifacts and points at the test-driver log", () => {
  const body = formatAgentsGuide(sampleArtifacts);

  assert.match(body, /This is a guide for agents\./);
  assert.match(body, /FITConfiguration\.json/);
  assert.match(body, /it0\/driver\.log/);
  // The main run log it nudges towards is the test-driver log, not the config.
  assert.match(body, /looking through `it0\/driver\.log`/);
});

test("writeAgentsGuide writes AGENTS.md into the run directory and lists itself", () => {
  const runDir = mkdtempSync(join(tmpdir(), "fit-cli-agents-guide-"));
  const result = writeAgentsGuide(sampleArtifacts, runDir);

  assert.equal(result.path, `${runDir}/AGENTS.md`);
  assert.equal(result.artifact.filename, "AGENTS.md");

  const written = readFileSync(result.path, "utf8");
  assert.match(written, /AGENTS\.md/);
  assert.match(written, /it0\/driver\.log/);
});
