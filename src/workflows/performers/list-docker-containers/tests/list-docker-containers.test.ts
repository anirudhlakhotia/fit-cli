import assert from "node:assert/strict";
import test from "node:test";
import {
  collectContainerTags,
  formatCompactContainerVersions,
  formatHumanContainerVersions,
  parseGhcrPackageUrl,
  preferredContainerTag,
  type GhcrPackageVersion,
} from "../list-docker-containers.js";

function version(id: number, tags: string[]): GhcrPackageVersion {
  return {
    id,
    name: `sha256:${id}`,
    created_at: "2026-06-05T00:00:00Z",
    updated_at: "2026-06-05T00:00:00Z",
    html_url: `https://example.invalid/${id}`,
    package_html_url: "https://example.invalid/package",
    metadata: {
      container: {
        tags,
      },
    },
  };
}

test("parseGhcrPackageUrl accepts repo-scoped package URLs with query strings", () => {
  assert.deepEqual(
    parseGhcrPackageUrl(
      "https://github.com/couchbase/couchbase-jvm-clients/pkgs/container/java-fit-performer?tab=tags",
    ),
    {
      owner: "couchbase",
      repo: "couchbase-jvm-clients",
      packageName: "java-fit-performer",
    },
  );
});

test("parseGhcrPackageUrl accepts org-scoped package URLs", () => {
  assert.deepEqual(
    parseGhcrPackageUrl(
      "https://github.com/orgs/couchbase/packages/container/package/node-fit-performer",
    ),
    {
      owner: "couchbase",
      packageName: "node-fit-performer",
    },
  );
});

test("collectContainerTags preserves first-seen order and removes duplicates", () => {
  assert.deepEqual(
    collectContainerTags([
      version(1, ["main", "4.2.0"]),
      version(2, ["4.2.0", "4.1.9"]),
    ]),
    ["main", "4.2.0", "4.1.9"],
  );
});

test("preferredContainerTag prefers main when it exists", () => {
  assert.equal(preferredContainerTag(["4.2.0", "main", "4.1.9"]), "main");
  assert.equal(preferredContainerTag(["4.2.0", "4.1.9"]), "4.2.0");
});

test("formatCompactContainerVersions prints one tag per line", () => {
  assert.equal(formatCompactContainerVersions([version(1, ["main", "4.2.0"])]), "main\n4.2.0");
});

test("formatHumanContainerVersions shows the key version metadata", () => {
  const output = formatHumanContainerVersions([version(1, ["main"])]);
  assert.match(output, /^1 container version\(s\):/);
  assert.match(output, /tags:\s+main/);
  assert.match(output, /package_url:\s+https:\/\/example\.invalid\/package/);
});
