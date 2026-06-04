/**
 * The shape of a `fit-functional-tests` YAML definition file — the repeatable,
 * checked-in description of a FIT functional test run. Definition files are the
 * recommended way to drive top-level workflows (especially on CI): unlike replay
 * logs they're hand-editable and don't break when prompts move around.
 *
 * A file looks like:
 *
 *   version: 1
 *   type: fit-functional-tests
 *   sdk: java
 *   cluster:
 *     connectionString: couchbase://localhost
 *     username: Administrator
 *     password: password
 *     tls: null
 *   tests: all
 *
 * See examples/fit-functional-tests.yaml in the repo root for an annotated copy.
 *
 * Parsing/validation lives in parse-definition.ts; turning a parsed definition
 * into the concrete run inputs lives in resolve-definition.ts.
 */
import type { Credentials } from "../../cluster/cluster-select/ask-credentials.js";
import type { TlsConfig } from "../../cluster/cluster-select/ask-tls.js";
import type { SdkValue } from "../../../util/sdk/sdks.js";

/** The `type:` discriminator every fit-functional definition file carries. */
export const FIT_FUNCTIONAL_DEFINITION_TYPE = "fit-functional-tests";

/**
 * The current major version of the fit-functional definition format. Bump this
 * only on a breaking change, and see the "Definition files" section of the
 * README before doing so — add an upgrader in parse-definition.ts so older files
 * keep working.
 */
export const CURRENT_FIT_FUNCTIONAL_VERSION = 1;

/** The cluster a definition file points its run at (an already-running one). */
export interface DefinitionCluster extends Credentials {
  /** e.g. couchbase://localhost or couchbases://cb.<id>.cloud.couchbase.com */
  connectionString: string;
  /**
   * How the SDK should trust a couchbases:// cluster. `null` (or omitted) means
   * no TLS section — correct for couchbase:// and for production Capella.
   */
  tls: TlsConfig;
}

/**
 * Which FIT test-driver tests to run: `"all"` (the default) or an explicit list
 * of fully-qualified test class names, e.g. com.couchbase.StandardTest.
 */
export type DefinitionTests = "all" | string[];

/** A fully-parsed, validated fit-functional definition file. */
export interface FitFunctionalDefinition {
  version: number;
  type: typeof FIT_FUNCTIONAL_DEFINITION_TYPE;
  /** Which SDK to test, e.g. "java" — one of the values in SDKS. */
  sdk: SdkValue;
  /** Optional performer image version/tag; omit to use the build's default. */
  performerVersion?: string;
  cluster: DefinitionCluster;
  tests: DefinitionTests;
  /**
   * Optional Maven test groups to exclude (mapped to -DexcludedGroups). When
   * omitted the run uses the standard CI exclusions.
   */
  excludedGroups?: string[];
}
