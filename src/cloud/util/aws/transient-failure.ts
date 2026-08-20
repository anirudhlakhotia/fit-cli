/**
 * isTransientAwsFailure — is an AWS SDK failure worth retrying the whole operation
 * for? Pure inspection of the error shape, so it's unit tested directly (see
 * tests/transient-failure.test.ts).
 *
 * This is deliberately a coarser question than the SDK's own per-request retries,
 * which have already run and lost by the time a caller asks. It answers "is there
 * any point doing this again", so a misconfiguration says no and we report the
 * real cause once instead of three times.
 */

/** The bits of an AWS SDK v3 error we judge on. */
interface AwsErrorShape {
  name?: string;
  Code?: string;
  $metadata?: { httpStatusCode?: number };
}

/**
 * Credentials that lapsed part-way through a long run. Retryable despite being a
 * 4xx: the credentials provider re-assumes fit-cli-role between attempts, so the
 * next one starts with a fresh session. A multi-hour situational run outliving its
 * own credentials is a known failure mode here, not a hypothetical.
 */
const EXPIRED_CREDENTIALS = /^(ExpiredToken|ExpiredTokenException|RequestExpired|RequestExpiredException)$/;

/**
 * True when `err` looks transient: no HTTP response at all (a dropped socket or a
 * connection that never opened), a throttle, a server-side error, or expired
 * credentials. False for anything the service answered definitively — 403
 * AccessDenied and 404 NoSuchBucket will fail identically however many times we
 * try, and retrying them only buries the message that says what's wrong.
 */
export function isTransientAwsFailure(err: unknown): boolean {
  if (err === null || typeof err !== "object") {
    // Not an SDK error (a bug in our own code, most likely) — don't paper over it.
    return false;
  }
  const { name, Code, $metadata } = err as AwsErrorShape;
  if (EXPIRED_CREDENTIALS.test(name ?? "") || EXPIRED_CREDENTIALS.test(Code ?? "")) {
    return true;
  }
  const status = $metadata?.httpStatusCode;
  if (status === undefined) {
    // Never got a response. This is the "socket connection was closed unexpectedly"
    // case that motivated the whole-upload retry.
    return true;
  }
  return status === 429 || status >= 500;
}
