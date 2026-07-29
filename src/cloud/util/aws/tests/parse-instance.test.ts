/**
 * Unit tests for parseInstances.
 *
 * Run on their own:
 *   node --import tsx --test src/cloud/util/aws/tests/parse-instance.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInstances } from "../parse-instance.js";

test("flattens instances across reservations with state and addresses", () => {
  const response = {
    Reservations: [
      {
        Instances: [
          {
            InstanceId: "i-aaa",
            State: { Name: "running" },
            PublicDnsName: "ec2-1-2-3-4.compute.amazonaws.com",
            PublicIpAddress: "1.2.3.4",
          },
        ],
      },
      { Instances: [{ InstanceId: "i-bbb", State: { Name: "pending" } }] },
    ],
  };
  assert.deepEqual(parseInstances(response), [
    {
      instanceId: "i-aaa",
      state: "running",
      publicDns: "ec2-1-2-3-4.compute.amazonaws.com",
      publicIp: "1.2.3.4",
    },
    { instanceId: "i-bbb", state: "pending", publicDns: undefined, publicIp: undefined },
  ]);
});

test("treats empty public DNS/IP strings as absent", () => {
  const response = {
    Reservations: [{ Instances: [{ InstanceId: "i-ccc", State: { Name: "pending" }, PublicDnsName: "", PublicIpAddress: "" }] }],
  };
  assert.deepEqual(parseInstances(response), [
    { instanceId: "i-ccc", state: "pending", publicDns: undefined, publicIp: undefined },
  ]);
});

test("skips instances without an id and defaults a missing state", () => {
  const response = { Reservations: [{ Instances: [{ State: { Name: "running" } }, { InstanceId: "i-ddd" }] }] };
  assert.deepEqual(parseInstances(response), [
    { instanceId: "i-ddd", state: "unknown", publicDns: undefined, publicIp: undefined },
  ]);
});

test("reads the top-level Instances shape returned by run-instances", () => {
  const response = {
    Instances: [
      { InstanceId: "i-eee", State: { Name: "pending" } },
      { InstanceId: "i-fff", State: { Name: "pending" }, PublicIpAddress: "5.6.7.8" },
    ],
  };
  assert.deepEqual(parseInstances(response), [
    { instanceId: "i-eee", state: "pending", publicDns: undefined, publicIp: undefined },
    { instanceId: "i-fff", state: "pending", publicDns: undefined, publicIp: "5.6.7.8" },
  ]);
});

test("reads the key pair name", () => {
  const response = {
    Reservations: [
      {
        Instances: [
          { InstanceId: "i-hhh", State: { Name: "running" }, KeyName: "fit-cli-abc123" },
        ],
      },
    ],
  };
  assert.deepEqual(parseInstances(response), [
    { instanceId: "i-hhh", state: "running", publicDns: undefined, publicIp: undefined, keyName: "fit-cli-abc123" },
  ]);
});

test("an empty / absent reservation list yields no instances", () => {
  assert.deepEqual(parseInstances({}), []);
  assert.deepEqual(parseInstances({ Reservations: [] }), []);
  assert.deepEqual(parseInstances({ Instances: [] }), []);
});

test("reads the created-by tag into creator", () => {
  const response = {
    Reservations: [
      {
        Instances: [
          {
            InstanceId: "i-ggg",
            State: { Name: "running" },
            Tags: [{ Key: "created-by", Value: "alice" }],
          },
        ],
      },
    ],
  };
  assert.deepEqual(parseInstances(response), [
    { instanceId: "i-ggg", state: "running", publicDns: undefined, publicIp: undefined, creator: "alice" },
  ]);
});
