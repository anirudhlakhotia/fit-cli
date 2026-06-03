/**
 * Unit tests for findOnPath. These create real (temporary) files because
 * findOnPath checks executability on disk; the PATH itself is injected.
 *
 * Run on their own:
 *   npm test
 *   node --import tsx --test src/lib/tests/which.test.ts
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { findOnPath } from "../which.js";

/** Make a temp dir holding `name`, optionally executable, and return both. */
function dirWith(name: string, executable: boolean): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "which-test-"));
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, executable ? 0o755 : 0o644);
  return { dir, path };
}

test("an executable on the PATH is found, returning its full path", () => {
  const { dir, path } = dirWith("mytool", true);
  try {
    assert.equal(findOnPath("mytool", { PATH: dir }), path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a command that isn't anywhere on the PATH returns null", () => {
  const { dir } = dirWith("mytool", true);
  try {
    assert.equal(findOnPath("not-there", { PATH: dir }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a present but non-executable file is not treated as found", () => {
  const { dir } = dirWith("mytool", false);
  try {
    assert.equal(findOnPath("mytool", { PATH: dir }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PATH entries are searched in order, returning the first match", () => {
  const first = dirWith("mytool", true);
  const second = dirWith("mytool", true);
  try {
    const path = [first.dir, second.dir].join(delimiter);
    assert.equal(findOnPath("mytool", { PATH: path }), first.path);
  } finally {
    rmSync(first.dir, { recursive: true, force: true });
    rmSync(second.dir, { recursive: true, force: true });
  }
});

test("an empty or missing PATH finds nothing", () => {
  assert.equal(findOnPath("mytool", { PATH: "" }), null);
  assert.equal(findOnPath("mytool", {}), null);
});
