import test from "node:test";
import assert from "node:assert/strict";
import { runTestDriverArgs } from "../index.js";
import { collapseSuitesByDefault, stripJunitProperties, surefireReportsDir } from "../collect-junit.js";
import type { FitTestSelection } from "../../select-fit-tests/index.js";

test("surefireReportsDir points at the test-driver's surefire output", () => {
  assert.equal(
    surefireReportsDir("/work/root"),
    "/work/root/transactions-fit-performer/test-driver/target/surefire-reports",
  );
});

test("stripJunitProperties removes the properties block but keeps the rest", () => {
  const xml = [
    '<testsuite name="GetTest" tests="1">',
    "  <properties>",
    '    <property name="java.class.path" value="/a/very/long:/class/path"/>',
    '    <property name="surefire.test.class.path" value="/more:/paths"/>',
    "  </properties>",
    '  <testcase name="get" classname="GetTest" time="0.1"/>',
    "</testsuite>",
  ].join("\n");

  const stripped = stripJunitProperties(xml);
  assert.ok(!stripped.includes("<properties>"));
  assert.ok(!stripped.includes("java.class.path"));
  assert.ok(stripped.includes('<testsuite name="GetTest"'));
  assert.ok(stripped.includes('<testcase name="get"'));
});

test("collapseSuitesByDefault flips the xunit-viewer expansion tokens", () => {
  const html = "var s={suitesExpanded:!0};(r.currentSuites[a].active=!0)";
  assert.equal(
    collapseSuitesByDefault(html),
    "var s={suitesExpanded:!1};(r.currentSuites[a].active=!1)",
  );
});

test("collapseSuitesByDefault leaves HTML untouched when tokens are absent", () => {
  const html = "<html>no recognisable xunit-viewer markup</html>";
  assert.equal(collapseSuitesByDefault(html), html);
});

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

  assert.deepEqual(runTestDriverArgs(selection, "/tmp/fit-cli/run-123/FITConfiguration.json"), [
    "-q",
    "--no-transfer-progress",
    "--batch-mode",
    "--projects",
    "test-driver",
    "--also-make",
    "-Dmaven.test.failure.ignore",
    "-Dsurefire.failIfNoSpecifiedTests=false",
    "-Dfit.config=/tmp/fit-cli/run-123/FITConfiguration.json",
    "test",
    "-DexcludedGroups=situational,openshift,syncgateway",
  ]);
});
