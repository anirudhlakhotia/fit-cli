import type { PieceData } from "../../util/non-fit/config-pieces.js";
import { AWS_REGION } from "../../cloud/util/aws/aws-target.js";

/** The docker network clean FIT environments allocate their clusters on. */
export const DEFAULT_CBDINOCLUSTER_DOCKER_NETWORK = "fit";

/**
 * The `cbdinocluster init` flags shared by every clean remote FIT environment:
 * docker-only, on a dedicated `fit` network, with cloud/k8s/dns disabled. The
 * `capella` choice differs by purpose (see {@link defaultCbdinoclusterInitArgs}
 * vs {@link situationalCbdinoclusterInitArgs}), so it's not baked in here.
 *
 * GitHub is intentionally left unmentioned — fit-cli appends
 * `--github-user/--github-token` when it has credentials, or `--disable-github`
 * when it doesn't, rather than baking either choice into the definition.
 */
function baseCbdinoclusterInitArgs(dockerNetwork: string, disableCapella: boolean): string {
  return [
    "--auto",
    "--disable-aws",
    "--disable-azure",
    ...(disableCapella ? ["--disable-capella"] : []),
    "--disable-gcp",
    "--disable-k8s",
    "--disable-dns",
    `--docker-network ${dockerNetwork}`,
  ].join(" ");
}

/**
 * The default `cbdinocluster init` arguments for a clean remote FIT environment:
 * docker-only, on a dedicated `fit` network, with everything else (Capella
 * included) disabled. This is the editable string carried in the definition
 * file's `cbdinocluster.init.args`; fit-cli runs `cbdinocluster init <args>` on
 * the box and appends the GitHub credentials at runtime (so they stay out of the
 * file).
 */
export function defaultCbdinoclusterInitArgs(
  dockerNetwork: string = DEFAULT_CBDINOCLUSTER_DOCKER_NETWORK,
): string {
  return baseCbdinoclusterInitArgs(dockerNetwork, true);
}

/**
 * Like {@link defaultCbdinoclusterInitArgs} but leaves Capella *enabled* so that
 * `cbdinocluster init --auto` populates the `capella` block from the `CAPELLA_*`
 * environment variables fit-cli forwards to the box (see
 * `uploadRemoteCapellaConfig` / cbdinocluster's `cmd/init.go`, which reads
 * `CAPELLA_ENDPOINT/USER/PASS/OID`). With a
 * `CAPELLA_USER` present, `--auto` enables and fills in Capella; without one it
 * leaves Capella disabled. AWS stays disabled here — the config patch flips
 * `aws.enabled` on afterwards (the cloud deployer needs both).
 */
export function situationalCbdinoclusterInitArgs(
  dockerNetwork: string = DEFAULT_CBDINOCLUSTER_DOCKER_NETWORK,
): string {
  return baseCbdinoclusterInitArgs(dockerNetwork, false);
}

/**
 * A conservative cbdinocluster config for clean remote FIT environments:
 * docker-only, on a dedicated `fit` network, with the rest disabled unless the
 * user edits the definition.
 *
 * Still used by the CNG path (which uploads a `~/.cbdinocluster` config and adds
 * a `k8s` block) — the docker path now uses {@link defaultCbdinoclusterInitArgs}.
 */
export function defaultCbdinoclusterInitConfig(): PieceData {
  return {
    version: 6,
    docker: {
      enabled: true,
      network: DEFAULT_CBDINOCLUSTER_DOCKER_NETWORK,
      host: "unix:///var/run/docker.sock"
    },
  };
}

/**
 * A cbdinocluster config for situational FIT/SIT environments: docker + the
 * cloud (Capella) deployer, on a dedicated `fit` network.
 *
 * The FIT test-driver always allocates clusters using cbdinocluster with the
 * cloud deployer — it hard-codes `Deployer: cloud` in the definition it passes
 * to `cbdinocluster allocate`. In cbdinocluster the `cloud` deployer is the
 * Capella deployer, and it only registers when the `capella` section is
 * enabled (see cmd/cmdhelper.go: getCloudDeployer returns nil unless
 * `config.Capella.Enabled`). The `aws` section is NOT a deployer of its own —
 * it only tells the cloud deployer where to provision — so enabling it alone
 * leaves `Deployer: cloud` with no deployer and cbdinocluster fatals with
 * "you have no deployers configured".
 *
 * The Capella block itself is laid down by `cbdinocluster init --auto` from the
 * forwarded `CAPELLA_*` env (see {@link situationalCbdinoclusterInitArgs}); this
 * only adds the `aws.enabled` bit that init can't set without AWS credentials at
 * init time.
 */
export function defaultSituationalCbdinoclusterInitConfig(): PieceData {
  return {
    version: 6,
    docker: {
      enabled: true,
      network: "fit",
      host: "unix:///var/run/docker.sock",
    },
    ...situationalCbdinoclusterConfigPatch(),
  };
}

/**
 * The `aws` block situational (FIT/SIT) runs need but `cbdinocluster init`
 * doesn't lay down on its own: the cloud (Capella) deployer only registers when
 * *both* `capella` and `aws` are enabled, but enabling `aws` at init time would
 * make init load AWS credentials it doesn't have yet. fit-cli runs
 * `cbdinocluster init` (which enables `capella` from the forwarded `CAPELLA_*`
 * env — see {@link situationalCbdinoclusterInitArgs}) and then shallow-merges
 * this patch on top of the resulting `~/.cbdinocluster` (see
 * `mergeRemoteCbdinoclusterConfig`).
 *
 * The region must be set alongside `enabled` — without it, `cbdinocluster
 * cleanup` attempts to enumerate VPC endpoints and fails with "Missing Region"
 * even when `enablePrivateEndpoint` is false and nothing was created.
 *
 * Note: this must NOT include a `capella` block — the merge is shallow at the
 * top level, so any `capella` key here would replace the one init populated from
 * the environment.
 */
export function situationalCbdinoclusterConfigPatch(): PieceData {
  return {
    aws: {
      enabled: "true",
      region: AWS_REGION,
    },
  };
}
