import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRunState, runStatePath, writeRunState, type RunState } from "../resume-state.js";

function sampleState(): RunState {
  return {
    version: 1,
    cycleIndex: 0,
    startIterationIndex: 0,
    target: { kind: "remote", instanceId: "i-123", address: "ec2.example.com", region: "us-east-1", user: "ubuntu", identityFile: "/tmp/key.pem" },
    cluster: {
      cluster: {
        scheme: "couchbase",
        defaultHostname: "127.0.0.1",
        flavour: "self-managed",
        credentials: { username: "Administrator", password: "password" },
        tls: null,
      },
      allocated: true,
      clusterId: "cb-abc",
      cbdinoclusterCommand: "/home/ubuntu/fit-workspace/cbdinocluster",
    },
    performers: [{ iterationIndex: 0, containerId: "deadbeef", port: 8060, sdk: "java" }],
  };
}

test("runStatePath puts the state under instances/0/_internal next to the definition", () => {
  assert.equal(
    runStatePath("/tmp/fit-cli/20260605-142043/fit.yaml"),
    "/tmp/fit-cli/20260605-142043/instances/0/_internal/run-state.json",
  );
});

test("writeRunState then readRunState round-trips the state", () => {
  const dir = mkdtempSync(join(tmpdir(), "resume-state-"));
  const definitionPath = join(dir, "fit.yaml");
  const written = writeRunState(definitionPath, sampleState());
  assert.equal(written, runStatePath(definitionPath));
  assert.deepEqual(readRunState(definitionPath), sampleState());
});

test("round-trips the forceLocalhost flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "resume-state-"));
  const definitionPath = join(dir, "fit.yaml");
  const state: RunState = { ...sampleState(), forceLocalhost: true };
  writeRunState(definitionPath, state);
  assert.equal(readRunState(definitionPath)?.forceLocalhost, true);
});

test("readRunState returns undefined when there is no saved state", () => {
  const dir = mkdtempSync(join(tmpdir(), "resume-state-"));
  assert.equal(readRunState(join(dir, "fit.yaml")), undefined);
});

test("readRunState rejects an unsupported version", () => {
  const dir = mkdtempSync(join(tmpdir(), "resume-state-"));
  const definitionPath = join(dir, "fit.yaml");
  writeRunState(definitionPath, { ...sampleState(), version: 2 as unknown as 1 });
  assert.throws(() => readRunState(definitionPath), /Unsupported run-state version/);
});
