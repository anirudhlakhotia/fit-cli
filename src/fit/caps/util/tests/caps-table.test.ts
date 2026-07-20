import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sdkByValue } from "../../../../util/sdk/sdks.js";
import { capsByNumber, type CapsFile } from "../caps-metadata.js";
import {
  CROSS,
  TICK,
  UNKNOWN,
  capCell,
  formatCapGroupTable,
  reportedNumbers,
  unknownCapNumbers,
  type CapsFetchResult,
} from "../caps-table.js";
import type { PerformerCaps } from "../performer-caps-rpc.js";

const java = sdkByValue("java")!;
const go = sdkByValue("go")!;
const rust = sdkByValue("rust")!;

const CAPS_FILE: CapsFile = {
  sdk: {
    SDK_PRESERVE_EXPIRY: { number: 0, jira: "CBD-1", description: "" },
    SDK_KV_RANGE_SCAN: { number: 1, jira: "CBD-5161", description: "" },
  },
  transactions: {
    EXT_TRANSACTION_ID: { number: 0, jira: "", description: "" },
  },
  performer: {
    GRPC_TESTING: { number: 0, jira: "", description: "" },
  },
};

function caps(overrides: Partial<PerformerCaps>): PerformerCaps {
  return { sdkCaps: [], transactionCaps: [], performerCaps: [], supportedApis: [], ...overrides };
}

const results: CapsFetchResult[] = [
  { sdk: java, status: "ok", caps: caps({ sdkCaps: [0, 1], transactionCaps: [0], performerCaps: [0] }) },
  // go supports sdk cap 1 but not 0 — and reports cap 7, which caps.json5 has never heard of.
  { sdk: go, status: "ok", caps: caps({ sdkCaps: [1, 7] }) },
  { sdk: rust, status: "error", error: "image pull failed" },
];

describe("reportedNumbers", () => {
  test("reads each group from its own field, never mixing them", () => {
    const performerCaps = caps({ sdkCaps: [1], transactionCaps: [2], performerCaps: [3] });
    assert.deepEqual(reportedNumbers(performerCaps, "sdk"), [1]);
    assert.deepEqual(reportedNumbers(performerCaps, "transactions"), [2]);
    assert.deepEqual(reportedNumbers(performerCaps, "performer"), [3]);
  });
});

describe("capCell", () => {
  test("ticks a supported cap and crosses an unsupported one", () => {
    assert.equal(capCell(results[0], "sdk", 0), TICK);
    assert.equal(capCell(results[1], "sdk", 0), CROSS);
    assert.equal(capCell(results[1], "sdk", 1), TICK);
  });

  test("shows unknown, not a cross, when the performer never answered", () => {
    // A failed fetch means we have no idea whether rust supports this — a cross
    // would be a lie.
    assert.equal(capCell(results[2], "sdk", 0), UNKNOWN);
  });

  test("does not let a cap number from one group tick a cap in another", () => {
    // This performer reports transactions cap 0 and performer cap 0, but sdk cap 0
    // must be decided only by sdkCaps.
    const sdkOnly: CapsFetchResult = {
      sdk: java,
      status: "ok",
      caps: caps({ transactionCaps: [0], performerCaps: [0] }),
    };
    assert.equal(capCell(sdkOnly, "sdk", 0), CROSS);
    assert.equal(capCell(sdkOnly, "transactions", 0), TICK);
  });
});

describe("unknownCapNumbers", () => {
  test("surfaces caps a performer reports that caps.json5 lacks", () => {
    assert.deepEqual(unknownCapNumbers(results, capsByNumber(CAPS_FILE, "sdk"), "sdk"), [7]);
  });

  test("is empty when every reported cap is catalogued", () => {
    assert.deepEqual(unknownCapNumbers(results, capsByNumber(CAPS_FILE, "transactions"), "transactions"), []);
  });
});

describe("formatCapGroupTable", () => {
  const table = formatCapGroupTable("sdk", CAPS_FILE, results)!;

  test("has a row per known cap, plus a row for the uncatalogued one", () => {
    assert.match(table, /SDK_PRESERVE_EXPIRY/);
    assert.match(table, /SDK_KV_RANGE_SCAN/);
    assert.match(table, /#7 \(not in caps\.json5\)/);
  });

  test("has a column per SDK", () => {
    for (const label of ["java", "go", "rust"]) {
      assert.ok(table.includes(label), `expected a ${label} column`);
    }
  });

  test("renders ticks and crosses", () => {
    assert.ok(table.includes(TICK), "expected a tick");
    assert.ok(table.includes(CROSS), "expected a cross");
  });

  test("orders rows most-recently-added first (highest enum number at the top)", () => {
    const order = ["#7 (not in caps.json5)", "SDK_KV_RANGE_SCAN", "SDK_PRESERVE_EXPIRY"].map((label) =>
      table.indexOf(label),
    );
    assert.ok(
      order[0] < order[1] && order[1] < order[2],
      `expected descending-by-number order, got positions ${order.join(", ")}`,
    );
  });
});

describe("capsByNumber", () => {
  test("rejects a caps file with two caps sharing a number, which would hide one", () => {
    const clashing: CapsFile = {
      ...CAPS_FILE,
      sdk: { A: { number: 1, description: "" }, B: { number: 1, description: "" } },
    };
    assert.throws(() => capsByNumber(clashing, "sdk"), /two sdk caps with number 1/);
  });
});
