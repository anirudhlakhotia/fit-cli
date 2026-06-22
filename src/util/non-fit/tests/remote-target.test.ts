/**
 * Unit tests for the remote command building (posixQuote / buildRemoteCommand).
 *
 * Run on their own:
 *   node --import tsx --test src/util/non-fit/tests/remote-target.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRemoteCommand, posixQuote, teeToFileCommand } from "../remote-target.js";

test("posixQuote leaves safe bare tokens untouched", () => {
  assert.equal(posixQuote("git"), "git");
  assert.equal(posixQuote("/home/ubuntu/repo"), "/home/ubuntu/repo");
  assert.equal(posixQuote("--flag=value"), "--flag=value");
});

test("posixQuote wraps tokens with spaces or specials in single quotes", () => {
  assert.equal(posixQuote("a b"), "'a b'");
  assert.equal(posixQuote("a&&b"), "'a&&b'");
  assert.equal(posixQuote(""), "''");
});

test("posixQuote escapes embedded single quotes", () => {
  assert.equal(posixQuote("it's"), "'it'\\''s'");
});

test("buildRemoteCommand joins command and args", () => {
  assert.equal(buildRemoteCommand("echo", ["hello", "world"]), "echo hello world");
});

test("buildRemoteCommand prefixes a cd when cwd is given", () => {
  assert.equal(buildRemoteCommand("ls", ["-l"], "/var/log"), "cd /var/log && ls -l");
});

test("buildRemoteCommand quotes a cwd and args that need it", () => {
  assert.equal(buildRemoteCommand("grep", ["a b"], "/my dir"), "cd '/my dir' && grep 'a b'");
});

test("teeToFileCommand pipes output to a file under pipefail", () => {
  assert.equal(
    teeToFileCommand("cbdinocluster allocate", "/tmp/out.log"),
    "set -o pipefail; cbdinocluster allocate 2>&1 | tee /tmp/out.log",
  );
});

test("teeToFileCommand quotes a path that needs it", () => {
  assert.equal(
    teeToFileCommand("cmd", "/my dir/out.log"),
    "set -o pipefail; cmd 2>&1 | tee '/my dir/out.log'",
  );
});
