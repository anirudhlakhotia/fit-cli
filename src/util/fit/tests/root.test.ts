/**
 * Unit tests for the ROOT_DIR flag parsing (the pure logic in root.ts; the
 * filesystem-touching resolveRootDir is exercised by the step CLIs instead).
 *
 * Run on their own:
 *   npm test
 *   node --import tsx --test src/util/fit/tests/root.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractRootFlag } from "../root.js";

test("returns no override and the positionals untouched when no flag is given", () => {
  assert.deepEqual(extractRootFlag(["fit-performer"]), {
    override: undefined,
    positionals: ["fit-performer"],
  });
});

test("parses --root <dir> and keeps surrounding positionals", () => {
  assert.deepEqual(extractRootFlag(["fit-performer", "--root", "/ws"]), {
    override: "/ws",
    positionals: ["fit-performer"],
  });
});

test("parses --root=<dir>", () => {
  assert.deepEqual(extractRootFlag(["--root=/ws", "jvm-clients"]), {
    override: "/ws",
    positionals: ["jvm-clients"],
  });
});

test("parses the -r alias in both forms", () => {
  assert.deepEqual(extractRootFlag(["-r", "/ws", "go"]), {
    override: "/ws",
    positionals: ["go"],
  });
  assert.deepEqual(extractRootFlag(["-r=/ws", "go"]), {
    override: "/ws",
    positionals: ["go"],
  });
});

test("ignores the replay flag while parsing ROOT_DIR", () => {
  assert.deepEqual(extractRootFlag(["--replay", "/tmp/run.json", "--root", "/ws", "go"]), {
    override: "/ws",
    positionals: ["go"],
  });
});

test("ignores the replay defaults flag while parsing ROOT_DIR", () => {
  assert.deepEqual(extractRootFlag(["--replay", "--defaults", "/tmp/run.json", "--root", "/ws", "go"]), {
    override: "/ws",
    positionals: ["go"],
  });
});
