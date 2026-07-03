/**
 * aws-target — re-exports the single, fixed AWS region and network fit-cli operates in,
 * sourced from environments.json5 (defaults.aws). Values are loaded once at module init.
 *
 * All callers import named constants as before; the values come from config rather than
 * being hardcoded. To update a VPC/subnet after a terraform recreate, edit environments.json5.
 */
import { loadEnvironments } from "../../../fit/util/environments.js";

const { region, vpcId, subnetId } = loadEnvironments().defaults.aws;

export const AWS_REGION = region;
export const AWS_VPC_ID = vpcId;
export const AWS_SUBNET_ID = subnetId;
