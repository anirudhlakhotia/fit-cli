import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeGrpcFrame, decodePerformerCapsResponse, encodeGrpcFrame } from "../performer-caps-rpc.js";

/**
 * A real gRPC response body captured from ghcr.io/couchbase/java-fit-performer:main.
 *
 * The decoder is hand-rolled against the FIT protos, so this fixture is what stops it
 * quietly rotting: if the wire format or our reading of it ever drifts, this fails.
 */
const JAVA_CAPS_RESPONSE_BASE64 =
  "AAAAAGsKHQABAwUEBgcLCAoJDA0ODxASExQVERYXGBoZGxweEghqYXZhLXNkaxoDMi4wIgUzLjUuMDICAAE6CgABDgQCAwcIBglCJAgJGBkAChMSAQIDBAUGBwsMDw0OEBEUFRYXGxweHyAiIyQlJw==";

const javaResponse = Buffer.from(JAVA_CAPS_RESPONSE_BASE64, "base64");

describe("gRPC framing", () => {
  test("encodes an empty request as a bare 5-byte header", () => {
    const frame = encodeGrpcFrame(new Uint8Array(0));
    assert.equal(frame.length, 5);
    assert.equal(frame.readUInt8(0), 0);
    assert.equal(frame.readUInt32BE(1), 0);
  });

  test("round-trips a message through encode/decode", () => {
    const message = Buffer.from([1, 2, 3, 4]);
    assert.deepEqual(decodeGrpcFrame(encodeGrpcFrame(message)), message);
  });

  test("rejects a compressed frame rather than decoding garbage", () => {
    const frame = encodeGrpcFrame(Buffer.from([1]));
    frame.writeUInt8(1, 0);
    assert.throws(() => decodeGrpcFrame(frame), /compressed/);
  });

  test("rejects a frame whose declared length disagrees with the body", () => {
    const frame = encodeGrpcFrame(Buffer.from([1, 2, 3]));
    frame.writeUInt32BE(99, 1);
    assert.throws(() => decodeGrpcFrame(frame), /length mismatch/);
  });

  test("rejects a body too short to be a frame", () => {
    assert.throws(() => decodeGrpcFrame(Buffer.from([0, 0])), /too short/);
  });
});

describe("decoding a real java performer response", () => {
  const caps = decodePerformerCapsResponse(decodeGrpcFrame(javaResponse));

  test("reads the identifying strings", () => {
    assert.equal(caps.userAgent, "java-sdk");
    assert.equal(caps.libraryVersion, "3.5.0");
    assert.equal(caps.transactionsProtocolVersion, "2.0");
  });

  test("keeps the three cap enums apart", () => {
    // All three enums number from 0, so a bug that merged them would be invisible in
    // any single list. Assert the exact contents of each.
    assert.deepEqual(
      caps.transactionCaps,
      [0, 1, 3, 5, 4, 6, 7, 11, 8, 10, 9, 12, 13, 14, 15, 16, 18, 19, 20, 21, 17, 22, 23, 24, 26, 25, 27, 28, 30],
    );
    assert.deepEqual(
      caps.sdkCaps,
      [
        8, 9, 24, 25, 0, 10, 19, 18, 1, 2, 3, 4, 5, 6, 7, 11, 12, 15, 13, 14, 16, 17, 20, 21, 22, 23, 27, 28, 30, 31,
        32, 34, 35, 36, 37, 39,
      ],
    );
    assert.deepEqual(caps.performerCaps, [0, 1, 14, 4, 2, 3, 7, 8, 6, 9]);
  });

  test("reads the supported APIs (DEFAULT and ASYNC)", () => {
    assert.deepEqual(caps.supportedApis, [0, 1]);
  });
});

describe("decoding degenerate responses", () => {
  test("an empty message yields empty cap lists rather than throwing", () => {
    const caps = decodePerformerCapsResponse(Buffer.alloc(0));
    assert.deepEqual(caps.sdkCaps, []);
    assert.deepEqual(caps.transactionCaps, []);
    assert.deepEqual(caps.performerCaps, []);
    assert.equal(caps.userAgent, undefined);
  });

  test("unknown fields from a newer performer are ignored, not fatal", () => {
    // Field 99, varint 7 — a field this fit-cli has never heard of.
    const withUnknownField = Buffer.concat([decodeGrpcFrame(javaResponse), Buffer.from([0x98, 0x06, 0x07])]);
    const caps = decodePerformerCapsResponse(withUnknownField);
    assert.equal(caps.userAgent, "java-sdk");
    assert.equal(caps.sdkCaps.length, 36);
  });
});
