import type { PieceData } from "../../../util/non-fit/config-pieces.js";

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
    "default-deployer": "docker",
  };
}

/**
 * A cbdinocluster config for situational FIT/SIT environments: docker +
 * AWS cloud deployer, on a dedicated `fit` network.
 *
 * The FIT test-driver always allocates clusters using cbdinocluster with the
 * cloud (AWS) deployer — it hard-codes `Deployer: cloud` in the definition it
 * passes to `cbdinocluster allocate`. Enabling the aws section here makes that
 * deployer available. AWS credentials are forwarded to the instance separately
 * as environment variables.
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
      region: "eu-west-1",
    },
    "default-deployer": "docker",
  };
}
