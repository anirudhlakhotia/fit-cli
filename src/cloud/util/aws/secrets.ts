/**
 * Read JSON secrets from AWS Secrets Manager using the ambient AWS credential
 * chain (env vars, SSO, shared profile, or CI OIDC) — the same credentials
 * fit-cli already needs to create instances. This is how per-environment Capella
 * and results-DB credentials are resolved at run time, so CI and laptops resolve
 * identically (see environments.json5 / resolveCapellaConfig / resolveResultsDbCredentials).
 */
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { AWS_REGION } from "./aws-target.js";

/** Thrown when a secret can't be read (missing, access denied, or malformed). */
export class AwsSecretError extends Error {}

let client: SecretsManagerClient | undefined;
function secretsClient(): SecretsManagerClient {
  client ??= new SecretsManagerClient({ region: AWS_REGION });
  return client;
}

const cache = new Map<string, Record<string, string>>();

/**
 * Fetch a JSON secret by id or ARN and parse it as a flat string map. Cached per
 * id for the process. Throws {@link AwsSecretError} with an actionable message on
 * a missing secret, denied access, or non-JSON value.
 */
export async function getJsonSecret(secretId: string): Promise<Record<string, string>> {
  const hit = cache.get(secretId);
  if (hit) return hit;

  let value: string | undefined;
  try {
    const out = await secretsClient().send(new GetSecretValueCommand({ SecretId: secretId }));
    value = out.SecretString;
  } catch (err) {
    throw new AwsSecretError(
      `Could not read AWS secret "${secretId}" in ${AWS_REGION}: ${(err as Error).message}\n` +
        `  Make sure your AWS credentials are active and have secretsmanager:GetSecretValue on this secret.`,
    );
  }
  if (!value) throw new AwsSecretError(`AWS secret "${secretId}" has no string value.`);

  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(value) as Record<string, string>;
  } catch {
    throw new AwsSecretError(`AWS secret "${secretId}" is not valid JSON (expected an object of fields).`);
  }
  cache.set(secretId, parsed);
  return parsed;
}
