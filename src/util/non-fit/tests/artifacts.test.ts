import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactFromPath, combineArtifacts, formatArtifactsSection } from "../artifacts.js";

test("artifactFromPath stores the filename relative to ARTIFACT_DIR", () => {
  const artifact = artifactFromPath(
    "/tmp/fit-cli/run-123/FITConfiguration-2026-06-03.json",
    "Generated FITConfiguration.json for the FIT test-driver",
    "/tmp/fit-cli/run-123",
  );

  assert.deepEqual(artifact, {
    filename: "FITConfiguration-2026-06-03.json",
    explanation: "Generated FITConfiguration.json for the FIT test-driver",
  });
});

test("combineArtifacts keeps first-seen order and removes duplicates", () => {
  assert.deepEqual(
    combineArtifacts(
      [{ filename: "a.log", explanation: "Performer logs" }],
      [
        { filename: "a.log", explanation: "Performer logs" },
        { filename: "b.json", explanation: "Generated FIT config" },
      ],
    ),
    [
      { filename: "a.log", explanation: "Performer logs" },
      { filename: "b.json", explanation: "Generated FIT config" },
    ],
  );
});

test("formatArtifactsSection renders a table", () => {
  assert.equal(
    formatArtifactsSection("/tmp/fit-cli/run-123", [
      { filename: "performer.log", explanation: "Performer logs" },
      { filename: "FITConfiguration.json", explanation: "Generated FIT config" },
    ]),
    [
      "Artifact filename                          | Purpose",
      "-------------------------------------------+--------",
      "/tmp/fit-cli/run-123/performer.log         | Performer logs",
      "/tmp/fit-cli/run-123/FITConfiguration.json | Generated FIT config",
    ].join("\n"),
  );
});
