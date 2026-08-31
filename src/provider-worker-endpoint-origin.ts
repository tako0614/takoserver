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
  const bytes = new TextEncoder().encode(
    `${identity.tenantRef}\0${identity.space}\0${identity.name}`,
  );
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource),
  );
  const hex = [...digest.slice(0, 20)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${hex}`;
}

/** Exact HTTPS origin later emitted by WorkerEndpoint for this native script. */
export function canonicalWorkerEndpointOrigin(script: string, suffix: string): string | null {
  const hostname = `${script}.${suffix}`.toLowerCase().replace(/\.$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(`https://${hostname}/`);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" &&
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
