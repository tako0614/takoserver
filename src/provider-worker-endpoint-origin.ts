import type { ResourceIdentity } from "./provider-port.ts";

/**
 * Stable provider-native name for a logical Resource.
 *
 * Provider adapters share this primitive so an origin reservation and the
 * later ModuleWorker mutation cannot drift onto different native identities.
 */
export async function derivedProviderResourceName(
  prefix: string,
  identity: Pick<ResourceIdentity, "tenantRef" | "space" | "name">,
): Promise<string> {
  return await derivedName(prefix, [identity.tenantRef, identity.space, identity.name]);
}

/**
 * Stable provider-native name for one *incarnation* of a logical Resource.
 *
 * Where `derivedProviderResourceName` answers "which Resource is this", this
 * answers "which one of them" — the Resource UID is part of the digest, so a
 * Resource deleted and declared again under the same name is a different native
 * object. That is what a store needs: a customer who deletes a namespace and
 * creates one with the same name has asked for an empty namespace, and on
 * Cloudflare they get one.
 */
export async function derivedProviderResourceIncarnationName(
  prefix: string,
  identity: Pick<ResourceIdentity, "tenantRef" | "space" | "name"> & { readonly uid: string },
): Promise<string> {
  return await derivedName(prefix, [
    identity.tenantRef,
    identity.space,
    identity.name,
    identity.uid,
  ]);
}

async function derivedName(prefix: string, parts: readonly string[]): Promise<string> {
  // NUL-separated, exactly as it always was: it is the one byte a tenantRef, a
  // space, a name, and a uid cannot contain, so no two different tuples join
  // into the same string. Changing this separator would rename every native
  // object on every deployment.
  const bytes = new TextEncoder().encode(parts.join("\u0000"));
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource),
  );
  const hex = [...digest.slice(0, 20)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${hex}`;
}

/**
 * Exact origin later emitted by WorkerEndpoint for this native script.
 *
 * The scheme is an input rather than a constant because it is a fact about the
 * runtime that serves the address, not a preference. A managed backend and a
 * TLS-terminating self-host serve `https`; a self-host whose operator has
 * configured no certificate serves plain HTTP, and publishing `https://` for it
 * handed out an address nothing answers on — the Worker itself then pinned the
 * `http` origin its own requests arrived under, so its federated identity and
 * the address its Host advertised disagreed.
 */
export function canonicalWorkerEndpointOrigin(
  script: string,
  suffix: string,
  scheme: "https" | "http" = "https",
): string | null {
  const hostname = `${script}.${suffix}`.toLowerCase().replace(/\.$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(`${scheme}://${hostname}/`);
  } catch {
    return null;
  }
  return parsed.protocol === `${scheme}:` &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.port === "" &&
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.hostname === hostname
    ? parsed.origin
    : null;
}
