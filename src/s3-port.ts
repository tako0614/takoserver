/**
 * Standard S3 access, separated from ObjectBucket lifecycle.
 *
 * Takoform creates and deletes the bucket. This port hands a caller ordinary
 * short-lived S3 credentials for a bucket that already exists. Provider
 * account ids, native ids, and parent credentials never cross the public API.
 */

export type S3Access = "read-only" | "read-write";

export interface S3CredentialIssue {
  readonly organizationId: string;
  readonly resourceUid: string;
  readonly deploymentId: string;
  readonly offeringId: string;
  readonly providerPackRef: string;
  readonly providerInstallationRef: string;
  /** Provider-private identity recorded on the active Deployment. */
  readonly nativeId: string;
  readonly access: S3Access;
  readonly ttlSeconds: number;
}

export interface S3CredentialSet {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiresAt: string;
}

export type S3CredentialAuthority = Omit<S3CredentialIssue, "ttlSeconds">;

export interface S3CredentialTtlLimits {
  readonly minimumSeconds: number;
  readonly maximumSeconds: number;
  readonly defaultSeconds: number;
}

export interface S3CredentialIssuer {
  /** Returns null when this issuer does not own the exact active Deployment. */
  limits(input: S3CredentialAuthority): S3CredentialTtlLimits | null;
  issue(input: S3CredentialIssue): Promise<S3CredentialSet>;
}

export class S3CredentialError extends Error {
  constructor(readonly code: "backend_unavailable" | "upstream_invalid") {
    super(code);
    this.name = "S3CredentialError";
  }
}

/**
 * Recheck an adapter response before secrets leave the process.
 *
 * A malformed upstream envelope is not reflected to the caller and credentials
 * may never outlive the authority requested from Takoserver.
 */
export function validateS3CredentialSet(
  value: S3CredentialSet,
  input: S3CredentialIssue,
  now: Date,
): S3CredentialSet {
  let endpoint: URL;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    throw new S3CredentialError("upstream_invalid");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new S3CredentialError("upstream_invalid");
  }

  const expiresAt = new Date(value.expiresAt);
  const maximum = now.getTime() + input.ttlSeconds * 1_000 + 5_000;
  if (
    Number.isNaN(expiresAt.getTime()) ||
    expiresAt.getTime() <= now.getTime() ||
    expiresAt.getTime() > maximum
  ) {
    throw new S3CredentialError("upstream_invalid");
  }

  bounded(value.region, 1, 64);
  bounded(value.bucket, 1, 255);
  bounded(value.accessKeyId, 1, 512);
  bounded(value.secretAccessKey, 1, 4_096);
  bounded(value.sessionToken, 1, 16_384);
  return structuredClone(value);
}

function bounded(value: string, minimum: number, maximum: number): void {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    hasControlCharacter(value)
  ) {
    throw new S3CredentialError("upstream_invalid");
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
