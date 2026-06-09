/**
 * The shape of a `fit` YAML definition file.
 */
import type { SdkValue } from "../../../util/sdk/sdks.js";
import type { PortInUsePolicy } from "../../performers/util/performer-port.js";
import type { CbdinoclusterDef } from "../../cluster/cluster-create/build-cluster-def.js";
import type { ClusterExistsPolicy } from "../../cluster/cluster-create/cluster-exists-policy.js";
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

export interface CbdinoclusterInitSetup {
  config: PieceData;
}

export interface CbdinoclusterSetup {
  init?: CbdinoclusterInitSetup;
  config: CbdinoclusterDef;
  onClusterExists?: ClusterExistsPolicy;
  deployer?: string;
}

export interface AwsInstanceSetup {
  instanceType?: string;
  region?: string;
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

export type DefinitionTests = "all" | string[];

export interface MavenOptions {
  args?: string[];
  runDisabledTests?: boolean;
}

export interface TestsSection {
  run: DefinitionTests;
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
  fitConfig?: FitConfigPiece;
  tests: TestsSection;
}

export interface SituationalRun {
  type: "situational";
  fitConfig?: FitConfigPiece;
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
  fitConfig?: FitConfigPiece;
  sessions: SessionLifetime[];
}

export type InstanceLifetime =
  & InstanceMode
  & {
    clusters: ClusterLifetime[];
    cbdinocluster?: { init: CbdinoclusterInitSetup };
    clusterlessSessions?: SessionLifetime[];
  };

export interface FitDefinition {
  version: number;
  type: typeof FIT_DEFINITION_TYPE;
  instances: InstanceLifetime[];
  setup?: SharedSetup;
}
