/**
 * aws-clients — shared AWS SDK v3 client instances. Credentials are resolved
 * lazily on the first API call, so prepareAwsCli() just needs to set env vars
 * (e.g. AWS_PROFILE) before any call is made — client instantiation is safe
 * to do at module load time.
 */
import { EC2Client } from "@aws-sdk/client-ec2";
import { IAMClient } from "@aws-sdk/client-iam";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { S3Client } from "@aws-sdk/client-s3";
import { AWS_REGION } from "./aws-target.js";

export const ec2Client = new EC2Client({ region: AWS_REGION });
export const iamClient = new IAMClient({ region: AWS_REGION });
export const ssmClient = new SSMClient({ region: AWS_REGION });
export const stsClient = new STSClient({ region: AWS_REGION });
// 5-minute request timeout to accommodate large artifact uploads.
export const s3Client = new S3Client({ region: AWS_REGION, requestHandler: { requestTimeout: 5 * 60 * 1000 } });
