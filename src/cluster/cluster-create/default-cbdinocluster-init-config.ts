import type { PieceData } from "../../util/non-fit/config-pieces.js";

/**
 * A conservative cbdinocluster config for clean remote FIT environments:
 * docker-only, on a dedicated `fit` network, with the rest disabled unless the
 * user edits the definition.
 */
export function defaultCbdinoclusterInitConfig(): PieceData {
  return {
    version: 6,
    docker: {
      enabled: true,
      network: "fit",
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
 * The values below target the internal Capella control-plane mock (the
 * standard `localhost:8080` simulator with its well-known test override
 * tokens); point `endpoint`/`organization-id` at a real Capella and supply
 * real credentials for non-mock runs. AWS credentials are forwarded to the
 * instance separately as environment variables.
 */
export function defaultSituationalCbdinoclusterInitConfig(): PieceData {
  return {
    version: 6,
    docker: {
      enabled: true,
      network: "fit",
      host: "unix:///var/run/docker.sock",
    },
    aws: {
      enabled: "true",
      // todo seeing if we can remove these
      // region: "eu-west-1",
    },
    capella: {
      enabled: "true",
      // todo seeing if we can remove these
      // endpoint: "http://localhost:8080",
      // "override-token": "the-secret-test-override-key",
      // "internal-support-token": "the-secret-token-for-internal-support",
      // "default-aws-region": "us-east-1",
      "default-cloud": "aws",
    },
  };
}
