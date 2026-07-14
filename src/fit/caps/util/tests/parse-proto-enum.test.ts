import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseProtoEnum } from "../parse-proto-enum.js";

const SOURCE = `
syntax = "proto3";

enum Caps {
    // The performer supports GRPC workloads.
    // Second line of the same comment.
    GRPC_TESTING = 0;

    KV_SUPPORT_1 = 1;

    /**
     * A block comment.
     */
    CLUSTER_CONFIG_CERT = 7;

    // Out of order on purpose.
    LARGE_VALUES = 10;
}

enum Other {
  NOT_THIS = 0;
}
`;

describe("parseProtoEnum", () => {
  const members = parseProtoEnum(SOURCE, "Caps");

  test("reads every member of the named enum, and only that enum", () => {
    assert.deepEqual(
      members.map((m) => m.name),
      ["GRPC_TESTING", "KV_SUPPORT_1", "CLUSTER_CONFIG_CERT", "LARGE_VALUES"],
    );
  });

  test("reads the enum numbers, which need not be in order", () => {
    assert.deepEqual(
      members.map((m) => m.number),
      [0, 1, 7, 10],
    );
  });

  test("flattens a multi-line // comment into one description", () => {
    assert.equal(members[0].comment, "The performer supports GRPC workloads. Second line of the same comment.");
  });

  test("has no comment where the proto gives none", () => {
    assert.equal(members[1].comment, undefined);
  });

  test("handles block comments", () => {
    assert.equal(members[2].comment, "A block comment.");
  });

  test("attaches the comment directly above a member", () => {
    assert.equal(members[3].comment, "Out of order on purpose.");
  });

  test("throws rather than silently returning nothing when the enum is missing", () => {
    assert.throws(() => parseProtoEnum(SOURCE, "Nonexistent"), /Could not find/);
  });

  test("ignores a deprecated-option suffix on a member", () => {
    const withOption = "enum Caps {\n  OLD = 3 [deprecated = true];\n}";
    assert.deepEqual(parseProtoEnum(withOption, "Caps"), [{ name: "OLD", number: 3, comment: undefined }]);
  });
});
