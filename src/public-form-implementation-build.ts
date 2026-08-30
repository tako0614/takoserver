import { isSha256Digest } from "./json.ts";
import type { PublicFormImplementationIdentity } from "./public-worker-implementation.ts";

declare const TAKOSERVER_BUILD_FORM_IMPLEMENTATION_PAYLOAD_DIGEST: string;
declare const TAKOSERVER_BUILD_FORM_CAPABILITY_DIGEST: string;
declare const TAKOSERVER_BUILD_FORM_IMPLEMENTATION_DIGEST: string;

/**
 * Reads values replaced by Wrangler while building the outer public Worker.
 * Unbundled/self-host entries have no such identifiers and therefore expose no
 * Cloudflare public-Worker implementation identity.
 */
export function embeddedPublicFormImplementationIdentity():
  | PublicFormImplementationIdentity
  | undefined {
  const implementationPayloadDigest =
    typeof TAKOSERVER_BUILD_FORM_IMPLEMENTATION_PAYLOAD_DIGEST === "string"
      ? TAKOSERVER_BUILD_FORM_IMPLEMENTATION_PAYLOAD_DIGEST
      : undefined;
  const capabilityDigest =
    typeof TAKOSERVER_BUILD_FORM_CAPABILITY_DIGEST === "string"
      ? TAKOSERVER_BUILD_FORM_CAPABILITY_DIGEST
      : undefined;
  const implementationDigest =
    typeof TAKOSERVER_BUILD_FORM_IMPLEMENTATION_DIGEST === "string"
      ? TAKOSERVER_BUILD_FORM_IMPLEMENTATION_DIGEST
      : undefined;
  if (
    implementationPayloadDigest === undefined &&
    capabilityDigest === undefined &&
    implementationDigest === undefined
  ) {
    return undefined;
  }
  if (
    !isSha256Digest(implementationPayloadDigest) ||
    !isSha256Digest(capabilityDigest) ||
    !isSha256Digest(implementationDigest)
  ) {
    throw new TypeError("embedded public Form implementation identity is incomplete");
  }
  return { implementationPayloadDigest, capabilityDigest, implementationDigest };
}
