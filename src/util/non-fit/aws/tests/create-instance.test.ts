import assert from "node:assert/strict";
import { test } from "node:test";
import { runInstancesArgs } from "../create-instance.js";

const base = { amiId: "ami-1", instanceType: "t3.micro", keyName: "k", securityGroupId: "sg-1" };

test("runInstancesArgs emits the core run-instances arguments", () => {
  assert.deepEqual(runInstancesArgs(base), [
    "ec2",
    "run-instances",
    "--image-id",
    "ami-1",
    "--instance-type",
    "t3.micro",
    "--key-name",
    "k",
    "--security-group-ids",
    "sg-1",
    "--count",
    "1",
  ]);
});

test("runInstancesArgs adds --subnet-id when a subnet is given", () => {
  const args = runInstancesArgs({ ...base, subnetId: "subnet-abc" });
  const idx = args.indexOf("--subnet-id");
  assert.notEqual(idx, -1);
  assert.equal(args[idx + 1], "subnet-abc");
});

test("runInstancesArgs omits --subnet-id when no subnet is given", () => {
  assert.equal(runInstancesArgs(base).includes("--subnet-id"), false);
});
