import type { Sdk } from "../../../util/sdk/sdks.js";

export const GHCR_REGISTRY = "ghcr.io";
export const FIT_PERFORMER_IMAGE_OWNER = "couchbase";
export const JVM_PERFORMER_IMAGE_OWNER = "couchbase";
export const JVM_PERFORMER_PACKAGES_REPOSITORY = "couchbase-jvm-clients";
export const DEFAULT_PERFORMER_IMAGE_TAG = "main";
export const JVM_DEFAULT_PERFORMER_IMAGE_TAG = "main";

/** The default Docker tag used for a given SDK's prebuilt GHCR image. */
export function sdkDefaultPerformerTag(sdk: Sdk): string {
  return sdk.jvm ? JVM_DEFAULT_PERFORMER_IMAGE_TAG : DEFAULT_PERFORMER_IMAGE_TAG;
}

const JVM_SDK_VALUES = new Set(["java", "kotlin", "scala"]);

/** The GHCR package name that holds the prebuilt performer image for this SDK. */
export function performerPackageName(sdk: Sdk): string {
  return `${sdk.value}-fit-performer`;
}

/** The GitHub Packages URL for this SDK's prebuilt performer image. */
export function performerPackageUrl(sdk: Sdk): string {
  const pkg = performerPackageName(sdk);
  if (JVM_SDK_VALUES.has(sdk.value)) {
    return `https://github.com/${JVM_PERFORMER_IMAGE_OWNER}/${JVM_PERFORMER_PACKAGES_REPOSITORY}/pkgs/container/${pkg}`;
  }
  return `https://github.com/orgs/${FIT_PERFORMER_IMAGE_OWNER}/packages/container/package/${pkg}`;
}

/** Normalize a user-supplied tag; blank or the SDK's default tag means "use default". */
export function normalizePerformerVersion(version?: string, sdk?: Sdk): string | undefined {
  const trimmed = version?.trim();
  const defaultTag = sdk ? sdkDefaultPerformerTag(sdk) : DEFAULT_PERFORMER_IMAGE_TAG;
  return !trimmed || trimmed === defaultTag ? undefined : trimmed;
}

/** The Docker tag used for this performer image. */
function performerImageTag(sdk: Sdk, version?: string): string {
  return normalizePerformerVersion(version, sdk) ?? sdkDefaultPerformerTag(sdk);
}

/** The fully-qualified Docker image reference for this SDK's performer. */
export function performerImageName(sdk: Sdk, version?: string): string {
  const owner = JVM_SDK_VALUES.has(sdk.value) ? JVM_PERFORMER_IMAGE_OWNER : FIT_PERFORMER_IMAGE_OWNER;
  return `${GHCR_REGISTRY}/${owner}/${performerPackageName(sdk)}:${performerImageTag(sdk, version)}`;
}

/** Validate a manually-entered performer tag. */
export function validatePerformerVersion(value: string): true | string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Enter a tag like main or 4.2.0.";
  }
  if (/\s/.test(trimmed)) {
    return "Docker tags cannot contain whitespace.";
  }
  if (trimmed.includes("/") || trimmed.includes(":") || trimmed.includes("@")) {
    return "Enter only the image tag, not a full image reference.";
  }
  return true;
}
