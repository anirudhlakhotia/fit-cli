import assert from "node:assert/strict";
import test from "node:test";
import {
  extractResumeAt,
  parseResumePoint,
  phasesForResumePoint,
} from "../resume.js";

test("no resume point runs every phase", () => {
  assert.deepEqual(phasesForResumePoint(undefined), {
    prepareRemote: true,
    setupCluster: true,
    setupPerformer: true,
  });
});

test("after-instance-creation reuses the instance but re-runs every phase", () => {
  assert.deepEqual(phasesForResumePoint("after-instance-creation"), {
    prepareRemote: true,
    setupCluster: true,
    setupPerformer: true,
  });
});

test("after-remote-preparation skips only the remote preparation", () => {
  assert.deepEqual(phasesForResumePoint("after-remote-preparation"), {
    prepareRemote: false,
    setupCluster: true,
    setupPerformer: true,
  });
});

test("after-cluster-creation skips remote preparation and the cluster phase", () => {
  assert.deepEqual(phasesForResumePoint("after-cluster-creation"), {
    prepareRemote: false,
    setupCluster: false,
    setupPerformer: true,
  });
});

test("after-performer skips remote preparation, cluster and performer phases", () => {
  assert.deepEqual(phasesForResumePoint("after-performer"), {
    prepareRemote: false,
    setupCluster: false,
    setupPerformer: false,
  });
});

test("parseResumePoint accepts the known points and rejects others", () => {
  assert.equal(parseResumePoint(undefined), undefined);
  assert.equal(parseResumePoint("after-performer"), "after-performer");
  assert.equal(parseResumePoint("after-instance-creation"), "after-instance-creation");
  assert.equal(parseResumePoint("after-remote-preparation"), "after-remote-preparation");
  assert.throws(() => parseResumePoint("after-lunch"), /Unknown --resume-at point "after-lunch"/);
});

test("extractResumeAt pulls --resume-at=<point> out of the positionals", () => {
  assert.deepEqual(extractResumeAt(["--resume-at=after-performer", "/tmp/fit.yaml"]), {
    resumeAt: "after-performer",
    positionals: ["/tmp/fit.yaml"],
  });
});

test("extractResumeAt accepts the space-separated form", () => {
  assert.deepEqual(extractResumeAt(["--resume-at", "after-cluster-creation", "/tmp/fit.yaml"]), {
    resumeAt: "after-cluster-creation",
    positionals: ["/tmp/fit.yaml"],
  });
});

test("extractResumeAt leaves the positionals untouched when absent", () => {
  assert.deepEqual(extractResumeAt(["/tmp/fit.yaml"]), { positionals: ["/tmp/fit.yaml"] });
});
