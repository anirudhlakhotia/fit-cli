/**
 * Unit tests for the pure age-reaping helpers in instance-age.ts.
 *
 * Run on their own:
 *   node --import tsx --test src/cloud/util/aws/tests/instance-age.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAge, instanceAgeMs, parseDuration, selectAgedOut } from "../instance-age.js";
import type { InstanceInfo } from "../parse-instance.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test("parseDuration handles each unit", () => {
  assert.equal(parseDuration("3600s"), 3600 * 1000);
  assert.equal(parseDuration("90m"), 90 * 60 * 1000);
  assert.equal(parseDuration("24h"), 24 * HOUR);
  assert.equal(parseDuration("2d"), 2 * DAY);
});

test("parseDuration tolerates surrounding whitespace and inner space", () => {
  assert.equal(parseDuration("  12 h "), 12 * HOUR);
});

test("parseDuration rejects malformed input", () => {
  for (const bad of ["", "h", "24", "24hours", "-1h", "1.5h", "1w"]) {
    assert.throws(() => parseDuration(bad), /Invalid duration/, `expected "${bad}" to throw`);
  }
});

test("instanceAgeMs computes age from launch time", () => {
  const now = Date.parse("2026-06-15T12:00:00Z");
  assert.equal(instanceAgeMs({ instanceId: "i-a", state: "running", launchTime: "2026-06-15T10:00:00Z" }, now), 2 * HOUR);
});

test("instanceAgeMs returns undefined for missing or unparseable launch time", () => {
  const now = Date.parse("2026-06-15T12:00:00Z");
  assert.equal(instanceAgeMs({ instanceId: "i-a", state: "running" }, now), undefined);
  assert.equal(instanceAgeMs({ instanceId: "i-b", state: "running", launchTime: "not-a-date" }, now), undefined);
});

test("selectAgedOut reaps only instances at or past the cutoff", () => {
  const now = Date.parse("2026-06-15T12:00:00Z");
  const old: InstanceInfo = { instanceId: "i-old", state: "running", launchTime: "2026-06-14T11:00:00Z" }; // 25h
  const fresh: InstanceInfo = { instanceId: "i-fresh", state: "running", launchTime: "2026-06-15T11:00:00Z" }; // 1h
  const exactly: InstanceInfo = { instanceId: "i-exact", state: "running", launchTime: "2026-06-14T12:00:00Z" }; // exactly 24h

  const { reap, keep } = selectAgedOut([old, fresh, exactly], 24 * HOUR, now);
  assert.deepEqual(reap.map((i) => i.instanceId), ["i-old", "i-exact"]);
  assert.deepEqual(keep.map((i) => i.instanceId), ["i-fresh"]);
});

test("selectAgedOut keeps (never reaps) instances with unknown age", () => {
  const now = Date.parse("2026-06-15T12:00:00Z");
  const noTime: InstanceInfo = { instanceId: "i-notime", state: "running" };
  const { reap, keep } = selectAgedOut([noTime], 1 * HOUR, now);
  assert.deepEqual(reap, []);
  assert.deepEqual(keep.map((i) => i.instanceId), ["i-notime"]);
});

test("formatAge renders short human strings", () => {
  assert.equal(formatAge(2 * DAY + 3 * HOUR), "2d 3h");
  assert.equal(formatAge(25 * HOUR), "1d 1h");
  assert.equal(formatAge(90 * 60 * 1000), "1h 30m");
  assert.equal(formatAge(30 * 1000), "<1m");
});
