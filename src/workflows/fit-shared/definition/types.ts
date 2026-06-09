/**
 * The shape of a `fit` YAML definition file — a repeatable, checked-in
 * description of one or more FIT cycles.
 */
import type { SdkValue } from "../../../util/sdk/sdks.js";
import type { PortInUsePolicy } from "../../performers/util/performer-port.js";
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

/** The currently supported cycle kinds within a fit definition. */
export const FIT_CYCLE_TYPES = ["functional", "situational"] as const;

export type FitCycleType = (typeof FIT_CYCLE_TYPES)[number];

/** One fitConfig artifact-piece contributed by a definition iteration. */
export type FitConfigPiece = PieceData;

/** TLS config for a cycle-level cluster connection. */
export type ClusterTls = null | { insecure: true } | { certPath: string };

/** Connection details for an already-running cluster. */
export interface ConnectionClusterSetup {
  connectionString: string;
  username: string;
  password: string;
  tls?: ClusterTls;
}

/** Marker that this cycle should use a cluster already running elsewhere. */
export type UseExistingClusterSetup = Record<string, never>;

/** A full cbdinocluster config file to upload before cluster setup runs. */
export interface CbdinoclusterInitSetup {
  /** Uploaded verbatim as ~/.cbdinocluster in clean environments. */
  config: PieceData;
}

/** A cbdinocluster to allocate for a functional cycle. */
export interface CbdinoclusterSetup {
  init?: CbdinoclusterInitSetup;
  config: CbdinoclusterDef;
  onClusterExists?: ClusterExistsPolicy;
  deployer?: string;
}

/**
 * The cluster a functional cycle tests against. Provide exactly one of:
 * - `connection` — use these connection details for an already-running cluster,
 * - `useExisting` — test against an already-running cluster, or
 * - `cbdinocluster` — allocate a fresh cluster with cbdinocluster for the cycle.
 */
export interface ClusterSetup {
  connection?: ConnectionClusterSetup;
  useExisting?: UseExistingClusterSetup;
  cbdinocluster?: CbdinoclusterSetup;
}

/** AWS-specific knobs for a cycle that runs on a clean EC2 instance. */
export interface AwsInstanceSetup {
  instanceType?: string;
  region?: string;
}

/**
 * Where a cycle's iterations execute. Provide exactly one of:
 * - `aws` — provision a clean EC2 instance for the cycle, or
 * - `localhost` — run directly on this machine.
 */
export type CycleInstanceSetup =
  | { aws: AwsInstanceSetup }
  | { localhost: Record<string, never> };

/** The cycle-level `execution` block: where the cycle runs. */
export interface CycleExecutionSetup {
  instance: CycleInstanceSetup;
}

/** Shared setup applied once for the whole definition. */
export interface RepoSetup {
  gerritRef?: string;
}

/** Top-level repo overrides applied before cycles run. */
export interface ReposSetup {
  "transactions-fit-performer"?: RepoSetup;
}

/** The shared, top-level setup applied once for the whole definition. */
export interface SharedSetup {
  repos?: ReposSetup;
}

/** Which performer to build and run for one iteration. */
export interface PerformerSetup {
  sdk: SdkValue;
  port?: number;
  version?: string;
  onPortInUse?: PortInUsePolicy;
}

/** The per-iteration setup. */
export interface IterationSetup {
  performer: PerformerSetup;
}

/**
 * Which FIT test-driver tests to run: `"all"` (the default) or an explicit list
 * of fully-qualified test class names.
 */
export type DefinitionTests = "all" | string[];

/** Maven-specific overrides for a test run. */
export interface MavenOptions {
  /** Extra `-D` system properties appended verbatim to the `./mvnw` command. */
  args?: string[];
  /** Deactivate JUnit 5's DisabledCondition, overriding `@Disabled` on tests. */
  runDisabledTests?: boolean;
}

/** The runtime section of an iteration: what to do once setup is up. */
export interface RuntimeSection {
  tests: DefinitionTests;
  excludedGroups?: string[];
  maven?: MavenOptions;
}

/** One FIT functional performer + runtime pass. */
export interface FunctionalIteration {
  fitConfig?: FitConfigPiece;
  setup: IterationSetup;
  runtime: RuntimeSection;
}

/** Where situational timeseries results are stored. */
export const SITUATIONAL_DATABASE_MODES = ["hosted", "local"] as const;

export type SituationalDatabaseMode = (typeof SITUATIONAL_DATABASE_MODES)[number];

/** Where a situational iteration's results land. */
export interface SituationalDatabaseSetup {
  mode: SituationalDatabaseMode;
}

/** The situational-specific section of an iteration. */
export interface SituationalSection {
  database: SituationalDatabaseSetup;
}

/** One FIT situational performer + runtime pass. */
export interface SituationalIteration {
  fitConfig?: FitConfigPiece;
  setup: IterationSetup;
  situational: SituationalSection;
  runtime: RuntimeSection;
}

/** A functional cycle owns one cluster lifetime and one or more iterations. */
export interface FunctionalCycle {
  type: "functional";
  /** Where this cycle runs. Absent means localhost. */
  execution?: CycleExecutionSetup;
  cluster: ClusterSetup;
  iterations: FunctionalIteration[];
}

/** A situational cycle owns no shared cluster and one or more iterations. */
export interface SituationalCycle {
  type: "situational";
  /** Where this cycle runs. Absent means localhost. */
  execution?: CycleExecutionSetup;
  /**
   * Configures cbdinocluster on the execution target before the test-driver
   * runs. Required so the situational test-driver can call cbdinocluster without
   * having a pre-existing `~/.cbdinocluster` on the target.
   */
  cbdinocluster: { init: CbdinoclusterInitSetup };
  iterations: SituationalIteration[];
}

/** One cycle within a fit definition. */
export type FitCycle = FunctionalCycle | SituationalCycle;

/** A fully-parsed, validated fit definition file. */
export interface FitDefinition {
  version: number;
  type: typeof FIT_DEFINITION_TYPE;
  cycles: FitCycle[];
  setup?: SharedSetup;
}
