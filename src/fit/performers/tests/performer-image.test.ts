import assert from "node:assert/strict";
import test from "node:test";
import { sdkByValue } from "../../../util/sdk/sdks.js";
import {
  analysePerformerImage,
  normalizePerformerVersion,
  performerImageName,
  performerPackageUrl,
  validatePerformerVersion,
} from "../util/performer-image.js";

test("JVM performerPackageUrl points at the couchbase-jvm-clients GHCR package", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.equal(
    performerPackageUrl(sdk),
    "https://github.com/couchbase/couchbase-jvm-clients/pkgs/container/java-fit-performer",
  );
});

test("non-JVM performerPackageUrl points at the couchbase org-level GHCR package", () => {
  const sdk = sdkByValue("node");
  assert.ok(sdk);
  assert.equal(
    performerPackageUrl(sdk),
    "https://github.com/orgs/couchbase/packages/container/package/node-fit-performer",
  );
});

test("non-JVM performerImageName builds a fully-qualified GHCR reference", () => {
  const sdk = sdkByValue("node");
  assert.ok(sdk);
  assert.equal(performerImageName(sdk, "4.2.0"), "ghcr.io/couchbase/node-fit-performer:4.2.0");
});

test("JVM performerImageName uses the couchbase GHCR namespace", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.equal(performerImageName(sdk, "4.2.0"), "ghcr.io/couchbase/java-fit-performer:4.2.0");
});

test("JVM performerImageName defaults to main tag", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.equal(performerImageName(sdk), "ghcr.io/couchbase/java-fit-performer:main");
});

test("non-JVM performerImageName defaults to main tag", () => {
  const sdk = sdkByValue("node");
  assert.ok(sdk);
  assert.equal(performerImageName(sdk), "ghcr.io/couchbase/node-fit-performer:main");
});

test("C++ performerImageName uses the cxx-fit-performer GHCR package", () => {
  const sdk = sdkByValue("cpp");
  assert.ok(sdk);
  assert.equal(performerImageName(sdk), "ghcr.io/couchbase/cxx-fit-performer:main");
});

test(".NET performerImageName uses the dotnet-fit-performer GHCR package", () => {
  const sdk = sdkByValue("dotnet");
  assert.ok(sdk);
  assert.equal(performerImageName(sdk), "ghcr.io/couchbase/dotnet-fit-performer:main");
});

test("analysePerformerImage maps cxx-fit-performer back to the C++ SDK", () => {
  const result = analysePerformerImage("ghcr.io/couchbase/cxx-fit-performer:main");
  assert.ok(!("error" in result));
  assert.equal(result.sdk.value, "cpp");
  assert.equal(result.tag, "main");
});

test("analysePerformerImage accepts the dotnet performer image", () => {
  const result = analysePerformerImage("dotnet-fit-performer:main");
  assert.ok(!("error" in result));
  assert.equal(result.sdk.value, "dotnet");
});

test("normalizePerformerVersion collapses blank and main to the default tag", () => {
  assert.equal(normalizePerformerVersion(""), undefined);
  assert.equal(normalizePerformerVersion(" main "), undefined);
  assert.equal(normalizePerformerVersion("4.2.0"), "4.2.0");
});

test("normalizePerformerVersion collapses main to undefined for JVM SDKs", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.equal(normalizePerformerVersion("main", sdk), undefined);
  assert.equal(normalizePerformerVersion("4.2.0", sdk), "4.2.0");
});

test("validatePerformerVersion rejects full image references", () => {
  assert.equal(validatePerformerVersion("ghcr.io/couchbase/node-fit-performer:main"), "Enter only the image tag, not a full image reference.");
  assert.equal(validatePerformerVersion("4.2.0"), true);
});

test("analysePerformerImage parses a hyphenated columnar SDK basename", () => {
  const parsed = analysePerformerImage("columnar-go-fit-performer:main");
  assert.ok(!("error" in parsed));
  if ("error" in parsed) return;
  assert.equal(parsed.sdk.value, "columnar-go");
  assert.equal(parsed.tag, "main");
});

test("performerImageName builds a GHCR reference for a columnar SDK", () => {
  const sdk = sdkByValue("columnar-python");
  assert.ok(sdk);
  assert.equal(performerImageName(sdk, "main"), "ghcr.io/couchbase/columnar-python-fit-performer:main");
});
