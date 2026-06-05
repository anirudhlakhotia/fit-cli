import type { Sdk } from "../../../util/sdk/sdks.js";

export const GHCR_REGISTRY = "ghcr.io";
export const FIT_PERFORMER_IMAGE_OWNER = "couchbaselabs";
export const FIT_PERFORMER_PACKAGES_REPOSITORY = "transactions-fit-performer";
export const JVM_PERFORMER_IMAGE_OWNER = "couchbase";
export const JVM_PERFORMER_PACKAGES_REPOSITORY = "couchbase-jvm-clients";
export const DEFAULT_PERFORMER_IMAGE_TAG = "main";

const JVM_SDK_VALUES = new Set(["java", "kotlin", "scala"]);

interface PerformerPackageProject {
  owner: string;
  repository: string;
}

/** The GitHub project that publishes this SDK's performer image package. */
export function performerPackageProject(sdk: Sdk): PerformerPackageProject {
  return JVM_SDK_VALUES.has(sdk.value)
    ? { owner: JVM_PERFORMER_IMAGE_OWNER, repository: JVM_PERFORMER_PACKAGES_REPOSITORY }
    : { owner: FIT_PERFORMER_IMAGE_OWNER, repository: FIT_PERFORMER_PACKAGES_REPOSITORY };
}

/** The GHCR package name that holds the prebuilt performer image for this SDK. */
export function performerPackageName(sdk: Sdk): string {
  return `${sdk.value}-fit-performer`;
}

/** The GitHub Packages URL for this SDK's prebuilt performer image. */
export function performerPackageUrl(sdk: Sdk): string {
  const project = performerPackageProject(sdk);
  return (
    `https://github.com/${project.owner}/` +
    `${project.repository}/pkgs/container/${performerPackageName(sdk)}`
  );
}

/** Normalize a user-supplied tag; blank or `main` means the default tag. */
export function normalizePerformerVersion(version?: string): string | undefined {
  const trimmed = version?.trim();
  return !trimmed || trimmed === DEFAULT_PERFORMER_IMAGE_TAG ? undefined : trimmed;
}

/** The Docker tag used for this performer image. */
export function performerImageTag(version?: string): string {
  return normalizePerformerVersion(version) ?? DEFAULT_PERFORMER_IMAGE_TAG;
}

/** The fully-qualified Docker image reference for this SDK's performer. */
export function performerImageName(sdk: Sdk, version?: string): string {
  const project = performerPackageProject(sdk);
  return `${GHCR_REGISTRY}/${project.owner}/${performerPackageName(sdk)}:${performerImageTag(version)}`;
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
