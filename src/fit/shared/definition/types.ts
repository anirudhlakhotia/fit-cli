/**
 * The shape of a `fit` YAML definition file.
 */
import type { SdkValue } from "../../../util/sdk/sdks.js";
import type { PortInUsePolicy } from "../../performers/util/performer-port.js";
import type { CbdinoclusterDef } from "../../../cluster/cluster-create/build-cluster-def.js";
import type { ClusterExistsPolicy } from "../../../cluster/cluster-create/cluster-exists-policy.js";
import type { PieceData } from "../../../util/non-fit/config-pieces.js";

export const FIT_DEFINITION_TYPE = "fit";
export const CURRENT_FIT_DEFINITION_VERSION = 1;
export const FIT_RUN_TYPES = ["functional", "situational"] as const;

export type FitRunType = (typeof FIT_RUN_TYPES)[number];
export type FitConfigPiece = PieceData;
export type ClusterTls = null | { insecure: true } | { certPath: string };

export interface ConnectionClusterSetup {
  connectionString: string;
  username: string;
  password: string;
  tls?: ClusterTls;
}

export type UseExistingClusterSetup = Record<string, never>;

/**
 * How to prepare `~/.cbdinocluster` on the box before allocating.
 *
 * The docker/situational path carries an editable `args` string — the arguments
 * passed to `cbdinocluster init` (e.g. `--auto --disable-k8s --docker-network fit`)
 * so the box self-installs its config. fit-cli appends the GitHub credentials at
 * runtime (kept out of the definition file). `configPatch` (args path only) is
 * merged onto `~/.cbdinocluster` after init runs, for config `cbdinocluster init`
 * can't express via flags — e.g. situational's `capella`/`aws` blocks, which
 * `--auto` leaves disabled. The CNG path still carries a `config` object uploaded
 * verbatim as `~/.cbdinocluster`. Exactly one of `args`/`config` is present.
 */
export interface CbdinoclusterInitSetup {
  args?: string;
  config?: PieceData;
  configPatch?: PieceData;
}

export interface CbdinoclusterSetup {
  config: CbdinoclusterDef;
  onClusterExists?: ClusterExistsPolicy;
  deployer?: string;
}

/**
 * Per-instance setup applied once to the box before any cluster or run. The
 * cbdinocluster `init` lives here (not under each cluster) because `cbdinocluster
 * init` configures `~/.cbdinocluster` once per instance — every cluster on the
 * instance then allocates against that same config.
 */
export interface InstanceSetup {
  cbdinocluster?: { init: CbdinoclusterInitSetup };
}

export interface AwsInstanceSetup {
  instanceType?: string;
}

export type InstanceMode =
  | { aws: AwsInstanceSetup }
  | { localhost: Record<string, never> };

export interface RepoSetup {
  gerritRef?: string;
}

export interface ReposSetup {
  "transactions-fit-performer"?: RepoSetup;
}

export interface SharedSetup {
  repos?: ReposSetup;
}

export interface PerformerSetup {
  sdk: SdkValue;
  port?: number;
  version?: string;
  onPortInUse?: PortInUsePolicy;
}

/** Named test presets that expand to a set of test classes. */
export const TEST_PRESETS = ["all", "all-transactions", "all-non-transactions"] as const;
export type TestPreset = (typeof TEST_PRESETS)[number];

export interface MavenOptions {
  args?: string[];
  runDisabledTests?: boolean;
}

/**
 * Which test-driver tests a run executes. The final set is the union of every
 * preset's expansion with the explicit `classes`. Presets like
 * `all-transactions` are expanded against the listed tests at run time; an
 * `all` preset (or omitting both keys) means "run everything". `classes` lists
 * fully-qualified test class names (or `Class#method` selectors) to add on top.
 * `packages` lists Java package prefixes; each is expanded to a `pkg.*` Maven
 * wildcard selector and unioned with `classes`.
 */
export interface TestsSection {
  presets?: TestPreset[];
  packages?: string[];
  classes?: string[];
  excludedGroups?: string[];
  maven?: MavenOptions;
}

export const SITUATIONAL_DATABASE_MODES = ["hosted", "local"] as const;
export type SituationalDatabaseMode = (typeof SITUATIONAL_DATABASE_MODES)[number];

export interface SituationalDatabaseSetup {
  mode: SituationalDatabaseMode;
}

export interface SituationalSection {
  database: SituationalDatabaseSetup;
}

export interface FunctionalRun {
  type: "functional";
  fitConfig?: FitConfigPiece | string;
  tests: TestsSection;
}

export interface SituationalRun {
  type: "situational";
  fitConfig?: FitConfigPiece | string;
  situational: SituationalSection;
  tests: TestsSection;
}

export type FitRun = FunctionalRun | SituationalRun;

export interface SessionLifetime {
  performer: PerformerSetup;
  runs: FitRun[];
}

export interface ClusterLifetime {
  connection?: ConnectionClusterSetup;
  useExisting?: UseExistingClusterSetup;
  cbdinocluster?: CbdinoclusterSetup;
  clusterConfig?: string;
  sessions: SessionLifetime[];
}

export interface ClusterConfigRef {
  id: string;
  cbdinocluster?: CbdinoclusterSetup;
  connection?: ConnectionClusterSetup;
  useExisting?: UseExistingClusterSetup;
}

export interface FitConfigRef {
  id: string;
  config: FitConfigPiece;
}

export type InstanceLifetime =
  & InstanceMode
  & {
    setup?: InstanceSetup;
    clusters: ClusterLifetime[];
    clusterlessSessions?: SessionLifetime[];
  };

export interface FitDefinition {
  version: number;
  type: typeof FIT_DEFINITION_TYPE;
  description?: string;
  instances: InstanceLifetime[];
  setup?: SharedSetup;
  clusterConfigs?: ClusterConfigRef[];
  fitConfigs?: FitConfigRef[];
}
