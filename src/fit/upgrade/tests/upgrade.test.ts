import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseUpgradeArgs, shasMatch } from "../upgrade.js";

describe("parseUpgradeArgs", () => {
  it("defaults to the latest channel with no flags", () => {
    assert.deepEqual(parseUpgradeArgs([]), { channel: "latest", check: false, yes: false, help: false });
  });

  it("accepts --channel ci (space form)", () => {
    assert.equal(parseUpgradeArgs(["--channel", "ci"]).channel, "ci");
  });

  it("accepts --channel=ci (equals form)", () => {
    assert.equal(parseUpgradeArgs(["--channel=ci"]).channel, "ci");
  });

  it("parses --check, --yes/-y and --help/-h", () => {
    assert.equal(parseUpgradeArgs(["--check"]).check, true);
    assert.equal(parseUpgradeArgs(["--yes"]).yes, true);
    assert.equal(parseUpgradeArgs(["-y"]).yes, true);
    assert.equal(parseUpgradeArgs(["--help"]).help, true);
    assert.equal(parseUpgradeArgs(["-h"]).help, true);
  });

  it("combines multiple flags", () => {
    assert.deepEqual(parseUpgradeArgs(["--channel=ci", "--check", "-y"]), {
      channel: "ci",
      check: true,
      yes: true,
      help: false,
    });
  });

  it("rejects an invalid channel", () => {
    assert.throws(() => parseUpgradeArgs(["--channel", "nightly"]), /--channel must be one of/);
    assert.throws(() => parseUpgradeArgs(["--channel=nope"]), /--channel must be one of/);
  });

  it("rejects --channel with no value", () => {
    assert.throws(() => parseUpgradeArgs(["--channel"]), /--channel must be one of/);
  });

  it("rejects unknown arguments", () => {
    assert.throws(() => parseUpgradeArgs(["--bogus"]), /Unknown argument/);
  });
});

describe("shasMatch", () => {
  it("matches identical full SHAs", () => {
    const sha = "a".repeat(40);
    assert.equal(shasMatch(sha, sha), true);
  });

  it("matches a short SHA that is a prefix of the full SHA (either order)", () => {
    const full = "abcdef1234567890abcdef1234567890abcdef12";
    assert.equal(shasMatch("abcdef1", full), true);
    assert.equal(shasMatch(full, "abcdef1"), true);
  });

  it("does not match differing SHAs", () => {
    assert.equal(shasMatch("abcdef1", "fedcba9"), false);
  });

  it("does not match when either side is empty", () => {
    assert.equal(shasMatch("", "abc"), false);
    assert.equal(shasMatch("abc", ""), false);
  });

  it("does not match the dev fallback 'unknown'", () => {
    assert.equal(shasMatch("unknown", "abcdef1234567890abcdef1234567890abcdef12"), false);
  });
});
