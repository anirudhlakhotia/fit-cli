/**
 * Workflow: list FIT test-driver test files and let the user run all of them
 * (the default) or a checked subset.
 *
 * Run on its own (add --root <dir> to point elsewhere):
 *   npx tsx src/workflows/fit-functional/workflows/select-fit-tests/index.ts
 */
import { basename } from "node:path";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { checkbox, search, select } from "../../../util/non-fit/prompts.js";
import { capture } from "../../../util/non-fit/proc.js";
import { FIT_PERFORMER, repoPath } from "../../../util/fit/repos.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";

export interface FitTestCase {
  /** Basename shown in the picker, e.g. StandardTest.java. */
  fileName: string;
  /** Relative path under test-driver/src/test, for disambiguation. */
  relativePath: string;
  /** Surefire selector for the test class. */
  className: string;
}

export interface FitTestSelection {
  /** All discovered FIT test-driver tests. */
  allTests: FitTestCase[];
  /** The tests the user chose to run. */
  selectedTests: FitTestCase[];
  /** `undefined` means "run all tests". */
  mavenTestSelector?: string;
}

export interface FitTestSelectionSummary {
  /** How many FIT test-driver tests were discovered. */
  totalTests: number;
  /** Whether the user kept the default "run all tests" selection. */
  selectionMode: "all" | "subset";
  /** How many tests will actually run. */
  selectedCount: number;
  /** A short preview of the selected test classes. */
  selectedClassPreview: string[];
  /** How many selected tests are omitted from the preview. */
  selectedClassPreviewOmitted: number;
  /** Surefire selector passed to Maven for subset runs. */
  mavenTestSelector?: string;
}

interface PromptChoiceLike {
  short?: string;
}

const ALL_FIT_TESTS_SELECTED = "All FIT tests selected";
const EXCLUDED_RELATIVE_PATH_PREFIX = "scala/com/couchbase/situational/";

const TEST_LISTING_ARGS = [
  "-q",
  "--non-recursive",
  "org.codehaus.mojo:exec-maven-plugin:3.5.0:exec",
  "-Dexec.executable=find",
  "-Dexec.args=test-driver/src/test -type f ( -name *Test.java -o -name *Test.scala ) -printf %P\\n",
] as const;

/** The `./mvnw ...` args used to list test-driver test files. */
export function listFitTestsArgs(): string[] {
  return [...TEST_LISTING_ARGS];
}

