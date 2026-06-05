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
      network: "fit"
    }
  };
}
