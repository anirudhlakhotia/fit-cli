import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSanityFitTestSelection,
  buildFitTestChoices,
  buildDefaultFitTestSelection,
  buildFitTestSelection,
  deserializeSelectedFitTestsFromReplay,
  filterFitTests,
  fitTestSearchSource,
  formatFitTestSelectionOutput,
  listFitTestsInRepo,
  listFitTestsArgs,
  parseFitTests,
  renderSelectedFitTestsAnswer,
  serializeSelectedFitTestsForReplay,
  summarizeFitTestSelection,
  SITUATIONAL_TEST_PATH_PREFIX,
  type FitTestCase,
  type FitTestDomain,
} from "../select-fit-tests.js";

const SAMPLE_TESTS: FitTestCase[] = [
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
];

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
      "scala/com/couchbase/situational/tests/CngTest.scala",
      "java/com/couchbase/transactions/StandardTest.java",
      "scala/com/couchbase/transactions/CngTest.scala",
      "java/com/couchbase/client/analytics/DisconnectTest.java",
    ].join("\n")),
    [
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
      {
        fileName: "CngTest.scala",
        relativePath: "scala/com/couchbase/transactions/CngTest.scala",
        className: "com.couchbase.transactions.CngTest",
      },
    ],
  );
});

test("listFitTestsInRepo uses the provided capture function and parses its output", async () => {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const tests = await listFitTestsInRepo("/remote/transactions-fit-performer", (command, args, cwd) => {
    calls.push({ command, args, cwd });
    return Promise.resolve(
      [
        "java/com/couchbase/transactions/StandardTest.java",
        "java/com/couchbase/client/analytics/DisconnectTest.java",
      ].join("\n"),
    );
  });

  assert.deepEqual(calls, [
    {
      command: "./mvnw",
      args: listFitTestsArgs(),
      cwd: "/remote/transactions-fit-performer",
    },
  ]);
  assert.deepEqual(tests, SAMPLE_TESTS);
});

test("filterFitTests returns all tests for a blank term", () => {
  assert.deepEqual(filterFitTests(SAMPLE_TESTS, "  "), SAMPLE_TESTS);
  assert.deepEqual(filterFitTests(SAMPLE_TESTS, undefined), SAMPLE_TESTS);
});

test("filterFitTests matches case-insensitively on file name or path", () => {
  assert.deepEqual(filterFitTests(SAMPLE_TESTS, "disconnect"), [SAMPLE_TESTS[0]]);
  assert.deepEqual(filterFitTests(SAMPLE_TESTS, "transactions"), [SAMPLE_TESTS[1]]);
  assert.deepEqual(filterFitTests(SAMPLE_TESTS, "nope"), []);
});

test("filterFitTests matches on fully-qualified class name", () => {
  assert.deepEqual(
    filterFitTests(SAMPLE_TESTS, "com.couchbase.transactions.StandardTest"),
    [SAMPLE_TESTS[1]],
  );
  assert.deepEqual(
    filterFitTests(SAMPLE_TESTS, "com.couchbase.client.analytics"),
    [SAMPLE_TESTS[0]],
  );
});

test("fitTestSearchSource maps filtered tests into search choices", () => {
  assert.deepEqual(fitTestSearchSource(SAMPLE_TESTS)("standard"), [
    {
      name: "java/com/couchbase/transactions/StandardTest.java",
      short: "StandardTest.java",
      value: "com.couchbase.transactions.StandardTest",
    },
  ]);
});

test("fitTestSearchSource offers a free-form entry when no tests match", () => {
  const result = fitTestSearchSource(SAMPLE_TESTS)("com.example.NonExistentTest");
  assert.equal(result.length, 1);
  assert.equal(result[0].value, "com.example.NonExistentTest");
  assert.equal(result[0].short, "com.example.NonExistentTest");
});

test("fitTestSearchSource returns no free-form entry for a blank term", () => {
  const result = fitTestSearchSource([])("");
  assert.deepEqual(result, []);
});

