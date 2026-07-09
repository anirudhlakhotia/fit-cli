/**
 * Preflight connectivity check for the shared OpenTelemetry collector
 * (performance-sdk.couchbase.com) that functional observability tests
 * (ClusterLabelsTest, GetOrNullObservabilityTest, etc.) export traces/metrics to
 * and then poll back from. When it's unreachable, every one of those tests only
 * discovers that after burning its full 60s-per-assertion retry budget — this
 * check catches it in seconds, before any test runs.
 *
 * Run on its own:
 *   bun src/fit/functional/util/check-observability-collector.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { capture } from "../../../util/non-fit/proc.js";

export const OBSERVABILITY_COLLECTOR_HOST = "performance-sdk.couchbase.com";
/** OTLP gRPC port; any of the collector's exposed ports works equally well as a bare TCP reachability probe. */
export const OBSERVABILITY_COLLECTOR_PORT = 10003;

/**
 * TCP connectivity probe: returns true if the observability collector is
 * reachable, false if not. Pass a `captureCommand` to run the check from a
 * remote execution context (the box the tests actually run on).
 */
export async function checkObservabilityCollectorConnectivity(
  captureCommand?: (cmd: string, args: string[]) => Promise<string>,
  host: string = OBSERVABILITY_COLLECTOR_HOST,
  port: number = OBSERVABILITY_COLLECTOR_PORT,
): Promise<boolean> {
  const run = captureCommand ?? ((cmd: string, args: string[]) => capture(cmd, args));
  try {
    await run("nc", ["-z", "-w", "5", host, String(port)]);
    return true;
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const reachable = await checkObservabilityCollectorConnectivity();
    console.log(
      reachable
        ? `✓ Reached ${OBSERVABILITY_COLLECTOR_HOST}:${OBSERVABILITY_COLLECTOR_PORT}.`
        : `✗ Cannot reach ${OBSERVABILITY_COLLECTOR_HOST}:${OBSERVABILITY_COLLECTOR_PORT}.`,
    );
    return { artifacts: [], details: [] };
  });
}
