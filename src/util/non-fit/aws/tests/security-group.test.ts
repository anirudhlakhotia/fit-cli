import assert from "node:assert/strict";
import { test } from "node:test";
import { createSecurityGroupArgs, securityGroupFilters } from "../security-group.js";

test("securityGroupFilters filters by name only when no vpc is given", () => {
  assert.deepEqual(securityGroupFilters("fit-cli"), ["Name=group-name,Values=fit-cli"]);
});

test("securityGroupFilters scopes to the vpc when one is given", () => {
  assert.deepEqual(securityGroupFilters("fit-cli", "vpc-123"), [
    "Name=group-name,Values=fit-cli",
    "Name=vpc-id,Values=vpc-123",
  ]);
});

test("createSecurityGroupArgs omits --vpc-id by default (uses the default VPC)", () => {
  const args = createSecurityGroupArgs({ name: "fit-cli", ingressPorts: [22] });
  assert.equal(args.includes("--vpc-id"), false);
  assert.deepEqual(args, ["ec2", "create-security-group", "--group-name", "fit-cli", "--description", "fit-cli"]);
});

test("createSecurityGroupArgs passes --vpc-id when set", () => {
  const args = createSecurityGroupArgs({ name: "fit-cli", description: "ephemeral", ingressPorts: [22], vpcId: "vpc-123" });
  const idx = args.indexOf("--vpc-id");
  assert.notEqual(idx, -1);
  assert.equal(args[idx + 1], "vpc-123");
});
