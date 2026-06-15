/**
 * Unit tests for the pure CNG Kubernetes helpers.
 *
 * Run on their own:
 *   bun test
 *   node --import tsx --test src/workflows/cluster/cluster-create/tests/cng-kubernetes.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRemoteK8sBlock,
  cbdinoclusterHasK8sEnabled,
  CNG_K3D_CONTEXT,
  withRemoteK8sBlock,
} from "../cng-kubernetes.js";

test("cbdinoclusterHasK8sEnabled accepts the string \"true\" cbdinocluster writes", () => {
  assert.equal(cbdinoclusterHasK8sEnabled({ k8s: { enabled: "true" } }), true);
});

test("cbdinoclusterHasK8sEnabled accepts a boolean true", () => {
  assert.equal(cbdinoclusterHasK8sEnabled({ k8s: { enabled: true } }), true);
});

test("cbdinoclusterHasK8sEnabled is false when k8s is absent, disabled, or malformed", () => {
  assert.equal(cbdinoclusterHasK8sEnabled({ docker: { enabled: true } }), false);
  assert.equal(cbdinoclusterHasK8sEnabled({ k8s: { enabled: "false" } }), false);
  assert.equal(cbdinoclusterHasK8sEnabled({ k8s: {} }), false);
  assert.equal(cbdinoclusterHasK8sEnabled(null), false);
  assert.equal(cbdinoclusterHasK8sEnabled("nope"), false);
});

test("buildRemoteK8sBlock points cbdinocluster at the k3d cluster under the given home", () => {
  assert.deepEqual(buildRemoteK8sBlock("/home/ubuntu"), {
    k8s: {
      enabled: "true",
      "cao-tools": "/home/ubuntu/.dinotools/cao/2.8.0",
      kubeconfig: "/home/ubuntu/.config/k3d/kubeconfig-fit-cli-cluster.yaml",
      context: CNG_K3D_CONTEXT,
    },
  });
});

test("withRemoteK8sBlock merges the k8s block onto an existing init config without dropping fields", () => {
  const merged = withRemoteK8sBlock(
    { version: 6, docker: { enabled: true, network: "fit" } },
    "/home/ubuntu",
  );
  assert.equal(merged.version, 6);
  assert.deepEqual(merged.docker, { enabled: true, network: "fit" });
  assert.equal((merged.k8s as Record<string, unknown>).context, CNG_K3D_CONTEXT);
});
