/**
 * Unit tests for pickLatestImageId.
 *
 * Run on their own:
 *   node --import tsx --test src/cloud/util/aws/tests/image.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { pickLatestImageId } from "../image.js";

test("picks the image with the most recent CreationDate", () => {
  const images = [
    { ImageId: "ami-old", CreationDate: "2024-01-01T00:00:00.000Z" },
    { ImageId: "ami-new", CreationDate: "2025-06-01T00:00:00.000Z" },
    { ImageId: "ami-mid", CreationDate: "2024-12-01T00:00:00.000Z" },
  ];
  assert.equal(pickLatestImageId(images), "ami-new");
});

test("treats a missing CreationDate as oldest", () => {
  const images = [{ ImageId: "ami-undated" }, { ImageId: "ami-dated", CreationDate: "2020-01-01T00:00:00.000Z" }];
  assert.equal(pickLatestImageId(images), "ami-dated");
});

test("returns null for an empty list", () => {
  assert.equal(pickLatestImageId([]), null);
});
