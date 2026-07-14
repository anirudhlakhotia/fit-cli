import assert from "node:assert/strict";
import { describe, test } from "node:test";
import JSON5 from "json5";
import type { CapGroup, CapsFile } from "../caps-metadata.js";
import type { ProtoEnumMember } from "../parse-proto-enum.js";
import { formatCapsFile, mergeCaps } from "../sync-caps-file.js";

function protos(overrides: Partial<Record<CapGroup, ProtoEnumMember[]>> = {}): Record<CapGroup, ProtoEnumMember[]> {
  return { sdk: [], transactions: [], performer: [], ...overrides };
}

describe("mergeCaps", () => {
  test("adds caps the protos define and reports them as new", () => {
    const { capsFile, added } = mergeCaps(
      protos({ sdk: [{ name: "SDK_QUERY", number: 12, comment: "Can run queries." }] }),
    );
    assert.deepEqual(capsFile.sdk.SDK_QUERY, { number: 12, jira: "", description: "Can run queries." });
    assert.deepEqual(added, ["sdk.SDK_QUERY"]);
  });

  test("never overwrites a hand-written jira, description or notes", () => {
    const existing: CapsFile = {
      sdk: {
        SDK_QUERY: { number: 12, jira: "CBD-9999", description: "My own words.", notes: "Owned by the query team." },
      },
      transactions: {},
      performer: {},
    };
    const { capsFile, added } = mergeCaps(
      protos({ sdk: [{ name: "SDK_QUERY", number: 12, comment: "The proto's words." }] }),
      existing,
    );
    assert.deepEqual(capsFile.sdk.SDK_QUERY, {
      number: 12,
      jira: "CBD-9999",
      description: "My own words.",
      notes: "Owned by the query team.",
    });
    assert.deepEqual(added, []);
  });

  test("takes the number from the proto even when the file disagrees", () => {
    // The number is the one generated field: if a cap is renumbered, following the
    // stale file would tick the wrong row.
    const existing: CapsFile = {
      sdk: { SDK_QUERY: { number: 3, jira: "CBD-1", description: "d" } },
      transactions: {},
      performer: {},
    };
    const { capsFile } = mergeCaps(protos({ sdk: [{ name: "SDK_QUERY", number: 12 }] }), existing);
    assert.equal(capsFile.sdk.SDK_QUERY.number, 12);
  });

  test("seeds jira from a ticket mentioned in the proto comment", () => {
    const { capsFile } = mergeCaps(
      protos({
        sdk: [{ name: "SDK_KV_RANGE_SCAN", number: 1, comment: "KV range scan. See CBD-5161 for requirements." }],
      }),
    );
    assert.equal(capsFile.sdk.SDK_KV_RANGE_SCAN.jira, "CBD-5161");
  });

  test("keeps a cap the protos have dropped, and reports it as removed", () => {
    const existing: CapsFile = {
      sdk: { SDK_GONE: { number: 5, jira: "CBD-2", description: "Retired." } },
      transactions: {},
      performer: {},
    };
    const { capsFile, removed } = mergeCaps(protos(), existing);
    assert.deepEqual(removed, ["sdk.SDK_GONE"]);
    assert.equal(capsFile.sdk.SDK_GONE.jira, "CBD-2");
  });

  test("keeps the three groups separate even when numbers collide", () => {
    const { capsFile } = mergeCaps(
      protos({
        sdk: [{ name: "SDK_ZERO", number: 0 }],
        transactions: [{ name: "TXN_ZERO", number: 0 }],
        performer: [{ name: "PERF_ZERO", number: 0 }],
      }),
    );
    assert.deepEqual(Object.keys(capsFile.sdk), ["SDK_ZERO"]);
    assert.deepEqual(Object.keys(capsFile.transactions), ["TXN_ZERO"]);
    assert.deepEqual(Object.keys(capsFile.performer), ["PERF_ZERO"]);
  });
});

describe("formatCapsFile", () => {
  test("emits JSON5 that parses back to the same caps", () => {
    const { capsFile } = mergeCaps(
      protos({
        sdk: [{ name: "SDK_QUERY", number: 12, comment: 'Handles "quoted" text, and a backslash \\.' }],
        transactions: [{ name: "EXT_QUERY", number: 6 }],
      }),
    );
    assert.deepEqual(JSON5.parse<CapsFile>(formatCapsFile(capsFile)), capsFile);
  });

  test("orders caps by their enum number, matching the proto", () => {
    const { capsFile } = mergeCaps(
      protos({
        sdk: [
          { name: "THIRD", number: 22 },
          { name: "FIRST", number: 0 },
          { name: "SECOND", number: 4 },
        ],
      }),
    );
    const text = formatCapsFile(capsFile);
    assert.ok(text.indexOf("FIRST") < text.indexOf("SECOND"));
    assert.ok(text.indexOf("SECOND") < text.indexOf("THIRD"));
  });
});
