import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  artifactFromPath,
  combineArtifacts,
  combineDetails,
  combineRunOutputs,
  formatArtifactsSection,
  formatDetailsSection,
} from "../artifacts.js";

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

test("combineDetails keeps first-seen order and removes duplicates", () => {
  assert.deepEqual(
    combineDetails(
      [{ label: "SSH debug command", value: "ssh fit" }],
      [
        { label: "SSH debug command", value: "ssh fit" },
        { label: "Terminate instance command", value: "terminate fit" },
      ],
    ),
    [
      { label: "SSH debug command", value: "ssh fit" },
      { label: "Terminate instance command", value: "terminate fit" },
    ],
  );
});

test("combineRunOutputs merges artifacts and details", () => {
  assert.deepEqual(
    combineRunOutputs(
      {
        artifacts: [{ filename: "a.log", explanation: "Performer logs" }],
        details: [{ label: "SSH debug command", value: "ssh fit" }],
      },
      {
        artifacts: [{ filename: "b.json", explanation: "Generated FIT config" }],
        details: [{ label: "Terminate instance command", value: "terminate fit" }],
      },
    ),
    {
      artifacts: [
        { filename: "a.log", explanation: "Performer logs" },
        { filename: "b.json", explanation: "Generated FIT config" },
      ],
      details: [
        { label: "SSH debug command", value: "ssh fit" },
        { label: "Terminate instance command", value: "terminate fit" },
      ],
    },
  );
});

test("formatArtifactsSection renders a table", () => {
  const runDir = mkdtempSync(join(tmpdir(), "fit-cli-artifacts-"));
  const performerPath = join(runDir, "performer.log");
  const configPath = join(runDir, "FITConfiguration.json");
  writeFileSync(performerPath, "hello");
  writeFileSync(configPath, "{}");
  const filenameWidth = Math.max("Artifact filename".length, performerPath.length, configPath.length);
  const sizeWidth = "Size".length;

  assert.equal(
    formatArtifactsSection(runDir, [
      { filename: "performer.log", explanation: "Performer logs" },
      { filename: "FITConfiguration.json", explanation: "Generated FIT config" },
    ]),
    [
      `${"Artifact filename".padEnd(filenameWidth)} | ${"Size".padEnd(sizeWidth)} | Purpose`,
      `${"-".repeat(filenameWidth)}-+-${"-".repeat(sizeWidth)}-+-${"-".repeat("Purpose".length)}`,
      `${performerPath.padEnd(filenameWidth)} | ${"5 B".padEnd(sizeWidth)} | Performer logs`,
      `${configPath.padEnd(filenameWidth)} | ${"2 B".padEnd(sizeWidth)} | Generated FIT config`,
    ].join("\n"),
  );
});

test("formatArtifactsSection skips missing file sizes without throwing", () => {
  const runDir = mkdtempSync(join(tmpdir(), "fit-cli-artifacts-"));
  const performerPath = join(runDir, "performer.log");
  const missingPath = join(runDir, "missing.log");
  writeFileSync(performerPath, "hello");
  const filenameWidth = Math.max("Artifact filename".length, performerPath.length, missingPath.length);
  const sizeWidth = "Size".length;

  assert.equal(
    formatArtifactsSection(runDir, [
      { filename: "performer.log", explanation: "Performer logs" },
      { filename: "missing.log", explanation: "Missing logs" },
    ]),
    [
      `${"Artifact filename".padEnd(filenameWidth)} | ${"Size".padEnd(sizeWidth)} | Purpose`,
      `${"-".repeat(filenameWidth)}-+-${"-".repeat(sizeWidth)}-+-${"-".repeat("Purpose".length)}`,
      `${performerPath.padEnd(filenameWidth)} | ${"5 B".padEnd(sizeWidth)} | Performer logs`,
      `${missingPath.padEnd(filenameWidth)} | ${"".padEnd(sizeWidth)} | Missing logs`,
    ].join("\n"),
  );
});

test("formatDetailsSection renders a table", () => {
  assert.equal(
    formatDetailsSection([
      { label: "SSH debug command", value: "ssh -i key ubuntu@host" },
      { label: "Terminate instance command", value: "terminate --id i-123" },
    ]),
    [
      "Detail                     | Value",
      "---------------------------+-----------------------",
      "SSH debug command          | ssh -i key ubuntu@host",
      "Terminate instance command | terminate --id i-123",
    ].join("\n"),
  );
});
