import { isSha256Digest } from "./json.ts";

/** Semantic identity of the executable Form payload independent of its outer Worker. */
export interface PublicFormImplementationIdentity {
  readonly implementationPayloadDigest: `sha256:${string}`;
  readonly capabilityDigest: `sha256:${string}`;
  readonly implementationDigest: `sha256:${string}`;
}

/** Semantic Form identity bound to the exact published outer Worker artifact. */
export interface PublicWorkerImplementationIdentity extends PublicFormImplementationIdentity {
  readonly workerArtifactDigest: `sha256:${string}`;
}

export interface PublicHostIdentity {
  readonly kind: "takoserver.public-host-identity@v2";
  readonly hostId: string;
  readonly workerVersionId: string;
  readonly workerArtifactDigest: `sha256:${string}`;
  readonly implementationPayloadDigest: `sha256:${string}`;
  readonly capabilityDigest: `sha256:${string}`;
  readonly implementationDigest: `sha256:${string}`;
}

export interface PublicHostIdentityRpc {
  identity(): Promise<PublicHostIdentity>;
}

export function publicHostIdentity(input: {
  readonly hostId: unknown;
  readonly workerVersionId: unknown;
  readonly workerArtifactDigest: unknown;
  readonly implementationPayloadDigest: unknown;
  readonly capabilityDigest: unknown;
  readonly implementationDigest: unknown;
}): PublicHostIdentity {
  if (
    typeof input.hostId !== "string" ||
    input.hostId.length === 0 ||
    input.hostId.length > 255 ||
    typeof input.workerVersionId !== "string" ||
    !workerVersionId(input.workerVersionId) ||
    !isSha256Digest(input.workerArtifactDigest) ||
    !isSha256Digest(input.implementationPayloadDigest) ||
    !isSha256Digest(input.capabilityDigest) ||
    !isSha256Digest(input.implementationDigest)
  ) {
    throw new TypeError("public Host identity is invalid");
  }
  return {
    kind: "takoserver.public-host-identity@v2",
    hostId: input.hostId,
    workerVersionId: input.workerVersionId,
    workerArtifactDigest: input.workerArtifactDigest,
    implementationPayloadDigest: input.implementationPayloadDigest,
    capabilityDigest: input.capabilityDigest,
    implementationDigest: input.implementationDigest,
  };
}

export function isPublicHostIdentity(value: unknown): value is PublicHostIdentity {
  return (
    isRecord(value) &&
    exactKeys(value, [
      "hostId",
      "capabilityDigest",
      "implementationDigest",
      "implementationPayloadDigest",
      "kind",
      "workerArtifactDigest",
      "workerVersionId",
    ]) &&
    value.kind === "takoserver.public-host-identity@v2" &&
    typeof value.hostId === "string" &&
    value.hostId.length > 0 &&
    value.hostId.length <= 255 &&
    typeof value.workerVersionId === "string" &&
    workerVersionId(value.workerVersionId) &&
    isSha256Digest(value.workerArtifactDigest) &&
    isSha256Digest(value.implementationPayloadDigest) &&
    isSha256Digest(value.capabilityDigest) &&
    isSha256Digest(value.implementationDigest)
  );
}

function workerVersionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
