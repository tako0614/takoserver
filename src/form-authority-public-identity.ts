import {
  isPublicHostIdentity,
  type PublicHostIdentity,
  type PublicHostIdentityRpc,
} from "./public-host-identity.ts";
import { parseFormAuthorityCapabilityManifest } from "./public-worker-implementation.ts";
import type { FormAuthorityEndpointConfiguration } from "./takoform/host-admission-endpoint.ts";

export class PublicHostIdentityUnavailableError extends Error {
  readonly code = "identity_unavailable";

  constructor() {
    super("identity_unavailable");
    this.name = "PublicHostIdentityUnavailableError";
  }
}

/** Pin-free environment shared by production and integration authority Workers. */
export interface FormAuthorityPublicIdentityWorkerEnv {
  readonly TAKOSERVER_ENVIRONMENT: string;
  readonly TAKOSERVER_FORM_AUTHORITY_HOST_ID: string;
  readonly TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST: string;
  readonly PUBLIC_HOST_IDENTITY: PublicHostIdentityRpc;
}

export function formAuthorityConfigurationFromPublicIdentity(
  env: FormAuthorityPublicIdentityWorkerEnv,
  identity: PublicHostIdentity,
): FormAuthorityEndpointConfiguration {
  const environment = env.TAKOSERVER_ENVIRONMENT;
  if (
    environment !== "integration" &&
    environment !== "rehearsal" &&
    environment !== "production"
  ) {
    throw new TypeError("Form authority Worker environment is invalid");
  }
  return {
    environment,
    hostId: identity.hostId,
    workerArtifactDigest: identity.workerArtifactDigest,
    publicWorkerVersionId: identity.workerVersionId,
    implementationPayloadDigest: identity.implementationPayloadDigest,
    implementationDigest: identity.implementationDigest,
    capabilities: parseFormAuthorityCapabilityManifest(
      env.TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST,
    ),
  };
}

export async function currentPublicHostIdentity(
  env: Pick<
    FormAuthorityPublicIdentityWorkerEnv,
    "PUBLIC_HOST_IDENTITY" | "TAKOSERVER_FORM_AUTHORITY_HOST_ID"
  >,
): Promise<PublicHostIdentity> {
  let live: unknown;
  try {
    live = await env.PUBLIC_HOST_IDENTITY.identity();
  } catch {
    throw new PublicHostIdentityUnavailableError();
  }
  if (!isPublicHostIdentity(live) || live.hostId !== env.TAKOSERVER_FORM_AUTHORITY_HOST_ID) {
    throw new PublicHostIdentityUnavailableError();
  }
  return live;
}

export function samePublicHostIdentity(
  left: PublicHostIdentity,
  right: PublicHostIdentity,
): boolean {
  return (
    left.kind === right.kind &&
    left.hostId === right.hostId &&
    left.workerVersionId === right.workerVersionId &&
    left.workerArtifactDigest === right.workerArtifactDigest &&
    left.implementationPayloadDigest === right.implementationPayloadDigest &&
    left.capabilityDigest === right.capabilityDigest &&
    left.implementationDigest === right.implementationDigest
  );
}
