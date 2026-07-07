import test from "node:test";
import assert from "node:assert/strict";
import { parseFailingTestCases, parseJunitData, renderJunitMarkdown, renderJunitPlainText } from "../junit-to-markdown.js";

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

const SUREFIRE_SUITE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.FtsTest" tests="1" failures="1" errors="0" skipped="0" time="1.0">
  <testcase name="vectorSearch" classname="com.example.FtsTest" time="1.0">
    <failure message="Did not get back expected result on FTS operation.  Instead got: elapsedNanos: 119600&#10;initiated {&#10;  seconds: 1782324157&#10;  nanos: 555788200&#10;}&#10;"><![CDATA[org.opentest4j.AssertionFailedError: Did not get back expected result on FTS operation.  Instead got: elapsedNanos: 119600
initiated {
  seconds: 1782324157
  nanos: 555788200
}
	at com.example.FtsTest.vectorSearch(FtsTest.java:99)]]></failure>
  </testcase>
</testsuite>`;

test("parseFailingTestCases: decodes &#10; entities in message attribute", () => {
  const cases = parseFailingTestCases(SUREFIRE_SUITE);
  assert.equal(cases.length, 1);
  const msg = cases[0].issues[0].message;
  assert.ok(!msg.includes("&#10;"), "message should not contain raw &#10; entities");
  assert.ok(msg.includes("\n"), "message should contain real newlines");
  assert.ok(msg.startsWith("Did not get back"), "message text should be preserved");
});

test("parseFailingTestCases: strips CDATA wrappers from body", () => {
  const cases = parseFailingTestCases(SUREFIRE_SUITE);
  const body = cases[0].issues[0].body;
  assert.ok(!body.includes("<![CDATA["), "body should not contain CDATA open marker");
  assert.ok(!body.includes("]]>"), "body should not contain CDATA close marker");
  assert.ok(body.includes("AssertionFailedError"), "body content should be preserved");
});

test("renderJunitMarkdown: all-passing run produces no failure blocks", () => {
  const data = parseJunitData([
    { filename: "TEST-com.example.FooTest.xml", xml: PASSING_SUITE },
  ]);
  const md = renderJunitMarkdown(data);
  assert.ok(!md.includes("Stack trace"), "no stack trace for passing suite");
  assert.ok(!md.includes("#### ❌"), "no failure headers");
});

const SUITE_WITH_OUTPUT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.OutputTest" tests="1" failures="1" errors="0" skipped="0" time="1.0">
  <testcase name="doThing" classname="com.example.OutputTest" time="1.0">
    <failure message="expected true but was false">java.lang.AssertionError: expected true but was false</failure>
    <system-out><![CDATA[line1
line2
line3]]></system-out>
    <system-err><![CDATA[warn: something]]></system-err>
  </testcase>
</testsuite>`;

test("parseFailingTestCases: captures per-testcase system-out and system-err", () => {
  const cases = parseFailingTestCases(SUITE_WITH_OUTPUT);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].stdout, "line1\nline2\nline3");
  assert.equal(cases[0].stderr, "warn: something");
});

test("parseFailingTestCases: stdout/stderr are undefined when absent", () => {
  const cases = parseFailingTestCases(FAILING_SUITE);
  assert.equal(cases[0].stdout, undefined);
  assert.equal(cases[0].stderr, undefined);
});

test("renderJunitMarkdown: test output rendered under its own chevron", () => {
  const data = parseJunitData([{ filename: "TEST-com.example.OutputTest.xml", xml: SUITE_WITH_OUTPUT }]);
  const md = renderJunitMarkdown(data);
  assert.ok(md.includes("Test output (stdout)"), "should include stdout chevron summary");
  assert.ok(md.includes("Test output (stderr)"), "should include stderr chevron summary");
  assert.ok(md.includes("line1\nline2\nline3"), "should include stdout content");
  assert.ok(md.includes("warn: something"), "should include stderr content");
});

test("renderJunitPlainText: caps test output to the last N lines", () => {
  const manyLines = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.OutputTest" tests="1" failures="1" errors="0" skipped="0" time="1.0">
  <testcase name="doThing" classname="com.example.OutputTest" time="1.0">
    <failure message="boom">boom</failure>
    <system-out><![CDATA[${manyLines}]]></system-out>
  </testcase>
</testsuite>`;
  const data = parseJunitData([{ filename: "TEST-com.example.OutputTest.xml", xml }]);
  const text = renderJunitPlainText(data, 3, 10);

  assert.ok(text.includes("[20 earlier line(s) omitted]"), "should note omitted line count");
  assert.ok(text.includes("line29"), "should include the last line");
  assert.ok(!text.includes("line0\n") && !text.includes("line0)"), "should not include early lines");
});
