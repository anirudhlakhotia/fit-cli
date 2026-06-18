/**
 * Unit tests for the pure cao-tools install-script builder.
 *
 * Run on their own:
 *   bun test
 *   node --import tsx --test src/workflows/cluster/cluster-create/tests/install-cao-tools.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { caoToolsInstallScript, CAO_TOOLS_VERSION } from "../install-cao-tools.js";

test("caoToolsInstallScript downloads the arch-matched cao tarball for the version", () => {
  const script = caoToolsInstallScript("/home/ubuntu/.dinotools/cao/2.8.0");
  assert.match(script, /couchbase-autonomous-operator_\$ver-kubernetes-linux-\$arch\.tar\.gz/);
  assert.ok(script.includes(`ver=${CAO_TOOLS_VERSION}`));
  assert.match(script, /x86_64\|amd64\) arch=amd64/);
  assert.match(script, /aarch64\|arm64\) arch=arm64/);
});

test("caoToolsInstallScript is idempotent: skips when the dest already has contents", () => {
  const script = caoToolsInstallScript("/home/ubuntu/.dinotools/cao/2.8.0");
  assert.match(script, /ls -A "\$dest"/);
  assert.match(script, /exit 0/);
});

test("caoToolsInstallScript moves the extracted dir's contents into the dest", () => {
  const script = caoToolsInstallScript("/home/ubuntu/.dinotools/cao/2.8.0");
  assert.match(script, /\bdest=\/home\/ubuntu\/\.dinotools\/cao\/2\.8\.0\b/);
  assert.match(script, /cp -R "\$extracted"\/\. "\$dest"\//);
});

test("caoToolsInstallScript honours a version override", () => {
  const script = caoToolsInstallScript("/opt/cao", "2.9.1");
  assert.match(script, /\bver=2\.9\.1\b/);
});
