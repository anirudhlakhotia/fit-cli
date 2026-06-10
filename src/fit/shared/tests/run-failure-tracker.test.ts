import assert from "node:assert/strict";
import { test } from "node:test";
import { formatFailureSummaryLine, worstFailureShouldExitNonZero } from "../../../util/non-fit/artifacts.js";
import { RunFailureTracker } from "../run-failure-tracker.js";

const ctx = { instanceIndex: 0, cycleIndex: 1, iterationIndex: 2 };

test("RunFailureTracker: worst-wins ordering — lower severity does not displace higher", () => {
  const tracker = new RunFailureTracker();
  tracker.record("FatalToCycle", "cycle failed", { instanceIndex: 0, cycleIndex: 1 });
  tracker.record("NonFatal", "minor", { instanceIndex: 0, cycleIndex: 1 });
  tracker.record("FatalToIteration", "iteration failed", { instanceIndex: 0, cycleIndex: 1 });

  assert.equal(tracker.worst?.classification, "FatalToCycle");
  assert.equal(tracker.worst?.message, "cycle failed");
});

test("RunFailureTracker: FatalToAll displaces FatalToCycle", () => {
  const tracker = new RunFailureTracker();
  tracker.record("FatalToCycle", "cycle failed", { instanceIndex: 0, cycleIndex: 0 });
  tracker.record("FatalToAll", "everything failed", { instanceIndex: 0, cycleIndex: 1 });

  assert.equal(tracker.worst?.classification, "FatalToAll");
  assert.equal(tracker.worst?.message, "everything failed");
});

test("RunFailureTracker: count increments for every record call", () => {
  const tracker = new RunFailureTracker();
  tracker.record("NonFatal", "a", ctx);
  tracker.record("FatalToIteration", "b", ctx);
  tracker.record("FatalToCycle", "c", ctx);

  assert.equal(tracker.failureCount, 3);
});

test("RunFailureTracker: shouldExitNonZero is false for no failures", () => {
  const tracker = new RunFailureTracker();
  assert.equal(tracker.shouldExitNonZero(), false);
});

test("RunFailureTracker: shouldExitNonZero is false for NonFatal only", () => {
  const tracker = new RunFailureTracker();
  tracker.record("NonFatal", "minor", ctx);
  assert.equal(tracker.shouldExitNonZero(), false);
});

test("RunFailureTracker: shouldExitNonZero is true for FatalToIteration", () => {
  const tracker = new RunFailureTracker();
  tracker.record("FatalToIteration", "iteration failed", ctx);
  assert.equal(tracker.shouldExitNonZero(), true);
});

test("RunFailureTracker: shouldExitNonZero is true for FatalToCycle", () => {
  const tracker = new RunFailureTracker();
  tracker.record("FatalToCycle", "cycle failed", ctx);
  assert.equal(tracker.shouldExitNonZero(), true);
});

test("RunFailureTracker: shouldExitNonZero is true for FatalToAll", () => {
  const tracker = new RunFailureTracker();
  tracker.record("FatalToAll", "all failed", ctx);
  assert.equal(tracker.shouldExitNonZero(), true);
});

test("worstFailureShouldExitNonZero: false for NonFatal", () => {
  assert.equal(worstFailureShouldExitNonZero({ classification: "NonFatal", message: "x", context: { instanceIndex: 0, cycleIndex: 0 } }), false);
});

test("worstFailureShouldExitNonZero: true for FatalToIteration boundary", () => {
  assert.equal(worstFailureShouldExitNonZero({ classification: "FatalToIteration", message: "x", context: { instanceIndex: 0, cycleIndex: 0 } }), true);
});

test("formatFailureSummaryLine: 1-based instance/cycle/iteration", () => {
  const line = formatFailureSummaryLine(
    { classification: "FatalToCycle", message: "cluster failed", context: { instanceIndex: 0, cycleIndex: 1 } },
    1,
  );
  assert.equal(line, "Returning non-zero due to FatalToCycle error 'cluster failed' on instance 1, cycle 2");
});

test("formatFailureSummaryLine: includes iteration when present", () => {
  const line = formatFailureSummaryLine(
    { classification: "FatalToIteration", message: "tests failed", context: { instanceIndex: 1, cycleIndex: 0, iterationIndex: 2 } },
    1,
  );
  assert.equal(line, "Returning non-zero due to FatalToIteration error 'tests failed' on instance 2, cycle 1, iteration 3");
});

test("formatFailureSummaryLine: shows +N more for multiple failures", () => {
  const line = formatFailureSummaryLine(
    { classification: "FatalToCycle", message: "cluster failed", context: { instanceIndex: 0, cycleIndex: 0 } },
    3,
  );
  assert.match(line, /\(\+2 more failures\)/);
});

test("formatFailureSummaryLine: shows +1 more singular for two failures", () => {
  const line = formatFailureSummaryLine(
    { classification: "FatalToCycle", message: "cluster failed", context: { instanceIndex: 0, cycleIndex: 0 } },
    2,
  );
  assert.match(line, /\(\+1 more failure\)/);
});
