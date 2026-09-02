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

/**
 * The hostname grammar `WorkerEndpoint@0.1.0` publishes, verbatim.
 *
 * Copied from `vendor/takoform/v2.1.1/forms/worker-endpoint/definition.json`
 * (`outputSchema.properties.hostname.pattern`, and the tail of `url.pattern`,
 * which are the same grammar). It is here rather than read from the Form
 * because this rule has to run before a Form is resolved — at the moment an
 * address is reserved, which is long before any receipt is projected.
 */
const FORM_PUBLISHABLE_HOSTNAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
/** `hostname.maxLength` and `url.maxLength` from the same Form. */
const FORM_PUBLISHABLE_HOSTNAME_LENGTH = 253;
const FORM_PUBLISHABLE_URL_LENGTH = 264;

/** Why an origin cannot be published as a `WorkerEndpoint` address. */
export type WorkerEndpointPublicationDefect = "scheme" | "port" | "hostname";

/**
 * Whether an origin can be published as a `WorkerEndpoint` address at all.
 *
 * `WorkerEndpoint@0.1.0` is a released Form and its `url` output is
 * `^https://<dotted-name>/$`. Its prose says the same thing in words — *"the
 * scheme is https … there is no plaintext address and no port"* — so an
 * address that is honest about a plain-HTTP socket, or about a socket that is
 * not on 443, is an address this Form cannot carry. The Form is the authority
 * on what a `WorkerEndpoint` address may look like, so the Host's job is to
 * refuse to *reserve* such an address rather than to mint one and discover the
 * refusal after the provider has already mutated.
 *
 * This is deliberately separate from the scheme an installation *serves*
 * ([ADR 0009](../docs/adr/0009-a-self-host-publishes-the-scheme-its-socket-serves.md)).
 * A self-host on plain HTTP still serves its Workers on its own socket, and the
 * origin it hands them is still the true one; what it cannot do is publish that
 * origin as a `WorkerEndpoint`.
 */
export function workerEndpointPublicationDefect(
  origin: string,
): WorkerEndpointPublicationDefect | null {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return "hostname";
  }
  if (parsed.protocol !== "https:") return "scheme";
  // `URL` has already normalized the scheme's own default away, so a port that
  // survives here is one a consumer would have to dial.
  if (parsed.port !== "") return "port";
  if (
    parsed.hostname.length > FORM_PUBLISHABLE_HOSTNAME_LENGTH ||
    !FORM_PUBLISHABLE_HOSTNAME.test(parsed.hostname) ||
    `https://${parsed.hostname}/`.length > FORM_PUBLISHABLE_URL_LENGTH
  ) {
    return "hostname";
  }
  return null;
}

/**
 * The one sentence an operator reads about an address that cannot be published.
 *
 * Shared by the boot diagnostic and by the wire refusal on purpose: an operator
 * who reads it at start-up and an operator who reads it out of `tofu apply`
 * must be told the same two things to do, and two copies of a sentence drift.
 * It carries no address, so that it fits inside the envelope's bounded message
 * with both remedies intact; the boot diagnostic, which has no such bound,
 * names the address in front of it.
 */
export function workerEndpointPublicationRemedy(defect: WorkerEndpointPublicationDefect): string {
  if (defect === "hostname") {
    return (
      "no Worker endpoint can be published here: this deployment's address is not a dotted " +
      "DNS name WorkerEndpoint@0.1.0 can carry. Set TAKOSERVER_WORKER_ENDPOINT_SUFFIX to a " +
      "name this machine answers on."
    );
  }
  const cause = defect === "scheme" ? "is plain HTTP" : "carries a port";
  return (
    `no Worker endpoint can be published here: this deployment's address ${cause}, and ` +
    "WorkerEndpoint@0.1.0 admits only https on the default port. Either terminate TLS in " +
    "workerd on 443 (TAKOSERVER_WORKERD_TLS_CERT_FILE, TAKOSERVER_WORKERD_TLS_KEY_FILE, " +
    "TAKOSERVER_WORKERD_PORT=443), or run a 443 front end and set " +
    "TAKOSERVER_WORKER_ENDPOINT_PORT=443. Workers and storage run either way."
  );
}
