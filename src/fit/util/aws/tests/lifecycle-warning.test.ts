import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatEc2CleanupPromptBanner,
  formatEc2DeletionResponsibilityBanner,
  terminateInstanceCommand,
} from "../lifecycle-warning.js";

test("terminateInstanceCommand includes the instance id", () => {
  assert.equal(
    terminateInstanceCommand("i-123"),
    "npx tsx src/cloud/util/aws/terminate-instance.ts --id i-123",
  );
});

test("formatEc2DeletionResponsibilityBanner interactive mode offers to delete", () => {
  const banner = formatEc2DeletionResponsibilityBanner("i-123", "ec2-1-2-3-4.compute.amazonaws.com", undefined, undefined, true);

  assert.match(banner, /EC2 LIFECYCLE WARNING/);
  assert.match(banner, /This instance keeps incurring AWS charges until it is terminated\./);
  assert.match(banner, /fit-cli will offer to delete it at the end of the run\./);
  assert.match(banner, /you must delete it yourself\./);
  assert.match(banner, /terminate-instance\.ts --id i-123/);
});

test("formatEc2DeletionResponsibilityBanner non-interactive mode says automatically deleted", () => {
  const banner = formatEc2DeletionResponsibilityBanner("i-123", "ec2-1-2-3-4.compute.amazonaws.com", undefined, undefined, false);

  assert.match(banner, /fit-cli will automatically delete it at the end of the run\./);
  assert.doesNotMatch(banner, /fit-cli will offer to delete it at the end of the run\./);
});

test("formatEc2CleanupPromptBanner explains the default cleanup choice", () => {
  const banner = formatEc2CleanupPromptBanner("i-123");

  assert.match(banner, /EC2 CLEANUP DECISION/);
  assert.match(banner, /This instance is still running and still billable\./);
  assert.match(banner, /Choose No to terminate it now \(recommended, and the default\)\./);
  assert.match(banner, /Choose Yes only if you want to keep debugging and will delete it yourself\./);
});
