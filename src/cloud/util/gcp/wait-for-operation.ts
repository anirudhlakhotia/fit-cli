/**
 * wait-for-operation — block until a GCP zone operation (insert/delete, etc.)
 * reaches DONE. ZoneOperationsClient.wait is a server-side long-poll capped at
 * a couple of minutes per call, so this loops until the operation is actually
 * done rather than assuming one call suffices. Shared by create-instance.ts
 * and terminate-instance.ts.
 */
import type { ZoneOperationsClient } from "@google-cloud/compute";

const OPERATION_TIMEOUT_MS = 600_000;
const RETRY_DELAY_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForZoneOperation(
  client: ZoneOperationsClient,
  project: string,
  zone: string,
  operationName: string | undefined,
): Promise<void> {
  if (!operationName) {
    throw new Error("GCP operation had no name to wait on — cannot confirm it completed.");
  }
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  for (;;) {
    const [op] = await client.wait({ project, zone, operation: operationName });
    // compute v1 is a REST API (unlike this library's gRPC-transport clients), so
    // its JSON responses carry the enum's string name directly — `op.status` is
    // the literal string "DONE", not the numeric enum value the .d.ts's
    // `Status|keyof typeof Status` union also allows for.
    if (op.status === "DONE") {
      if (op.error?.errors?.length) {
        throw new Error(`GCP operation ${operationName} failed: ${JSON.stringify(op.error.errors)}`);
      }
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for GCP operation ${operationName} (last status: ${op.status ?? "unknown"}).`);
    }
    // wait() is a server-side long-poll (capped ~2 min) but may return early with
    // a non-DONE status; pace the retry instead of hammering the API.
    await sleep(RETRY_DELAY_MS);
  }
}
