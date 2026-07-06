/**
 * parseCloudClusterUuid — pull the Couchbase cluster's own UUID out of
 * `cbdinocluster --verbose allocate` output for the `cloud` (Capella) deployer.
 * Pure string logic, so it can be unit tested (see tests/parse-cloud-cluster-uuid.test.ts).
 *
 * cbdinocluster's `allocate` command logs this via zap whenever the deployer is
 * `cloud` (see cmd/allocate.go), e.g.:
 *
 *   2026-07-01T17:18:26.159Z	INFO	cmd/allocate.go:128	cloud cluster was allocated	{"cloud-id": "e781cee3-537b-488f-8b44-e89d08aec972"}
 *
 * This is distinct from cbdinocluster's own tracking id (the plain UUID/hex32
 * printed on its own line and extracted by parse-allocated-id.ts) — see
 * setup-declarative-cluster.ts for why the distinction matters.
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";

const CLOUD_ID_FIELD = /"cloud-id":\s*"([0-9a-f-]+)"/i;

/**
 * Extract the Couchbase cluster's own UUID from `cbdinocluster allocate`
 * output, or null if the deployer wasn't `cloud` (or the field wasn't printed).
 */
export function parseCloudClusterUuid(output: string): string | null {
  const match = CLOUD_ID_FIELD.exec(output);
  return match ? match[1] : null;
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const raw = process.argv[2] ?? "";
    console.log(parseCloudClusterUuid(raw) ?? "(no cloud cluster uuid found)");
    return Promise.resolve();
  });
}
