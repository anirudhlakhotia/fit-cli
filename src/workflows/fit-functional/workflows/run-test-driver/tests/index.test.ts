import test from "node:test";
import assert from "node:assert/strict";
import { runTestDriverArgs } from "../index.js";
import type { FitTestSelection } from "../../select-fit-tests/index.js";

test("runTestDriverArgs omits -Dtest when all tests are selected", () => {
  const selection: FitTestSelection = {
    allTests: [],
    selectedTests: [],
  };

  assert.deepEqual(runTestDriverArgs(selection), [
    "-q",
    "--no-transfer-progress",
    "--batch-mode",
    "--projects",
    "test-driver",
    "--also-make",
    "-Dmaven.test.failure.ignore",
    "-Dsurefire.failIfNoSpecifiedTests=false",
    "test",
    "-DexcludedGroups=situational,openshift,syncgateway",
  ]);
});

test("runTestDriverArgs adds the selected tests to -Dtest", () => {
  const selection: FitTestSelection = {
    allTests: [],
    selectedTests: [],
    mavenTestSelector: "com.couchbase.transactions.StandardTest,com.couchbase.transactions.MultipleBucketsTest",
  };

  assert.deepEqual(runTestDriverArgs(selection), [
    "-q",
    "--no-transfer-progress",
    "--batch-mode",
    "--projects",
    "test-driver",
    "--also-make",
    "-Dmaven.test.failure.ignore",
    "-Dsurefire.failIfNoSpecifiedTests=false",
    "-Dtest=com.couchbase.transactions.StandardTest,com.couchbase.transactions.MultipleBucketsTest",
    "test",
    "-DexcludedGroups=situational,openshift,syncgateway",
  ]);
});

test("runTestDriverArgs adds the generated FIT config path", () => {
  const selection: FitTestSelection = {
    allTests: [],
    selectedTests: [],
  };

  assert.deepEqual(runTestDriverArgs(selection, "/tmp/fit-cli/run-123/FITConfiguration-123.json"), [
    "-q",
    "--no-transfer-progress",
    "--batch-mode",
    "--projects",
    "test-driver",
    "--also-make",
    "-Dmaven.test.failure.ignore",
    "-Dsurefire.failIfNoSpecifiedTests=false",
    "-Dfit.config=/tmp/fit-cli/run-123/FITConfiguration-123.json",
    "test",
    "-DexcludedGroups=situational,openshift,syncgateway",
  ]);
});
