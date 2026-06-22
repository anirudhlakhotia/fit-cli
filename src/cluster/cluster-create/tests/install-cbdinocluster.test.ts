import assert from "node:assert/strict";
import test from "node:test";
import { remoteInstallScript, remoteBuildFromPrScript, PINNED_GO_VERSION } from "../install-cbdinocluster.js";

test("remoteInstallScript: normalises amd64 arch", () => {
  const script = remoteInstallScript();
  assert.ok(script.includes("x86_64|amd64) arch=amd64"));
});

test("remoteInstallScript: normalises arm64 arch", () => {
  const script = remoteInstallScript();
  assert.ok(script.includes("aarch64|arm64) arch=arm64"));
});

test("remoteInstallScript: downloads from releases/latest", () => {
  const script = remoteInstallScript();
  assert.ok(script.includes("couchbaselabs/cbdinocluster"));
  assert.ok(script.includes("releases/latest/download/cbdinocluster-"));
});

test("remoteInstallScript: last stdout line prints the installed path", () => {
  const script = remoteInstallScript();
  const lines = script.split("\n").filter(Boolean);
  const last = lines[lines.length - 1];
  assert.ok(last.includes("printf '%s\\n'"), `unexpected last line: ${last}`);
  assert.ok(last.includes("$target"), `missing $target in: ${last}`);
});

test("remoteInstallScript: uses custom binDir", () => {
  const script = remoteInstallScript("/opt/mybin");
  assert.ok(script.includes('bindir="/opt/mybin"'));
});

test("remoteInstallScript: default binDir is $HOME/.local/bin", () => {
  const script = remoteInstallScript();
  assert.ok(script.includes('bindir="$HOME/.local/bin"'));
});

test("remoteBuildFromPrScript: clones canonical repo when no override given", () => {
  const script = remoteBuildFromPrScript({ pr: 42 });
  assert.ok(script.includes("https://github.com/couchbaselabs/cbdinocluster"));
});

test("remoteBuildFromPrScript: clones fork when repo is specified", () => {
  const script = remoteBuildFromPrScript({ pr: 42, repo: "myfork/cbdinocluster" });
  assert.ok(script.includes("https://github.com/myfork/cbdinocluster"));
  assert.ok(!script.includes("couchbaselabs/cbdinocluster"));
});

test("remoteBuildFromPrScript: fetches the correct PR ref", () => {
  const script = remoteBuildFromPrScript({ pr: 123 });
  assert.ok(script.includes("refs/pull/123/head"));
  assert.ok(script.includes("FETCH_HEAD"));
});

test("remoteBuildFromPrScript: different PR numbers produce different fetch refs", () => {
  const s7 = remoteBuildFromPrScript({ pr: 7 });
  const s99 = remoteBuildFromPrScript({ pr: 99 });
  assert.ok(s7.includes("refs/pull/7/head"));
  assert.ok(s99.includes("refs/pull/99/head"));
  assert.ok(!s7.includes("refs/pull/99/head"));
});

test("remoteBuildFromPrScript: auto-installs Go when missing", () => {
  const script = remoteBuildFromPrScript({ pr: 1 });
  assert.ok(script.includes("command -v go"));
  assert.ok(script.includes("go.dev/dl/"));
  assert.ok(script.includes(PINNED_GO_VERSION));
});

test("remoteBuildFromPrScript: builds with go build", () => {
  const script = remoteBuildFromPrScript({ pr: 1 });
  assert.ok(script.includes("go build -o"));
});

test("remoteBuildFromPrScript: cleans up the clone dir", () => {
  const script = remoteBuildFromPrScript({ pr: 1 });
  assert.ok(script.includes("rm -rf"));
});

test("remoteBuildFromPrScript: last stdout line prints the installed path", () => {
  const script = remoteBuildFromPrScript({ pr: 1 });
  const lines = script.split("\n").filter(Boolean);
  const last = lines[lines.length - 1];
  assert.ok(last.includes("printf '%s\\n'"), `unexpected last line: ${last}`);
  assert.ok(last.includes("$target"), `missing $target in: ${last}`);
});

test("remoteBuildFromPrScript: uses custom binDir", () => {
  const script = remoteBuildFromPrScript({ pr: 1 }, "/opt/mybin");
  assert.ok(script.includes('bindir="/opt/mybin"'));
});

test("remoteBuildFromPrScript: respects custom Go version", () => {
  const script = remoteBuildFromPrScript({ pr: 1 }, undefined, "1.21.0");
  assert.ok(script.includes("1.21.0"));
  assert.ok(!script.includes(PINNED_GO_VERSION));
});
