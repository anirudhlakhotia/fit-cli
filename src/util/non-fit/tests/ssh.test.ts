/**
 * Unit tests for the pure ssh/scp argument builders.
 *
 * Run on their own:
 *   node --import tsx --test src/util/non-fit/tests/ssh.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildScpArgs, buildSshArgs, type RemoteHost } from "../ssh.js";

const HOST: RemoteHost = { host: "1.2.3.4", identityFile: "/tmp/key.pem" };

test("buildSshArgs disables host-key checking and targets user@host before the command", () => {
  const args = buildSshArgs(HOST, "echo", ["hello", "world"]);
  assert.ok(args.includes("StrictHostKeyChecking=no"));
  assert.ok(args.includes("UserKnownHostsFile=/dev/null"));
  // The command and its args come after the user@host target and the -- separator.
  const target = args.indexOf("ubuntu@1.2.3.4");
  const dashes = args.indexOf("--");
  assert.ok(target !== -1 && dashes === target + 1);
  assert.deepEqual(args.slice(dashes + 1), ["echo", "hello", "world"]);
});

test("buildSshArgs passes the identity file with IdentitiesOnly", () => {
  const args = buildSshArgs(HOST, "true");
  const i = args.indexOf("-i");
  assert.equal(args[i + 1], "/tmp/key.pem");
  assert.ok(args.includes("IdentitiesOnly=yes"));
});

test("buildSshArgs honours a custom user and port (-p)", () => {
  const args = buildSshArgs({ host: "h", user: "ec2-user", port: 2222 }, "true");
  assert.ok(args.includes("ec2-user@h"));
  const p = args.indexOf("-p");
  assert.equal(args[p + 1], "2222");
});

test("buildScpArgs up puts the local path first and remote target second", () => {
  const args = buildScpArgs(HOST, "/local/file", "/remote/file", "up");
  assert.deepEqual(args.slice(-2), ["/local/file", "ubuntu@1.2.3.4:/remote/file"]);
});

test("buildScpArgs down puts the remote source first and local path second", () => {
  const args = buildScpArgs(HOST, "/local/file", "/remote/file", "down");
  assert.deepEqual(args.slice(-2), ["ubuntu@1.2.3.4:/remote/file", "/local/file"]);
});

test("buildScpArgs uses -P for the port (scp differs from ssh)", () => {
  const args = buildScpArgs({ host: "h", port: 2222 }, "/l", "/r", "up");
  const p = args.indexOf("-P");
  assert.equal(args[p + 1], "2222");
});
