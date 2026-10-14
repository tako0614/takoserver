/** Host-supply image admission metadata; this is not a public Form definition. */
export type ContainerImagePlatform = {
  readonly os: string;
  readonly architecture: string;
  readonly variant?: string;
};

export type ContainerImageManifest = {
  readonly kind: "image";
  readonly digest: string;
  readonly platform: ContainerImagePlatform;
  /** Total selected image payload, verified by the registry adapter. */
  readonly sizeBytes: number | null;
};

export type ContainerImageManifestList = {
  readonly kind: "list";
  readonly digest: string;
  readonly manifests: readonly ContainerImageManifest[];
};

export type ContainerImageAdmissionInput = {
  readonly imageRef: string;
  readonly platform: ContainerImagePlatform;
  readonly maxImageSizeBytes?: number;
  readonly registry: {
    readonly visibility: "public" | "private";
    /** Host-verified authorization metadata only; never registry credentials. */
    readonly auth?: { readonly present: boolean; readonly authorized: boolean };
  };
  readonly manifest: ContainerImageManifest | ContainerImageManifestList;
};

export type ContainerImageAdmissionRejectionReason =
  | "digest_pin_required"
  | "registry_auth_required"
  | "registry_auth_failed"
  | "manifest_digest_invalid"
  | "manifest_digest_mismatch"
  | "platform_mismatch"
  | "platform_ambiguous"
  | "image_size_limit_invalid"
  | "image_size_unknown"
  | "image_size_invalid"
  | "image_size_exceeded";

export type ContainerImageAdmissionResult =
  | { readonly decision: "reject"; readonly reason: ContainerImageAdmissionRejectionReason }
  | {
      readonly decision: "accept";
      readonly digest: string;
      readonly sizeBytes: number;
      readonly platform: ContainerImagePlatform;
    };

/** Decimal 2 GB, inclusive; not 2 GiB and not the sum of all index platforms. */
export const DEFAULT_CONTAINER_MAX_IMAGE_SIZE_BYTES = 2_000_000_000;

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const PINNED_REFERENCE = /^[^@\s]+@(sha256:[0-9a-fA-F]{64})$/;

function validDigest(digest: string): boolean {
  // `$` can match before a trailing newline; require the full SHA-256 length.
  return digest.length === 71 && SHA256_DIGEST.test(digest);
}

function samePlatform(left: ContainerImagePlatform, right: ContainerImagePlatform): boolean {
  return (
    left.os === right.os &&
    left.architecture === right.architecture &&
    left.variant === right.variant
  );
}

function reject(reason: ContainerImageAdmissionRejectionReason): ContainerImageAdmissionResult {
  return { decision: "reject", reason };
}

/**
 * Decides using verified Host metadata without effects or caller input mutation.
 * The owning Form parser validates its released reference/platform grammar first.
 * A registry adapter must verify manifest/layer bytes and retention separately;
 * accepting metadata does not create a retained native image receipt.
 */
export function evaluateContainerImageAdmission(
  input: ContainerImageAdmissionInput,
): ContainerImageAdmissionResult {
  const match = PINNED_REFERENCE.exec(input.imageRef);
  // Caller reference spelling may be canonicalized; OCI descriptors may not.
  const pinnedDigest = match?.[1]?.toLowerCase();
  if (!pinnedDigest || match?.[0] !== input.imageRef) return reject("digest_pin_required");

  const auth = input.registry.auth;
  if (input.registry.visibility === "private" && !auth?.present) {
    return reject("registry_auth_required");
  }
  if (auth?.present && !auth.authorized) return reject("registry_auth_failed");

  if (!validDigest(input.manifest.digest)) return reject("manifest_digest_invalid");
  if (input.manifest.digest !== pinnedDigest) return reject("manifest_digest_mismatch");

  let selected: ContainerImageManifest;
  if (input.manifest.kind === "list") {
    let candidate: ContainerImageManifest | undefined;
    for (const manifest of input.manifest.manifests) {
      if (!samePlatform(manifest.platform, input.platform)) continue;
      if (candidate) return reject("platform_ambiguous");
      candidate = manifest;
    }
    if (!candidate) return reject("platform_mismatch");
    selected = candidate;
  } else {
    selected = input.manifest;
    if (!samePlatform(selected.platform, input.platform)) return reject("platform_mismatch");
  }
  if (!validDigest(selected.digest)) return reject("manifest_digest_invalid");

  const limit = input.maxImageSizeBytes ?? DEFAULT_CONTAINER_MAX_IMAGE_SIZE_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0) return reject("image_size_limit_invalid");
  if (selected.sizeBytes === null) return reject("image_size_unknown");
  if (!Number.isSafeInteger(selected.sizeBytes) || selected.sizeBytes < 0) {
    return reject("image_size_invalid");
  }
  if (selected.sizeBytes > limit) return reject("image_size_exceeded");

  return {
    decision: "accept",
    digest: selected.digest,
    sizeBytes: selected.sizeBytes,
    platform:
      selected.platform.variant === undefined
        ? { os: selected.platform.os, architecture: selected.platform.architecture }
        : {
            os: selected.platform.os,
            architecture: selected.platform.architecture,
            variant: selected.platform.variant,
          },
  };
}
