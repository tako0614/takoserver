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
 *
 * The port is an input for exactly the same reason. An address is a scheme, a
 * name *and* a port, and a self-host whose runtime socket is not on the
 * scheme's default published a portless address the Worker never saw: the
 * request URL inside the Worker carried `:28988`, so the identity it pinned and
 * the identity its Host advertised disagreed again, one dimension over. The
 * port is normalized away when it is the scheme's default, so a deployment
 * behind an ordinary 443 front end publishes exactly what it published before.
 */
export function canonicalWorkerEndpointOrigin(
  script: string,
  suffix: string,
  scheme: "https" | "http" = "https",
  port?: number,
): string | null {
  const hostname = `${script}.${suffix}`.toLowerCase().replace(/\.$/u, "");
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65_535)) {
    return null;
  }
  const authority = port === undefined ? hostname : `${hostname}:${port}`;
  let parsed: URL;
  try {
    parsed = new URL(`${scheme}://${authority}/`);
  } catch {
    return null;
  }
  return parsed.protocol === `${scheme}:` &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.hostname === hostname
    ? parsed.origin
    : null;
}
