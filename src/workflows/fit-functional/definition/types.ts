/**
 * The shape of a `fit` YAML definition file — a repeatable, checked-in
 * description of one or more FIT runs. Today only `functional` iterations are
 * supported.
 */
import type { SdkValue } from "../../../util/sdk/sdks.js";
import type { PortInUsePolicy } from "../../performers/performer-port.js";
import type { CbdinoclusterDef } from "../../cluster/cluster-create/build-cluster-def.js";
import type { ClusterExistsPolicy } from "../../cluster/cluster-create/cluster-exists-policy.js";
import type { PieceData } from "../../../util/non-fit/config-pieces.js";

/** The `type:` discriminator every fit definition file carries. */
export const FIT_DEFINITION_TYPE = "fit";

/**
 * The current major version of the definition format. Bump this only on a
 * breaking change.
 */
export const CURRENT_FIT_DEFINITION_VERSION = 1;

/** The currently supported iteration kinds within a fit definition. */
export const FIT_ITERATION_TYPES = ["functional"] as const;

export type FitIterationType = (typeof FIT_ITERATION_TYPES)[number];

/** One fitConfig artifact-piece contributed by a definition iteration. */
export type FitConfigPiece = PieceData;

/** TLS config for a shared cluster connection. */
export type ClusterTls = null | { insecure: true } | { certPath: string };

/** Connection details for an already-running cluster. */
export interface ConnectionClusterSetup {
  connectionString: string;
  username: string;
  password: string;
  tls?: ClusterTls;
}

/** Marker that this definition should use a cluster already running elsewhere. */
export type UseExistingClusterSetup = Record<string, never>;

/**
 * A cbdinocluster to allocate for the run. The setup-cluster step writes
 * `config` out as a cbdinocluster def file and allocates it (see
 * setup-declarative-cluster.ts), then tests against the resulting cluster.
 */
export interface CbdinoclusterSetup {
  /**
   * The cbdinocluster definition to allocate — what goes under
   * `cbdinocluster.config` (the `nodes`, and optional `cao` for CNG). Built by
   * build-cluster-def.ts's buildClusterDefObject.
   */
  config: CbdinoclusterDef;
  /**
   * What to do if cbdinocluster already has a cluster running when setup-cluster
   * runs: `fail`, `useExisting`, or `destroyAndRecreate` (the default). Omitted
   * means {@link DEFAULT_CLUSTER_EXISTS_POLICY}.
   */
  onClusterExists?: ClusterExistsPolicy;
  /** Optional cbdinocluster deployer override (passed as `--deployer`). */
  deployer?: string;
}

/**
 * The cluster the whole run tests against. Provide exactly one of:
 * - `connection` — use these connection details for an already-running cluster,
 * - `useExisting` — test against an already-running cluster, or
 * - `cbdinocluster` — allocate a fresh cluster with cbdinocluster for the run.
 */
export interface ClusterSetup {
  /** Run against an already-running cluster described here. */
  connection?: ConnectionClusterSetup;
  /** Run against a cluster that already exists. */
  useExisting?: UseExistingClusterSetup;
  /** Allocate this cbdinocluster for the run. */
  cbdinocluster?: CbdinoclusterSetup;
}

/** The shared, top-level setup applied once for the whole run. */
export interface SharedSetup {
  cluster?: ClusterSetup;
}

/** Which performer to build and run for an iteration. */
export interface PerformerSetup {
  /** Which SDK to test, e.g. "java" — one of the values in SDKS. */
  sdk: SdkValue;
  /**
   * Port the performer listens on. Defaults to 8060. Custom ports aren't plumbed
   * through the performer/FITConfiguration machinery yet — see resolve-definition.
   */
  port?: number;
  /** Optional performer image version/tag; omit to use the build's default. */
  version?: string;
  /** Optional Gerrit patch-set ref to fetch and checkout in transactions-fit-performer before build/run. */
  gerritRef?: string;
  /**
   * What to do if the performer port is already in use when the iteration's
   * setup-performer step runs: `fail`, `restart` (stop what's there and bring up
   * a fresh performer — the default), or `reuse` (assume a performer is already
   * running and test against it). Omitted means {@link DEFAULT_PORT_IN_USE_POLICY}.
   */
  onPortInUse?: PortInUsePolicy;
}

/** The per-iteration setup: what to stand up for this iteration. */
export interface IterationSetup {
  performer: PerformerSetup;
}

/**
 * Which FIT test-driver tests to run: `"all"` (the default) or an explicit list
 * of fully-qualified test class names, e.g. com.couchbase.StandardTest.
 */
export type DefinitionTests = "all" | string[];

/** The runtime section of an iteration: what to do once setup is up. */
export interface RuntimeSection {
  tests: DefinitionTests;
  /**
   * Optional Maven test groups to exclude (mapped to -DexcludedGroups). When
   * omitted the run uses the standard CI exclusions.
   */
  excludedGroups?: string[];
}

/** One FIT functional performer + runtime pass. */
export interface FunctionalIteration {
  type: "functional";
  /** FITConfiguration artifact-piece layered into this iteration's run config. */
  fitConfig?: FitConfigPiece;
  setup: IterationSetup;
  runtime: RuntimeSection;
}

/** A fully-parsed, validated fit definition file. */
export interface FitDefinition {
  version: number;
  type: typeof FIT_DEFINITION_TYPE;
  /** Shared setup (the cluster). Optional while cluster setup is being designed. */
  setup?: SharedSetup;
  iterations: FunctionalIteration[];
}
