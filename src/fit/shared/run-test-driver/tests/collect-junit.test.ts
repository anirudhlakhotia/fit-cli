import test from "node:test";
import assert from "node:assert/strict";
import { remoteJunitArchiveArgs } from "../collect-junit.js";

test("remoteJunitArchiveArgs returns source dir and wildcard tar command", () => {
  assert.deepEqual(remoteJunitArchiveArgs("/remote/reports"), [
    "-lc",
    'tmp=$(mktemp /tmp/fit-junit-XXXXXX.tar.gz) && cd "$1" && tar -czf "$tmp" -- TEST-*.xml && printf \'%s\\n\' "$tmp"',
    "sh",
    "/remote/reports",
  ]);
});
