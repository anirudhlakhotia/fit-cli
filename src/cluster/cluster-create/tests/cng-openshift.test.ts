/**
 * Unit tests for the pure CNG OpenShift (ROSA) helpers.
 *
 * Run on their own:
 *   bun run test
 *   node --import tsx --test src/cluster/cluster-create/tests/cng-openshift.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildOpenShiftK8sBlock,
  checkCngCapacity,
  CNG_CPU_MILLICORES_PER_NODE,
  CNG_EMERGENCY_CLEANUP_COMMAND,
  cngKubernetesBackend,
  DEFAULT_OC_VERSION,
  formatCngCapacityShortfall,
  ocInstallScript,
  preflightCngCapacity,
  resolveOcVersion,
  withOpenShiftK8sBlock,
  type OpenShiftExecutor,
} from "../cng-openshift.js";
import { CAO_TOOLS_VERSION } from "../install-cao-tools.js";
import { ClassifiedFailure } from "../../../fit/shared/failure-classification.js";

/** Fake executor returning canned `oc get nodes`/`oc get pods` JSON. */
function fakeOcExecutor(nodesJson: string, podsJson: string): OpenShiftExecutor {
  return {
    description: "fake",
    run: () => Promise.resolve(),
    capture: (command, args) => {
      if (command === "oc" && args[1] === "nodes") return Promise.resolve(nodesJson);
      if (command === "oc" && args[1] === "pods") return Promise.resolve(podsJson);
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
  };
}

test("cngKubernetesBackend defaults to openshift and only switches to k3d on FIT_CNG_K8S=k3d", () => {
  assert.equal(cngKubernetesBackend({}), "openshift");
  assert.equal(cngKubernetesBackend({ FIT_CNG_K8S: "openshift" }), "openshift");
  assert.equal(cngKubernetesBackend({ FIT_CNG_K8S: "k3d" }), "k3d");
  assert.equal(cngKubernetesBackend({ FIT_CNG_K8S: "K3D" }), "k3d");
});

test("resolveOcVersion honours the OC_VERSION override, else the pinned default", () => {
  assert.equal(resolveOcVersion({}), DEFAULT_OC_VERSION);
  assert.equal(resolveOcVersion({ OC_VERSION: "4.12.0" }), "4.12.0");
});

test("buildOpenShiftK8sBlock points cbdinocluster at the logged-in OpenShift context", () => {
  assert.deepEqual(buildOpenShiftK8sBlock("/home/ubuntu", "rosa/api-example:6443/cluster-admin"), {
    k8s: {
      enabled: "true",
      "cao-tools": `/home/ubuntu/.dinotools/cao/${CAO_TOOLS_VERSION}`,
      kubeconfig: "/home/ubuntu/.kube/config",
      context: "rosa/api-example:6443/cluster-admin",
    },
  });
});

test("withOpenShiftK8sBlock merges the k8s block onto an init config without dropping fields", () => {
  const merged = withOpenShiftK8sBlock({ version: 6, docker: { network: "fit" } }, "/home/ubuntu", "ctx");
  assert.equal(merged.version, 6);
  assert.deepEqual(merged.docker, { network: "fit" });
  assert.equal((merged.k8s as Record<string, unknown>).context, "ctx");
});

test("ocInstallScript pins the version, verifies a checksum, and is idempotent", () => {
  const script = ocInstallScript("4.10.67");
  assert.match(script, /ver=4\.10\.67/);
  // Idempotency guard: skip when oc already reports the pinned version.
  assert.match(script, /oc version --client/);
  // Checksum verification against the mirror's sha256sum.txt (or pinned OC_SHA256).
  assert.match(script, /sha256sum\.txt/);
  assert.match(script, /sha256 mismatch/);
});

function nodesJson(allocatableCpu: string[]): string {
  return JSON.stringify({ items: allocatableCpu.map((cpu) => ({ status: { allocatable: { cpu } } })) });
}

function podsJson(requestedCpu: string[]): string {
  return JSON.stringify({
    items: requestedCpu.map((cpu) => ({ spec: { containers: [{ resources: { requests: { cpu } } }] } })),
  });
}

test("checkCngCapacity sums allocatable minus requested CPU, in millicores", async () => {
  // 3 nodes at 3.5 CPU each = 10500m allocatable; one pod requesting 2 CPU = 2000m
  // requested; 8500m free. 4 nodes needed at 2000m/node = 8000m required — fits.
  const executor = fakeOcExecutor(nodesJson(["3500m", "3500m", "3500m"]), podsJson(["2"]));
  const capacity = await checkCngCapacity(executor, 4);
  assert.equal(capacity.freeMillicores, 8500);
  assert.equal(capacity.requiredMillicores, 4 * CNG_CPU_MILLICORES_PER_NODE);
  assert.equal(capacity.nodeCount, 3);
  assert.equal(capacity.ok, true);
});

test("checkCngCapacity reports insufficient capacity when free CPU is below the requirement", async () => {
  const executor = fakeOcExecutor(nodesJson(["3500m", "3500m"]), podsJson(["2", "2"]));
  // 7000m allocatable - 4000m requested = 3000m free; 5 nodes needed = 10000m required.
  const capacity = await checkCngCapacity(executor, 5);
  assert.equal(capacity.freeMillicores, 3000);
  assert.equal(capacity.ok, false);
});

test("checkCngCapacity treats missing allocatable/requests fields as zero rather than throwing", async () => {
  const executor = fakeOcExecutor(
    JSON.stringify({ items: [{ status: {} }] }),
    JSON.stringify({ items: [{ spec: {} }] }),
  );
  const capacity = await checkCngCapacity(executor, 1);
  assert.equal(capacity.freeMillicores, 0);
  assert.equal(capacity.nodeCount, 1);
});

test("formatCngCapacityShortfall reports the shortfall and points at the emergency cleanup one-liner and cronjob", () => {
  const message = formatCngCapacityShortfall(
    { ok: false, freeMillicores: 3000, requiredMillicores: 10000, nodeCount: 2 },
    5,
    "ubuntu@ec2-1-2-3-4.compute.amazonaws.com",
  );
  assert.match(message, /5-node CNG cluster/);
  assert.match(message, /Free:\s+3\.0 CPU across 2 nodes/);
  assert.match(message, /Needed:\s+~10\.0 CPU/);
  assert.equal(message.includes(CNG_EMERGENCY_CLEANUP_COMMAND), true);
  assert.match(message, /cbdc-cleanup-cronjob/);
  // Must direct the user to run these on the remote box, not their own machine.
  assert.match(message, /Run the following on ubuntu@ec2-1-2-3-4\.compute\.amazonaws\.com/);
  assert.match(message, /NOT on your own machine/);
});

test("preflightCngCapacity throws a FatalToCluster ClassifiedFailure on insufficient capacity, so it's reported immediately rather than after the leave-up prompt", async () => {
  const executor = fakeOcExecutor(nodesJson(["2000m"]), podsJson([]));
  await assert.rejects(
    () => preflightCngCapacity(executor, 5),
    (err: unknown) => {
      assert.ok(err instanceof ClassifiedFailure);
      assert.equal(err.classification, "FatalToCluster");
      assert.match(err.message, /doesn't have enough free CPU/);
      return true;
    },
  );
});

test("preflightCngCapacity resolves without throwing when capacity is sufficient", async () => {
  const executor = fakeOcExecutor(nodesJson(["3500m", "3500m", "3500m"]), podsJson([]));
  await assert.doesNotReject(() => preflightCngCapacity(executor, 3));
});