/** Parse the `find` output produced by {@link listFitTests}. */
export function parseFitTests(output: string): FitTestCase[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((relativePath) => !relativePath.startsWith(EXCLUDED_RELATIVE_PATH_PREFIX))
    .map((relativePath) => ({
      relativePath,
      fileName: basename(relativePath),
      className: relativePath
        .replace(/^(?:java|scala)\//, "")
        .replace(/\.(?:java|scala)$/, "")
        .replaceAll("/", "."),
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

/** List test-driver tests by running `./mvnw` in transactions-fit-performer. */
export async function listFitTests(rootDir: string): Promise<FitTestCase[]> {
  const output = await capture("./mvnw", listFitTestsArgs(), repoPath(FIT_PERFORMER, rootDir));
  const tests = parseFitTests(output);
  if (tests.length === 0) {
    throw new Error("Could not find any test-driver test files.");
  }
  return tests;
}

/** Convert the chosen tests into the data needed by the next workflow. */
export function buildFitTestSelection(
  allTests: FitTestCase[],
  selectedClassNames: readonly string[],
): FitTestSelection {
  const selectedTests = allTests.filter((test) => selectedClassNames.includes(test.className));
  return {
    allTests,
    selectedTests,
    mavenTestSelector:
      selectedTests.length === allTests.length
        ? undefined
        : selectedTests.map((test) => test.className).join(","),
  };
}

/** Fall back to Maven's default behavior of running all tests. */
export function buildDefaultFitTestSelection(): FitTestSelection {
  return {
    allTests: [],
    selectedTests: [],
    mavenTestSelector: undefined,
  };
}

/**
 * Build a selection from explicit fully-qualified class names, without
 * discovering the test files first. Used to drive a run from a definition file,
 * where the tests are named up front rather than picked interactively. Only the
 * `mavenTestSelector` reaches Maven; the test-case fields are reconstructed from
 * each class name so the selection stays self-describing.
 */
export function buildFitTestSelectionFromClassNames(classNames: readonly string[]): FitTestSelection {
  const tests: FitTestCase[] = classNames.map((className) => ({
    className,
    fileName: className.split(".").pop() ?? className,
    relativePath: className,
  }));
  return {
    allTests: tests,
    selectedTests: tests,
    mavenTestSelector: classNames.join(","),
  };
}

/** Build a concise CLI-friendly summary instead of dumping every discovered test. */
export function summarizeFitTestSelection(
  selection: FitTestSelection,
  previewLimit = 10,
): FitTestSelectionSummary {
  const selectedClassPreview = selection.selectedTests
    .slice(0, previewLimit)
    .map((test) => test.className);

  return {
    totalTests: selection.allTests.length,
    selectionMode: selection.mavenTestSelector ? "subset" : "all",
    selectedCount: selection.selectedTests.length,
    selectedClassPreview,
    selectedClassPreviewOmitted: Math.max(selection.selectedTests.length - selectedClassPreview.length, 0),
    mavenTestSelector: selection.mavenTestSelector,
  };
}

/** Format standalone CLI output for the selected FIT tests. */
export function formatFitTestSelectionOutput(selection: FitTestSelection): string {
  if (selection.mavenTestSelector === undefined) {
    return ALL_FIT_TESTS_SELECTED;
  }

  return JSON.stringify(summarizeFitTestSelection(selection), null, 2);
}

/** Keep the checkbox confirmation short when the user leaves every test selected. */
export function renderSelectedFitTestsAnswer(
  selectedChoices: readonly PromptChoiceLike[],
  allChoices: readonly PromptChoiceLike[],
): string {
  if (selectedChoices.length === allChoices.length) {
    return ALL_FIT_TESTS_SELECTED;
  }

  return selectedChoices.map((choice) => choice.short ?? "").join(", ");
}

/** Keep replay logs compact when the user leaves every FIT test selected. */
export function serializeSelectedFitTestsForReplay(
  selectedClassNames: readonly string[],
  allTests: readonly FitTestCase[],
): unknown {
  if (selectedClassNames.length === allTests.length) {
    return ALL_FIT_TESTS_SELECTED;
  }

  return [...selectedClassNames];
}

/** Show relative test paths in the picker while keeping answer chips concise. */
export function buildFitTestChoices(tests: readonly FitTestCase[]) {
  return tests.map((test) => ({
    name: test.relativePath,
    short: test.fileName,
    value: test.className,
    checked: true,
  }));
}

/** Filter tests for the single-test search box by file name or path. */
export function filterFitTests(tests: readonly FitTestCase[], term: string | undefined): FitTestCase[] {
  const needle = (term ?? "").trim().toLowerCase();
  if (needle.length === 0) {
    return [...tests];
  }
  return tests.filter(
    (test) =>
      test.fileName.toLowerCase().includes(needle) ||
      test.relativePath.toLowerCase().includes(needle),
  );
}

/** Build a `source` callback for the single-test {@link search} prompt. */
export function fitTestSearchSource(tests: readonly FitTestCase[]) {
  return (term: string | undefined) =>
    filterFitTests(tests, term).map((test) => ({
      name: test.relativePath,
      short: test.fileName,
      value: test.className,
    }));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Expand compact replay log values back into a concrete FIT test selection. */
export function deserializeSelectedFitTestsFromReplay(
  response: unknown,
  allTests: readonly FitTestCase[],
): string[] {
  if (response === ALL_FIT_TESTS_SELECTED) {
    return allTests.map((test) => test.className);
  }

  if (!isStringArray(response)) {
    throw new Error("Invalid replayed FIT test selection.");
  }

  return response;
}

const FIT_SANITY_TEST_CLASS_NAME = "com.couchbase.client.kv.GetTest";

type FitTestRunMode = "all" | "single" | "multiple" | "sanity";

/** Ask whether to run everything, a single searchable test, a sanity test, or a chosen subset. */
async function askFitTestRunMode(): Promise<FitTestRunMode> {
  return select<FitTestRunMode>({
    promptId: "fit.tests.mode",
    message: "Which FIT test-driver tests do you want to run?",
    default: "all",
    choices: [
      { name: "Run everything", value: "all" },
      { name: "Run a single test", value: "single" },
      {
        name: `Run a single sanity test (${FIT_SANITY_TEST_CLASS_NAME})`,
        value: "sanity",
      },
      { name: "Pick multiple tests", value: "multiple" },
    ],
  });
}

/** Pick the default FIT sanity test without prompting for a searchable test name. */
export function buildSanityFitTestSelection(tests: FitTestCase[]): FitTestSelection {
  const sanitySelection = buildFitTestSelection(tests, [FIT_SANITY_TEST_CLASS_NAME]);
  if (sanitySelection.selectedTests.length > 0) {
    return sanitySelection;
  }
  return buildFitTestSelectionFromClassNames([FIT_SANITY_TEST_CLASS_NAME]);
}

/** Single-test picker backed by a type-to-filter search box. */
async function selectSingleFitTest(tests: FitTestCase[]): Promise<FitTestSelection> {
  const className = await search<string>({
    promptId: "fit.tests.single",
    message: "Search for the FIT test to run:",
    source: fitTestSearchSource(tests),
  });
  return buildFitTestSelection(tests, [className]);
}

/** Multi-test picker: the checkbox list, all tests pre-selected. */
async function selectMultipleFitTests(tests: FitTestCase[]): Promise<FitTestSelection> {
  const selectedClassNames = await checkbox<string>({
    promptId: "fit.tests.select",
    message: "Which FIT test-driver tests do you want to run?  (Default is everything)",
    choices: buildFitTestChoices(tests),
    required: true,
    theme: {
      style: {
        renderSelectedChoices: renderSelectedFitTestsAnswer,
      },
    },
    replay: {
      serializeResponse: (selectedClassNames: string[]) =>
        serializeSelectedFitTestsForReplay(selectedClassNames, tests),
      deserializeResponse: (response: unknown) =>
        deserializeSelectedFitTestsFromReplay(response, tests),
    },
  });
  return buildFitTestSelection(tests, selectedClassNames);
}

/** Prompt for which FIT test-driver tests to run. */
export async function selectFitTests(rootDir: string): Promise<FitTestSelection> {
  try {
    const tests = await listFitTests(rootDir);
    const mode = await askFitTestRunMode();
    switch (mode) {
      case "single":
        return await selectSingleFitTest(tests);
      case "sanity":
        return buildSanityFitTestSelection(tests);
      case "multiple":
        return await selectMultipleFitTests(tests);
      default:
        return buildDefaultFitTestSelection();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`\nCould not select specific FIT tests (${message}). Continuing with all tests.`);
    return buildDefaultFitTestSelection();
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    console.log(formatFitTestSelectionOutput(await selectFitTests(rootDir)));
  });
}
