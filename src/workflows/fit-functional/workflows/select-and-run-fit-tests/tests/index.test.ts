import test from "node:test";
import assert from "node:assert/strict";
import {
  selectAndRunFitTests,
  type SelectAndRunFitTestsDeps,
} from "../index.js";
import type { FitTestSelection } from "../../select-fit-tests/index.js";

test("selectAndRunFitTests passes the selection into runTestDriver", async () => {
  const selection: FitTestSelection = {
    allTests: [],
    selectedTests: [],
    mavenTestSelector: "com.couchbase.transactions.StandardTest",
  };
  const calls: Array<{ rootDir: string; selection: FitTestSelection; fitConfigPath?: string }> = [];
  const deps: SelectAndRunFitTestsDeps = {
    selectFitTests(rootDir) {
      assert.equal(rootDir, "/tmp/workspace");
      return Promise.resolve(selection);
    },
    runTestDriver(rootDir, passedSelection, fitConfigPath) {
      calls.push({ rootDir, selection: passedSelection, fitConfigPath });
      return Promise.resolve(true);
    },
  };

  const result = await selectAndRunFitTests("/tmp/workspace", "/tmp/FITConfiguration.json", deps);

  assert.equal(result, true);
  assert.deepEqual(calls, [
    {
      rootDir: "/tmp/workspace",
      selection,
      fitConfigPath: "/tmp/FITConfiguration.json",
    },
  ]);
});

test("selectAndRunFitTests returns the runTestDriver result", async () => {
  const deps: SelectAndRunFitTestsDeps = {
    selectFitTests() {
      return Promise.resolve({
        allTests: [],
        selectedTests: [],
      });
    },
    runTestDriver() {
      return Promise.resolve(false);
    },
  };

  assert.equal(await selectAndRunFitTests("/tmp/workspace", undefined, deps), false);
});
