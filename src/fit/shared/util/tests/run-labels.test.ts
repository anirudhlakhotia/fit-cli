import assert from "node:assert/strict";
import { test } from "node:test";
import { clusterLabel, formatRunLabel, instanceLabel, performerLabel, runLabel } from "../run-labels.js";

const path = { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0, runIndex: 0 };

test("instanceLabel reflects the execution kind, falling back to instanceN", () => {
  assert.equal(instanceLabel(path, "aws"), "aws1");
  assert.equal(instanceLabel(path, "localhost"), "local");
  assert.equal(instanceLabel({ ...path, instanceIndex: 2 }), "instance3");
});

test("clusterLabel distinguishes allocated from existing, omitting clusterless", () => {
  assert.equal(clusterLabel(path, "cbdinocluster"), "cbdino1");
  assert.equal(clusterLabel(path, "connection"), "existing1");
  assert.equal(clusterLabel(path, "useExisting"), "existing1");
  assert.equal(clusterLabel(path), "cbdino1");
  assert.equal(clusterLabel({ ...path, clusterlessSession: true }), undefined);
});

test("clusterLabel prefers the cbdino cluster version when known", () => {
  assert.equal(clusterLabel(path, "cbdinocluster", "8.1.0"), "8.1.0");
  // A known version doesn't override the existing-cluster form (we don't claim a version for those).
  assert.equal(clusterLabel(path, "connection", "8.1.0"), "existing1");
  assert.equal(clusterLabel({ ...path, clusterlessSession: true }, "cbdinocluster", "8.1.0"), undefined);
});

test("performerLabel names the session by performer, falling back to sN", () => {
  assert.equal(performerLabel(path, "java", "main"), "java:main");
  assert.equal(performerLabel(path, "java"), "java");
  assert.equal(performerLabel({ ...path, sessionIndex: 1 }), "s2");
});

test("runLabel prefers a single preset, then the type, then rN", () => {
  assert.equal(runLabel(path, "functional", ["all-transactions"]), "all-transactions");
  assert.equal(runLabel(path, "functional", ["all-transactions", "standard-qe"]), "func");
  assert.equal(runLabel(path, "situational"), "sit");
  assert.equal(runLabel(path), "r1");
  assert.equal(runLabel({ instanceIndex: 0 }), undefined);
});

test("formatRunLabel joins the four segments, dropping absent ones", () => {
  assert.equal(
    formatRunLabel(path, { instanceKind: "aws", clusterMode: "cbdinocluster", sdkValue: "java", performerVersion: "main", type: "functional" }),
    "aws1 / cbdino1 / java:main / func",
  );
  assert.equal(
    formatRunLabel(
      { instanceIndex: 0, sessionIndex: 0, runIndex: 0, clusterlessSession: true },
      { instanceKind: "aws", sdkValue: "java", type: "situational" },
    ),
    "aws1 / java / sit",
  );
  assert.equal(
    formatRunLabel(path, {
      instanceKind: "aws",
      clusterMode: "cbdinocluster",
      clusterVersion: "8.1.0",
      sdkValue: "java",
      performerVersion: "main",
      type: "functional",
    }),
    "aws1 / 8.1.0 / java:main / func",
  );
  assert.equal(formatRunLabel(path), "instance1 / cbdino1 / s1 / r1");
});