test("buildFitTestChoices shows relative paths while keeping short labels concise", () => {
  const allTests: FitTestCase[] = [
    {
      fileName: "GetTest.java",
      relativePath: "java/com/couchbase/kv/GetTest.java",
      className: "com.couchbase.kv.GetTest",
    },
    {
      fileName: "GetTest.java",
      relativePath: "java/com/couchbase/query/GetTest.java",
      className: "com.couchbase.query.GetTest",
    },
  ];

  assert.deepEqual(buildFitTestChoices(allTests), [
    {
      name: "java/com/couchbase/kv/GetTest.java",
      short: "GetTest.java",
      value: "com.couchbase.kv.GetTest",
      checked: true,
    },
    {
      name: "java/com/couchbase/query/GetTest.java",
      short: "GetTest.java",
      value: "com.couchbase.query.GetTest",
      checked: true,
    },
  ]);
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
      relativePath: "scala/com/couchbase/transactions/CngTest.scala",
      className: "com.couchbase.transactions.CngTest",
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
      relativePath: "scala/com/couchbase/transactions/CngTest.scala",
      className: "com.couchbase.transactions.CngTest",
    },
  ];

  assert.deepEqual(buildFitTestSelection(allTests, [allTests[1].className]), {
    allTests,
    selectedTests: [allTests[1]],
    mavenTestSelector: "com.couchbase.transactions.CngTest",
  });
});

test("buildSanityFitTestSelection selects the FIT sanity test from discovered tests", () => {
  const allTests: FitTestCase[] = [
    {
      fileName: "SanityTest.java",
      relativePath: "java/com/couchbase/client/kv/SanityTest.java",
      className: "com.couchbase.client.kv.SanityTest",
    },
    {
      fileName: "StandardTest.java",
      relativePath: "java/com/couchbase/transactions/StandardTest.java",
      className: "com.couchbase.transactions.StandardTest",
    },
  ];

  assert.deepEqual(buildSanityFitTestSelection(allTests), {
    allTests,
    selectedTests: [allTests[0]],
    mavenTestSelector: "com.couchbase.client.kv.SanityTest",
  });
});

test("buildSanityFitTestSelection falls back to the known sanity test class name", () => {
  assert.deepEqual(buildSanityFitTestSelection([]), {
    allTests: [
      {
        className: "com.couchbase.client.kv.SanityTest",
        fileName: "SanityTest",
        relativePath: "com.couchbase.client.kv.SanityTest",
      },
    ],
    selectedTests: [
      {
        className: "com.couchbase.client.kv.SanityTest",
        fileName: "SanityTest",
        relativePath: "com.couchbase.client.kv.SanityTest",
      },
    ],
    mavenTestSelector: "com.couchbase.client.kv.SanityTest",
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
      relativePath: "scala/com/couchbase/transactions/CngTest.scala",
      className: "com.couchbase.transactions.CngTest",
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
      relativePath: "scala/com/couchbase/transactions/CngTest.scala",
      className: "com.couchbase.transactions.CngTest",
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
      relativePath: "scala/com/couchbase/transactions/CngTest.scala",
      className: "com.couchbase.transactions.CngTest",
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
        "com.couchbase.transactions.CngTest",
      ],
      selectedClassPreviewOmitted: 1,
      mavenTestSelector: undefined,
    },
  );
});

const SITUATIONAL_DOMAIN: FitTestDomain = {
  includePrefix: SITUATIONAL_TEST_PATH_PREFIX,
  sanitySelector: "com.couchbase.situational.tests.VolumeTest#steadyStateKvGets",
};

test("parseFitTests with a situational domain keeps only situational tests", () => {
  const output = [
    "scala/com/couchbase/situational/tests/CngTest.scala",
    "java/com/couchbase/transactions/StandardTest.java",
    "scala/com/couchbase/situational/tests/cbdino_tests/CbDinoRebalanceTest.scala",
  ].join("\n");

  assert.deepEqual(
    parseFitTests(output, SITUATIONAL_DOMAIN).map((test) => test.className),
    [
      "com.couchbase.situational.tests.cbdino_tests.CbDinoRebalanceTest",
      "com.couchbase.situational.tests.CngTest",
    ],
  );
});

test("buildSanityFitTestSelection passes a Class#method sanity selector straight to Maven", () => {
  const selection = buildSanityFitTestSelection([], SITUATIONAL_DOMAIN);
  assert.equal(selection.mavenTestSelector, "com.couchbase.situational.tests.VolumeTest#steadyStateKvGets");
});
