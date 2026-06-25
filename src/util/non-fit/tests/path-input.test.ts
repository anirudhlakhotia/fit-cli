/**
 * Unit tests for path-input — pure logic and FS-layer tests.
 *
 * Run on their own:
 *   bun run test
 *   node --import tsx --test src/util/non-fit/tests/path-input.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { computePathCompletions, resolveCompletions, type DirEntry } from "../path-input.js";

// ─── Pure completion logic ────────────────────────────────────────────────────

function entries(...specs: string[]): DirEntry[] {
  return specs.map((s) => ({ name: s.endsWith("/") ? s.slice(0, -1) : s, isDir: s.endsWith("/") }));
}

test("single directory match gets a trailing slash and becomes the prefix", () => {
  const result = computePathCompletions(entries("fit-cli/", "fit-tests/"), "fit-c");
  assert.deepEqual(result, { prefix: "fit-cli/", candidates: ["fit-cli/"] });
});

test("single file match has no trailing slash", () => {
  const result = computePathCompletions(entries("README.md", "run.sh"), "RE");
  assert.deepEqual(result, { prefix: "README.md", candidates: ["README.md"] });
});

test("multiple matches extend to longest common prefix and list all candidates", () => {
  const result = computePathCompletions(entries("fit-cli/", "fit-tests/", "other/"), "fit");
  assert.deepEqual(result, { prefix: "fit-", candidates: ["fit-cli/", "fit-tests/"] });
});

test("no match leaves prefix unchanged and returns empty candidates", () => {
  const result = computePathCompletions(entries("foo/", "bar/"), "xyz");
  assert.deepEqual(result, { prefix: "xyz", candidates: [] });
});

test("empty partial with trailing slash lists all non-dotfile entries", () => {
  const result = computePathCompletions(entries("alpha/", ".hidden/", "beta"), "");
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.includes("alpha/"));
  assert.ok(result.candidates.includes("beta"));
});

test("dotfiles are hidden unless partial starts with a dot", () => {
  const dir = entries(".git/", ".env", "src/");
  const without = computePathCompletions(dir, "");
  assert.deepEqual(without.candidates, ["src/"]);

  const withDot = computePathCompletions(dir, ".");
  assert.ok(withDot.candidates.includes(".git/"));
  assert.ok(withDot.candidates.includes(".env"));
});

test("common prefix stops at the point of divergence", () => {
  const result = computePathCompletions(entries("transactions-fit-performer/", "transactions-fit-tests/"), "trans");
  assert.equal(result.prefix, "transactions-fit-");
  assert.equal(result.candidates.length, 2);
});

test("single match with no partial returns that entry as prefix", () => {
  const result = computePathCompletions(entries("only-dir/"), "");
  assert.deepEqual(result, { prefix: "only-dir/", candidates: ["only-dir/"] });
});

test("prefix never extends beyond a candidate boundary", () => {
  // "ab" and "abc/" share "ab" but not "abc"
  const result = computePathCompletions(entries("ab", "abc/"), "a");
  assert.equal(result.prefix, "ab");
});

// ─── FS-layer (resolveCompletions) ───────────────────────────────────────────

const tmpRoot = mkdtempSync(join(tmpdir(), "fit-path-input-test-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

function setupDir(name: string, children: Array<{ name: string; isDir?: boolean }>): string {
  const dir = join(tmpRoot, name);
  mkdirSync(dir);
  for (const child of children) {
    const childPath = join(dir, child.name);
    if (child.isDir) {
      mkdirSync(childPath);
    } else {
      writeFileSync(childPath, "");
    }
  }
  return dir;
}

test("resolveCompletions: single directory match completes and returns no candidates", () => {
  const dir = setupDir("single-dir", [{ name: "transactions-fit-performer", isDir: true }]);
  const result = resolveCompletions(join(dir, "trans"));
  assert.ok(result !== null);
  assert.equal(result.newValue, join(dir, "transactions-fit-performer/"));
  assert.deepEqual(result.candidates, []);
});

test("resolveCompletions: multiple matches extend to common prefix and list full paths", () => {
  const dir = setupDir("multi-dir", [
    { name: "fit-performer", isDir: true },
    { name: "fit-tests", isDir: true },
    { name: "other", isDir: true },
  ]);
  const result = resolveCompletions(join(dir, "fit"));
  assert.ok(result !== null);
  assert.equal(result.newValue, join(dir, "fit-"));
  assert.ok(result.candidates.includes(join(dir, "fit-performer/")));
  assert.ok(result.candidates.includes(join(dir, "fit-tests/")));
  assert.ok(!result.candidates.some((c) => c.includes("other")));
});

test("resolveCompletions: no match returns null (input must not be erased)", () => {
  const dir = setupDir("no-match", [{ name: "alpha", isDir: true }]);
  const result = resolveCompletions(join(dir, "zzz"));
  assert.equal(result, null);
});

test("resolveCompletions: trailing slash lists contents of that directory", () => {
  const dir = setupDir("trailing-slash", []);
  mkdirSync(join(dir, "cbdinocluster"));
  const result = resolveCompletions(dir + "/");
  assert.ok(result !== null);
  assert.equal(result.newValue, join(dir, "cbdinocluster/"));
});

test("resolveCompletions: empty string lists files relative to cwd, returns null on no match", () => {
  // cwd will have many files; just verify no crash and result is null-or-object
  const result = resolveCompletions("zzzzno-such-partial-xyzzy");
  assert.equal(result, null);
});
