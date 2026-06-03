import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDefaultFitTestSelection,
  buildFitTestSelection,
  deserializeSelectedFitTestsFromReplay,
  formatFitTestSelectionOutput,
  listFitTestsArgs,
  parseFitTests,
  renderSelectedFitTestsAnswer,
  serializeSelectedFitTestsForReplay,
  summarizeFitTestSelection,
  type FitTestCase,
} from "../index.js";

test("listFitTestsArgs uses mvnw exec plugin to find test files", () => {
  assert.deepEqual(listFitTestsArgs(), [
    "-q",
    "--non-recursive",
    "org.codehaus.mojo:exec-maven-plugin:3.5.0:exec",
    "-Dexec.executable=find",
    "-Dexec.args=test-driver/src/test -type f ( -name *Test.java -o -name *Test.scala ) -printf %P\\n",
  ]);
});

test("parseFitTests converts relative paths into display names and class names", () => {
  assert.deepEqual(
    parseFitTests([
      "java/com/couchbase/transactions/StandardTest.java",
      "scala/com/couchbase/situational/tests/CngTest.scala",
      "java/com/couchbase/client/analytics/DisconnectTest.java",
    ].join("\n")),
    [
      {
        fileName: "CngTest.scala",
        relativePath: "scala/com/couchbase/situational/tests/CngTest.scala",
        className: "com.couchbase.situational.tests.CngTest",
      },
      {
        fileName: "DisconnectTest.java",
        relativePath: "java/com/couchbase/client/analytics/DisconnectTest.java",
        className: "com.couchbase.client.analytics.DisconnectTest",
      },
      {
        fileName: "StandardTest.java",
        relativePath: "java/com/couchbase/transactions/StandardTest.java",
        className: "com.couchbase.transactions.StandardTest",
      },
    ],
  );
});

test("buildFitTestSelection omits the surefire selector when all tests are chosen", () => {
  const allTests: FitTestCase[] = [
    {
      fileName: "StandardTest.java",
      relativePath: "java/com/couchbase/transactions/StandardTest.java",
      className: "com.couchbase.transactions.StandardTest",
    },
    {
      fileName: "CngTest.scala",
      relativePath: "scala/com/couchbase/situational/tests/CngTest.scala",
      className: "com.couchbase.situational.tests.CngTest",
    },
  ];

  assert.deepEqual(buildFitTestSelection(allTests, allTests.map((testCase) => testCase.className)), {
    allTests,
    selectedTests: allTests,
    mavenTestSelector: undefined,
  });
});

test("buildFitTestSelection builds a selector for a subset", () => {
  const allTests: FitTestCase[] = [
    {
      fileName: "StandardTest.java",
      relativePath: "java/com/couchbase/transactions/StandardTest.java",
      className: "com.couchbase.transactions.StandardTest",
    },
    {
      fileName: "CngTest.scala",
      relativePath: "scala/com/couchbase/situational/tests/CngTest.scala",
      className: "com.couchbase.situational.tests.CngTest",
    },
  ];

  assert.deepEqual(buildFitTestSelection(allTests, [allTests[1].className]), {
    allTests,
    selectedTests: [allTests[1]],
    mavenTestSelector: "com.couchbase.situational.tests.CngTest",
  });
});

test("buildDefaultFitTestSelection runs all tests when selection fails", () => {
  assert.deepEqual(buildDefaultFitTestSelection(), {
    allTests: [],
    selectedTests: [],
    mavenTestSelector: undefined,
  });
});

test("formatFitTestSelectionOutput keeps the default all-tests case short", () => {
  const allTests: FitTestCase[] = [
    {
      fileName: "StandardTest.java",
      relativePath: "java/com/couchbase/transactions/StandardTest.java",
      className: "com.couchbase.transactions.StandardTest",
    },
  ];

  assert.equal(
    formatFitTestSelectionOutput(buildFitTestSelection(allTests, [allTests[0].className])),
    "All FIT tests selected",
  );
});

test("renderSelectedFitTestsAnswer keeps the prompt confirmation short for all tests", () => {
  const choices = [
    { short: "StandardTest.java" },
    { short: "CngTest.scala" },
  ];

  assert.equal(renderSelectedFitTestsAnswer(choices, choices), "All FIT tests selected");
});

test("renderSelectedFitTestsAnswer lists selected tests for subsets", () => {
  assert.equal(
    renderSelectedFitTestsAnswer(
      [{ short: "StandardTest.java" }, { short: "CngTest.scala" }],
      [{ short: "StandardTest.java" }, { short: "CngTest.scala" }, { short: "DisconnectTest.java" }],
    ),
    "StandardTest.java, CngTest.scala",
  );
});

test("serializeSelectedFitTestsForReplay keeps the all-tests case compact", () => {
  const allTests: FitTestCase[] = [
    {
      fileName: "StandardTest.java",
      relativePath: "java/com/couchbase/transactions/StandardTest.java",
      className: "com.couchbase.transactions.StandardTest",
    },
    {
      fileName: "CngTest.scala",
      relativePath: "scala/com/couchbase/situational/tests/CngTest.scala",
      className: "com.couchbase.situational.tests.CngTest",
    },
  ];

  assert.equal(
    serializeSelectedFitTestsForReplay(allTests.map((test) => test.className), allTests),
    "All FIT tests selected",
  );
});

test("deserializeSelectedFitTestsFromReplay expands the compact all-tests marker", () => {
  const allTests: FitTestCase[] = [
    {
      fileName: "StandardTest.java",
      relativePath: "java/com/couchbase/transactions/StandardTest.java",
      className: "com.couchbase.transactions.StandardTest",
    },
    {
      fileName: "CngTest.scala",
      relativePath: "scala/com/couchbase/situational/tests/CngTest.scala",
      className: "com.couchbase.situational.tests.CngTest",
    },
  ];

  assert.deepEqual(
    deserializeSelectedFitTestsFromReplay("All FIT tests selected", allTests),
    allTests.map((test) => test.className),
  );
});

test("summarizeFitTestSelection avoids dumping the full allTests list", () => {
  const allTests: FitTestCase[] = [
    {
      fileName: "StandardTest.java",
      relativePath: "java/com/couchbase/transactions/StandardTest.java",
      className: "com.couchbase.transactions.StandardTest",
    },
    {
      fileName: "CngTest.scala",
      relativePath: "scala/com/couchbase/situational/tests/CngTest.scala",
      className: "com.couchbase.situational.tests.CngTest",
    },
    {
      fileName: "DisconnectTest.java",
      relativePath: "java/com/couchbase/client/analytics/DisconnectTest.java",
      className: "com.couchbase.client.analytics.DisconnectTest",
    },
  ];

  assert.deepEqual(
    summarizeFitTestSelection(
      buildFitTestSelection(allTests, [allTests[0].className, allTests[1].className, allTests[2].className]),
      2,
    ),
    {
      totalTests: 3,
      selectionMode: "all",
      selectedCount: 3,
      selectedClassPreview: [
        "com.couchbase.transactions.StandardTest",
        "com.couchbase.situational.tests.CngTest",
      ],
      selectedClassPreviewOmitted: 1,
      mavenTestSelector: undefined,
    },
  );
});
