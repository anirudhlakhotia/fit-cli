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
function baseCbdinoclusterInitArgs(dockerNetwork: string, disableCapella: boolean, awsRegion?: string): string {
  return [
    "--auto",
    ...(awsRegion ? [`--aws-region ${awsRegion}`] : ["--disable-aws"]),
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
 * `CAPELLA_ENDPOINT/USER/PASS/OID`). With a `CAPELLA_USER` present, `--auto`
 * enables and fills in Capella; without one it leaves Capella disabled.
 *
 * AWS credentials are uploaded before init runs (see `uploadRemoteAwsCredentials`
 * in `run-from-definition.ts`), so `--aws-region` here lets `--auto` enable the
 * aws block directly rather than needing a post-init config patch.
 */
export function situationalCbdinoclusterInitArgs(
  dockerNetwork: string = DEFAULT_CBDINOCLUSTER_DOCKER_NETWORK,
): string {
  return baseCbdinoclusterInitArgs(dockerNetwork, false, AWS_REGION);
}

