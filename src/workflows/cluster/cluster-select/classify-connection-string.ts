/**
 * Step: classify a Couchbase connection string into something this tool can act
 * on. Pure logic only — no prompting — so it's easy to unit test (see
 * tests/classify-connection-string.test.ts).
 *
 * Run on its own:
 *   npx tsx src/workflows/cluster/cluster-select/classify-connection-string.ts couchbase://localhost
 *
 * Prints the classification as JSON.
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";

/** The kind of cluster a supported connection string points at. */
export type ClusterFlavour = "internal-capella" | "production-capella" | "self-managed";

/** The result of inspecting a connection string. */
export type Classification =
  | {
      kind: "supported";
      /** The usable scheme (couchbase2:// is handled separately as protostellar). */
      scheme: "couchbase" | "couchbases";
      /** True when the scheme implies TLS (couchbases://). */
      tls: boolean;
      flavour: ClusterFlavour;
      /** The host portion, with scheme and any path/params stripped. */
      defaultHostname: string;
    }
  /** http(s):// — looks like Enterprise Analytics. */
  | { kind: "analytics" }
  /** couchbase2:// — Protostellar/CNG. */
  | { kind: "protostellar" }
  /** Anything else. */
  | { kind: "unsupported" };

/** The supported variant of {@link Classification}, for callers that have narrowed it. */
export type SupportedCluster = Extract<Classification, { kind: "supported" }>;

/** Strip the `scheme://` prefix and any trailing path/query, leaving just the host. */
function hostnameFrom(connectionString: string, scheme: string): string {
  const afterScheme = connectionString.slice(scheme.length + "://".length);
  const end = afterScheme.search(/[/?]/);
  return (end === -1 ? afterScheme : afterScheme.slice(0, end)).trim();
}

/** Inspect a connection string and decide what, if anything, we can do with it. */
export function classifyConnectionString(raw: string): Classification {
  const connectionString = raw.trim();
  const lower = connectionString.toLowerCase();

  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    return { kind: "analytics" };
  }
  if (lower.startsWith("couchbase2://")) {
    return { kind: "protostellar" };
  }

  let scheme: "couchbase" | "couchbases";
  if (lower.startsWith("couchbases://")) {
    scheme = "couchbases";
  } else if (lower.startsWith("couchbase://")) {
    scheme = "couchbase";
  } else {
    return { kind: "unsupported" };
  }

  const flavour: ClusterFlavour = lower.includes("nonprod-project-avengers")
    ? "internal-capella"
    : lower.includes("cloud.couchbase.com")
      ? "production-capella"
      : "self-managed";

  return {
    kind: "supported",
    scheme,
    tls: scheme === "couchbases",
    flavour,
    defaultHostname: hostnameFrom(connectionString, scheme),
  };
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const raw = process.argv[2];
    if (!raw) {
      console.error(
        "Usage: tsx src/workflows/cluster/cluster-select/classify-connection-string.ts <connection-string>",
      );
      process.exit(2);
    }
    console.log(JSON.stringify(classifyConnectionString(raw), null, 2));
    return Promise.resolve();
  });
}
