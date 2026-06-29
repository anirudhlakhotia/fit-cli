/**
 * aws-target — the single, fixed AWS region and network fit-cli operates in.
 *
 * fit-cli deliberately targets exactly one region and one VPC; none of these are
 * configurable (no CLI flag, env var, config field or definition field). This keeps
 * runs reproducible and matches the infrastructure provisioned by
 * sdkqe-github-runners-tf (terraform/aws/runners/main.tf), which only exists in us-west-2.
 */

/** The single AWS region fit-cli operates in. */
export const AWS_REGION = "us-west-2";

/**
 * cbqerunners-vpc — the only VPC in us-west-2 in this account (there is NO default VPC,
 * which is why a VPC must be named explicitly). Created by sdkqe-github-runners-tf.
 * If terraform recreates the VPC the ids below change and must be updated.
 */
export const AWS_VPC_ID = "vpc-0ea6734517a89f0f9";

/**
 * cbqerunners-vpc-public-us-west-2b — a public subnet (MapPublicIpOnLaunch=true) of the
 * VPC above, so launched instances get a public IP we can SSH to.
 */
export const AWS_SUBNET_ID = "subnet-066bf3b21c106d96b";

/**
 * Default security group of cbqerunners-vpc. Opened by sdkqe-github-runners-tf for
 * intra-VPC TCP traffic (0–65535) so boxes in the VPC can reach the Capella private
 * endpoint (which also lands in this SG). Attached alongside the fit-cli SSH SG on
 * instances that have `privateEndpoint` enabled.
 * grahamp: note fit-cli doesn't use sdkqe-github-runners-tf directly - it's just reusing
 * the concepts and locations.
 */
export const AWS_VPC_DEFAULT_SG_ID = "sg-0dc1aadee3ec8f615";

/**
 * IAM instance profile (created by sdkqe-github-runners-tf via the github-aws-runners
 * module, prefix = cbqerunners) that grants the box CreateVpcEndpoint + Route53
 * permissions so the FIT test can wire up the Capella private endpoint at runtime.
 * The profile must already exist — apply sdkqe-github-runners-tf to create it.
 */
export const AWS_PRIVATE_ENDPOINT_INSTANCE_PROFILE = "cbqerunners-runner";
