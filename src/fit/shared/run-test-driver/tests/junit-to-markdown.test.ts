import test from "node:test";
import assert from "node:assert/strict";
import { parseFailingTestCases, parseJunitData, renderJunitMarkdown } from "../junit-to-markdown.js";

const PASSING_SUITE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.FooTest" tests="3" failures="0" errors="0" skipped="1" time="2.345">
  <testcase name="testA" classname="com.example.FooTest" time="1.0"/>
  <testcase name="testB" classname="com.example.FooTest" time="0.5"/>
  <testcase name="testC" classname="com.example.FooTest" time="0.845">
    <skipped/>
  </testcase>
</testsuite>`;

const FAILING_SUITE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.BarTest" tests="4" failures="1" errors="1" skipped="0" time="5.0">
  <testcase name="testPass" classname="com.example.BarTest" time="1.0"/>
  <testcase name="testFail" classname="com.example.BarTest" time="2.0">
    <failure message="expected true but was false">java.lang.AssertionError: expected true but was false
	at com.example.BarTest.testFail(BarTest.java:42)</failure>
  </testcase>
  <testcase name="testError" classname="com.example.BarTest" time="1.5">
    <error message="NullPointerException">java.lang.NullPointerException
	at com.example.BarTest.testError(BarTest.java:55)</error>
  </testcase>
  <testcase name="testSkipped" classname="com.example.BarTest" time="0.5">
    <skipped/>
  </testcase>
</testsuite>`;

test("parseFailingTestCases: ignores passing and skipped tests", () => {
  const cases = parseFailingTestCases(PASSING_SUITE);
  assert.equal(cases.length, 0);
});

test("parseFailingTestCases: captures failure and error, not skipped", () => {
  const cases = parseFailingTestCases(FAILING_SUITE);
  assert.equal(cases.length, 2);

  const fail = cases.find((c) => c.name === "testFail");
  assert.ok(fail, "testFail should be captured");
  assert.equal(fail.issues.length, 1);
  assert.equal(fail.issues[0].tag, "failure");
  assert.equal(fail.issues[0].message, "expected true but was false");
  assert.ok(fail.issues[0].body.includes("BarTest.java:42"));

  const err = cases.find((c) => c.name === "testError");
  assert.ok(err, "testError should be captured");
  assert.equal(err.issues[0].tag, "error");
  assert.equal(err.issues[0].message, "NullPointerException");

  const skipped = cases.find((c) => c.name === "testSkipped");
  assert.equal(skipped, undefined, "testSkipped should not appear");
});

test("parseJunitData: aggregates counts correctly across two suites", () => {
  const data = parseJunitData([
    { filename: "TEST-com.example.FooTest.xml", xml: PASSING_SUITE },
    { filename: "TEST-com.example.BarTest.xml", xml: FAILING_SUITE },
  ]);

  assert.equal(data.totalPassed, 4); // 2 from Foo (3-0-0-1) + 2 from Bar (4-2-0)
  assert.equal(data.totalFailed, 2); // 0 from Foo + 2 from Bar
  assert.equal(data.totalSkipped, 1); // 1 from Foo (skipped="1") + 0 from Bar (skipped="0")
  assert.equal(data.failingCases.length, 2);
});

test("parseJunitData: packages with failures sort first", () => {
  const data = parseJunitData([
    { filename: "TEST-com.example.FooTest.xml", xml: PASSING_SUITE },
    { filename: "TEST-com.example.BarTest.xml", xml: FAILING_SUITE },
  ]);
  assert.equal(data.packages[0].pkg, "com.example");
  assert.ok(data.packages[0].failed > 0);
});

test("renderJunitMarkdown: contains badge and package table", () => {
  const data = parseJunitData([
    { filename: "TEST-com.example.FooTest.xml", xml: PASSING_SUITE },
    { filename: "TEST-com.example.BarTest.xml", xml: FAILING_SUITE },
  ]);
  const md = renderJunitMarkdown(data);

  assert.ok(md.includes("shields.io/badge/"), "should contain badge URL");
  assert.ok(md.includes("com.example"), "should contain package name");
  assert.ok(md.includes("❌"), "should contain failure emoji");
  assert.ok(md.includes("TOTAL"), "should contain totals row");
});

test("renderJunitMarkdown: failure details present, skipped not annotated", () => {
  const data = parseJunitData([
    { filename: "TEST-com.example.BarTest.xml", xml: FAILING_SUITE },
  ]);
  const md = renderJunitMarkdown(data);

  assert.ok(md.includes("testFail"), "should mention failing test");
  assert.ok(md.includes("expected true but was false"), "should include failure message");
  assert.ok(md.includes("Stack trace"), "should include stack trace block");
  assert.ok(!md.includes("testSkipped"), "should not annotate skipped test");
});

test("renderJunitMarkdown: all-passing run produces no failure blocks", () => {
  const data = parseJunitData([
    { filename: "TEST-com.example.FooTest.xml", xml: PASSING_SUITE },
  ]);
  const md = renderJunitMarkdown(data);
  assert.ok(!md.includes("Stack trace"), "no stack trace for passing suite");
  assert.ok(!md.includes("#### ❌"), "no failure headers");
});
