import test from "node:test";
import assert from "node:assert/strict";
import { remoteJunitArchiveArgs } from "../collect-junit.js";

test("remoteJunitArchiveArgs passes source dir and files as positional args", () => {
  assert.deepEqual(remoteJunitArchiveArgs("/remote/reports", ["TEST-one.xml", "TEST-two.xml"]), [
    "-lc",
    'tmp=$(mktemp /tmp/fit-junit-XXXXXX.tar.gz) && src="$1" && shift && tar -C "$src" -czf "$tmp" -- "$@" && printf \'%s\\n\' "$tmp"',
    "sh",
    "/remote/reports",
    "TEST-one.xml",
    "TEST-two.xml",
  ]);
});
