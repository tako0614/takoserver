import type { JsonObject, JsonValue } from "../ports.ts";
import {
  type ApplyInput,
  failed,
  type Provider,
  type ProviderOffering,
  type ProviderTicket,
  succeeded,
} from "../provider-port.ts";

/**
 * Provisioning on Cloudflare through its REST API.
 *
 * **This module must never reach a Workers bundle.** Publishing a Worker,
 * creating a D1 database, and creating an R2 bucket all require
 * `api.cloudflare.com` and an account token, and the bundle gate forbids both
 * inside a deployed Worker — for good reason, since every Worker sharing a
 * bundle would share that reach. Provisioning therefore runs on the
 * self-hosted entry, and `check-imports` proves the Worker's import graph
 * cannot reach this file.
 *
 * Everything Cloudflare-shaped stops here: URLs, envelopes, and error bodies.
 * What crosses back is a classified ticket.
 */

const API_ORIGIN = "https://api.cloudflare.com/client/v4";

export interface ArtifactBytes {
  /** The committed manifest a tenant holds, or null if it holds none. */
  manifest(tenantRef: string, digest: string): Promise<TakoformBundleManifest | null>;
  blob(digest: string): Promise<Uint8Array | null>;
}

export interface TakoformBundleManifest {
  readonly kind: string;
  readonly mainModule?: string;
  readonly modules?: readonly {
    readonly name: string;
    readonly mediaType: string;
    readonly digest: string;
  }[];
}

/**
 * A DNS zone this deployment may attach customer Workers to.
 *
 * `suffix` is what a hostname must end with to belong to the zone. A platform
 * zone (`apps.takoserver.com`) is how a tenant gets a free address; a customer
 * zone is one the operator has added after the customer proved they control
 * it. A hostname matching no configured zone is refused — that refusal is the
 * ownership boundary, and it is why a tenant cannot claim somebody else's
 * domain by declaring it.
 */
export interface CloudflareZone {
  readonly suffix: string;
  readonly zoneId: string;
  /** Restricts the zone to one tenant. Absent means any tenant may use it. */
  readonly tenantRef?: string;
  /**
   * Labels the platform keeps for itself. A shared zone hands out first-level
   * names to whoever asks first, so the names the operator needs — and the ones
   * a visitor would read as official — must not be claimable.
   */
  readonly reservedLabels?: readonly string[];
  /**
   * Requires the hostname to sit exactly one label below the suffix. Universal
   * TLS certificates cover one level only, so a deeper name resolves and then
   * fails to negotiate — an address that looks issued and does not work.
   */
  readonly singleLabel?: boolean;
}

export interface CloudflareProviderOptions {
  readonly id?: string;
  readonly accountId: string;
  readonly zones?: readonly CloudflareZone[];
  readonly offerings: readonly ProviderOffering[];
  readonly artifacts: ArtifactBytes;
  /** Returns an `Authorization` header value. Credentials never live here. */
  readonly authorize: () => Promise<string> | string;
  readonly apiOrigin?: string;
  readonly fetch?: (request: Request) => Promise<Response>;
}

export class CloudflareProvider implements Provider {
  readonly id: string;
  readonly offerings: readonly ProviderOffering[];
  readonly #accountId: string;
  readonly #origin: string;
  readonly #artifacts: ArtifactBytes;
  readonly #zones: readonly CloudflareZone[];
  readonly #authorize: CloudflareProviderOptions["authorize"];
  readonly #fetch: (request: Request) => Promise<Response>;

  constructor(options: CloudflareProviderOptions) {
    this.id = options.id ?? "cloudflare";
    this.#accountId = options.accountId;
    this.#origin = options.apiOrigin ?? API_ORIGIN;
    this.offerings = structuredClone(options.offerings);
    this.#artifacts = options.artifacts;
    this.#zones = [...(options.zones ?? [])];
    this.#authorize = options.authorize;
    this.#fetch = options.fetch ?? ((request) => fetch(request));
  }

  async apply(input: ApplyInput): Promise<ProviderTicket> {
    switch (input.offering.kind) {
      case "object_bucket":
        return await this.#applyBucket(input);
      case "sql_database":
        return await this.#applyDatabase(input);
      case "worker_script":
        return await this.#applyWorker(input);
      default:
        return failed("invalid_spec", "this offering kind is not provisionable here");
    }
  }

  async observe(input: {
    offering: ProviderOffering;
    nativeId: string;
    spec: JsonObject;
  }): Promise<ProviderTicket> {
    const native = parseNativeId(input.nativeId);
    if (!native) return failed("not_found", "unrecognised native identity");
    const path =
      native.kind === "r2"
        ? `/accounts/${this.#accountId}/r2/buckets/${encodeURIComponent(native.name)}`
        : native.kind === "d1"
          ? `/accounts/${this.#accountId}/d1/database/${encodeURIComponent(native.name)}`
          : `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(native.name)}`;
    const read = await this.#call("GET", path);
    if (!read.ok) return read.ticket;
    return succeeded({
      nativeId: input.nativeId,
      observed: { name: native.name, present: true },
      outputs: outputsFor(native),
    });
  }

  async delete(input: {
    operationId: string;
    offering: ProviderOffering;
    nativeId: string;
    identity: { tenantRef: string; space: string; name: string };
  }): Promise<ProviderTicket> {
    const native = parseNativeId(input.nativeId);
    if (!native) return failed("not_found", "unrecognised native identity");
    const path =
      native.kind === "r2"
        ? `/accounts/${this.#accountId}/r2/buckets/${encodeURIComponent(native.name)}`
        : native.kind === "d1"
          ? `/accounts/${this.#accountId}/d1/database/${encodeURIComponent(native.name)}`
          : `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(native.name)}`;
    const removed = await this.#call("DELETE", path);
    // A resource that is already gone is a successful delete, not a failure.
    if (!removed.ok && removed.status !== 404) return removed.ticket;
    return succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} });
  }

  async adopt(input: {
    offering: ProviderOffering;
    nativeId: string;
    spec: JsonObject;
  }): Promise<ProviderTicket> {
    return await this.observe(input);
  }

  // --- object storage -------------------------------------------------------

  async #applyBucket(input: ApplyInput): Promise<ProviderTicket> {
    const name = input.previous
      ? (parseNativeId(input.previous.nativeId)?.name ?? "")
      : await derivedName("ts", input.identity);
    if (!name) return failed("invalid_spec", "the previous native identity is unusable");
    if (input.previous) {
      // A bucket has nothing mutable in this Form; the update is a no-op that
      // still confirms the resource is there.
      return await this.observe({ ...input, nativeId: `r2:${name}` });
    }
    const location = optionalString(input.spec.location);
    const created = await this.#call("POST", `/accounts/${this.#accountId}/r2/buckets`, {
      name,
      ...(location ? { locationHint: location } : {}),
    });
    if (!created.ok) return created.ticket;
    return succeeded({
      nativeId: `r2:${name}`,
      observed: { name, ...(location ? { location } : {}) },
      outputs: { protocol: "s3", bucketName: name },
    });
  }

  // --- relational database --------------------------------------------------

  async #applyDatabase(input: ApplyInput): Promise<ProviderTicket> {
    if (input.previous) {
      return await this.observe({ ...input, nativeId: input.previous.nativeId });
    }
    const name = await derivedName("tsdb", input.identity);
    const created = await this.#call("POST", `/accounts/${this.#accountId}/d1/database`, {
      name,
      ...(input.region ? { primary_location_hint: input.region } : {}),
    });
    if (!created.ok) return created.ticket;
    const uuid = optionalString(record(created.result)?.uuid);
    if (!uuid) return failed("provider_error", "the database was created without an identifier");
    return succeeded({
      nativeId: `d1:${name}`,
      observed: { name, uuid },
      outputs: { databaseId: uuid, databaseName: name },
    });
  }

  // --- worker ---------------------------------------------------------------

  /**
   * Publishes a Worker from a committed bundle the tenant holds. The modules
   * are uploaded as a multipart script upload; bindings and routes come from
   * the declared spec, never from anything the bundle itself asks for.
   */
  async #applyWorker(input: ApplyInput): Promise<ProviderTicket> {
    const bundleDigest = optionalString(input.spec.bundle);
    if (!bundleDigest) return failed("invalid_spec", "a bundle digest is required");
    const manifest = await this.#artifacts.manifest(input.identity.tenantRef, bundleDigest);
    if (!manifest || manifest.kind !== "WorkerBundle") {
      return failed("invalid_spec", "the declared bundle is not a committed WorkerBundle");
    }
    const mainModule = manifest.mainModule;
    const modules = manifest.modules ?? [];
    if (!mainModule || modules.length === 0) {
      return failed("invalid_spec", "the bundle declares no modules");
    }

    const name = input.previous
      ? (parseNativeId(input.previous.nativeId)?.name ?? "")
      : await derivedName("tsw", input.identity);
    if (!name) return failed("invalid_spec", "the previous native identity is unusable");

    // Durable Object classes must be created by a migration in the same upload
    // that binds them; Cloudflare treats the two as one operation, and a script
    // whose bindings name classes that do not exist is rejected outright.
    const durableObjects = durableObjectsOf(input.spec.durableObjects);
    const previouslyDeclared = previousDurableClasses(input.previous?.spec);
    const migration = migrationFor(durableObjects, previouslyDeclared);

    const form = new FormData();
    form.set(
      "metadata",
      new Blob(
        [
          JSON.stringify({
            main_module: mainModule,
            compatibility_date: optionalString(input.spec.compatibilityDate) ?? "2026-01-01",
            compatibility_flags: stringList(input.spec.compatibilityFlags),
            bindings: [
              ...bindingsOf(input.spec.bindings),
              ...durableObjects.map((entry) => ({
                type: "durable_object_namespace",
                name: entry.name,
                class_name: entry.className,
              })),
            ],
            // A single-script upload carries one migration object, not a list
            // of them; the list form belongs to the multi-script API.
            // A script upload replaces the whole binding set, which would
            // silently delete every secret the operator had set. Secrets are
            // deliberately not declarable in a Form — a declaration is stored,
            // readable, and versioned, which is everything a secret must not
            // be — so they are operator-managed and preserved across applies.
            keep_bindings: ["secret_text"],
            ...(migration ? { migrations: migration } : {}),
          }),
        ],
        { type: "application/json" },
      ),
      "metadata.json",
    );
    for (const module of modules) {
      const bytes = await this.#artifacts.blob(module.digest);
      if (!bytes) return failed("invalid_spec", `a declared module is missing: ${module.name}`);
      form.set(
        module.name,
        new Blob([bytes as unknown as BlobPart], { type: module.mediaType }),
        module.name,
      );
    }

    const published = await this.#callForm(
      "PUT",
      `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(name)}`,
      form,
    );
    if (!published.ok) return published.ticket;

    // Uploading a script does not put it on the internet. A declared hostname
    // is a request to serve it there, so the route and its DNS record are
    // attached here rather than leaving an output URL that answers nothing.
    const hostnames = stringList(input.spec.hostnames);
    for (const hostname of hostnames) {
      const zone = this.#zoneFor(hostname, input.identity.tenantRef);
      if (!zone) {
        return failed(
          "invalid_spec",
          `no configured zone serves ${hostname}; a domain must be one this deployment offers ` +
            "or one the operator has added for this tenant",
        );
      }
      const attached = await this.#call("PUT", `/accounts/${this.#accountId}/workers/domains`, {
        zone_id: zone.zoneId,
        hostname,
        service: name,
        environment: "production",
      });
      if (!attached.ok) return attached.ticket;
    }

    return succeeded({
      nativeId: `worker:${name}`,
      observed: { name, mainModule, moduleCount: modules.length, hostnames },
      outputs: {
        scriptName: name,
        hostnames,
        ...(hostnames[0] ? { url: `https://${hostnames[0]}` } : {}),
      },
    });
  }

  /** The zone that may serve a hostname, if this deployment offers one. */
  #zoneFor(hostname: string, tenantRef: string): CloudflareZone | undefined {
    const eligible = this.#zones.filter(
      (zone) =>
        (zone.tenantRef === undefined || zone.tenantRef === tenantRef) &&
        hostname.endsWith(`.${zone.suffix}`) &&
        this.#labelAllowed(zone, hostname),
    );
    // The most specific zone wins, so a tenant zone nested inside a platform
    // zone is not shadowed by it.
    return eligible.sort((left, right) => right.suffix.length - left.suffix.length)[0];
  }

  #labelAllowed(zone: CloudflareZone, hostname: string): boolean {
    const prefix = hostname.slice(0, -(zone.suffix.length + 1));
    if (prefix.length === 0) return false;
    if (zone.singleLabel && prefix.includes(".")) return false;
    const label = prefix.split(".").at(-1) ?? "";
    return !(zone.reservedLabels ?? []).includes(label);
  }

  // --- transport ------------------------------------------------------------

  async #call(
    method: "GET" | "POST" | "DELETE" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<CallResult> {
    return await this.#send(
      method,
      path,
      body === undefined
        ? undefined
        : { body: JSON.stringify(body), type: "application/json; charset=UTF-8" },
    );
  }

  async #callForm(method: "PUT", path: string, form: FormData): Promise<CallResult> {
    return await this.#send(method, path, { body: form });
  }

  async #send(
    method: string,
    path: string,
    payload?: { body: BodyInit; type?: string },
  ): Promise<CallResult> {
    let authorization: string;
    try {
      authorization = await this.#authorize();
    } catch {
      return { ok: false, status: 0, ticket: failed("denied", "no usable credential") };
    }
    let response: Response;
    try {
      response = await this.#fetch(
        new Request(`${this.#origin}${path}`, {
          method,
          headers: {
            accept: "application/json",
            authorization,
            ...(payload?.type ? { "content-type": payload.type } : {}),
          },
          ...(payload ? { body: payload.body } : {}),
        }),
      );
    } catch {
      return {
        ok: false,
        status: 0,
        ticket: failed("unavailable", "the backend is unreachable", true),
      };
    }
    const envelope = await readEnvelope(response);
    if (response.ok && envelope?.success === true) {
      return { ok: true, status: response.status, result: envelope.result };
    }
    // The backend's own words are written for an operator of that cloud, not
    // for our customer, so they never cross back in the ticket. They are
    // exactly what an operator of *this* platform needs, though, so they are
    // logged rather than discarded.
    console.error(
      JSON.stringify({
        event: "takoserver.provider.refused",
        provider: this.id,
        method,
        path,
        status: response.status,
        errors: Array.isArray(envelope?.errors) ? envelope.errors : undefined,
      }).slice(0, 4_096),
    );
    return { ok: false, status: response.status, ticket: classify(response.status) };
  }
}

type CallResult =
  | { readonly ok: true; readonly status: number; readonly result?: unknown }
  | { readonly ok: false; readonly status: number; readonly ticket: ProviderTicket };

function classify(status: number): ProviderTicket {
  if (status === 400 || status === 422)
    return failed("invalid_spec", "the backend rejected the request");
  if (status === 401 || status === 403) return failed("denied", "the credential was refused");
  if (status === 404) return failed("not_found", "the resource does not exist");
  if (status === 409) return failed("conflict", "the resource already exists");
  if (status === 429) return failed("quota", "the backend is rate limiting", true);
  return failed("unavailable", "the backend could not serve the request", status >= 500);
}

async function readEnvelope(
  response: Response,
): Promise<{ success?: unknown; result?: unknown; errors?: unknown } | null> {
  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch {
    return null;
  }
  if (bytes.byteLength > 4 * 1_048_576) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return record(value) ?? null;
  } catch {
    return null;
  }
}

/**
 * A stable, collision-free backend name derived from the tenant and address.
 * Customer-chosen names are never used directly: two organizations may both
 * call something "assets", and Cloudflare names are account-global.
 */
async function derivedName(
  prefix: string,
  identity: { tenantRef: string; space: string; name: string },
): Promise<string> {
  const bytes = new TextEncoder().encode(`${identity.tenantRef} ${identity.space} ${identity.name}`);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource),
  );
  const hex = [...digest.slice(0, 20)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${hex}`;
}

interface NativeId {
  readonly kind: "r2" | "d1" | "worker";
  readonly name: string;
}

function parseNativeId(value: string): NativeId | null {
  const separator = value.indexOf(":");
  if (separator < 0) return null;
  const kind = value.slice(0, separator);
  const name = value.slice(separator + 1);
  if (kind !== "r2" && kind !== "d1" && kind !== "worker") return null;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u.test(name) ? { kind, name } : null;
}

function outputsFor(native: NativeId): JsonObject {
  if (native.kind === "r2") return { protocol: "s3", bucketName: native.name };
  if (native.kind === "d1") return { databaseName: native.name };
  return { scriptName: native.name };
}

/**
 * Bindings the customer declared. Only kinds Takoserver understands are passed
 * through, so a bundle cannot ask for reach its Form never offered.
 */
function bindingsOf(value: JsonValue | undefined): readonly JsonObject[] {
  if (!Array.isArray(value)) return [];
  const bindings: JsonObject[] = [];
  for (const entry of value) {
    const binding = record(entry);
    const name = optionalString(binding?.name);
    const type = optionalString(binding?.type);
    if (!name || !type) continue;
    if (type === "d1") {
      const id = optionalString(binding?.databaseId);
      if (id) bindings.push({ type: "d1", name, id });
    } else if (type === "r2_bucket") {
      const bucket = optionalString(binding?.bucketName);
      if (bucket) bindings.push({ type: "r2_bucket", name, bucket_name: bucket });
    } else if (type === "kv_namespace") {
      const namespace = optionalString(binding?.namespaceId);
      if (namespace) bindings.push({ type: "kv_namespace", name, namespace_id: namespace });
    } else if (type === "queue") {
      const queue = optionalString(binding?.queueName);
      if (queue) bindings.push({ type: "queue", name, queue_name: queue });
    } else if (type === "service") {
      const service = optionalString(binding?.service);
      if (service) bindings.push({ type: "service", name, service });
    } else if (type === "plain_text") {
      const text = optionalString(binding?.text);
      if (text !== undefined) bindings.push({ type: "plain_text", name, text });
    }
  }
  return bindings;
}

interface DurableObjectDeclaration {
  readonly name: string;
  readonly className: string;
  readonly storage: "sqlite" | "key-value";
}

function durableObjectsOf(value: JsonValue | undefined): readonly DurableObjectDeclaration[] {
  if (!Array.isArray(value)) return [];
  const declared: DurableObjectDeclaration[] = [];
  for (const entry of value) {
    const record_ = record(entry);
    const name = optionalString(record_?.name);
    const className = optionalString(record_?.className);
    if (!name || !className) continue;
    declared.push({
      name,
      className,
      storage: optionalString(record_?.storage) === "key-value" ? "key-value" : "sqlite",
    });
  }
  return declared;
}

function previousDurableClasses(spec: JsonObject | undefined): ReadonlySet<string> {
  return new Set(durableObjectsOf(spec?.durableObjects).map((entry) => entry.className));
}

/**
 * The migration that introduces classes this upload declares for the first
 * time. Classes already present are left alone: re-declaring one as new would
 * ask Cloudflare to create something that exists, and dropping the ones no
 * longer declared would destroy their stored state, which is never a safe
 * inference from an absent line in a spec.
 */
function migrationFor(
  declared: readonly DurableObjectDeclaration[],
  existing: ReadonlySet<string>,
): JsonObject | null {
  const fresh = declared.filter((entry) => !existing.has(entry.className));
  if (fresh.length === 0) return null;
  const sqlite = fresh.filter((entry) => entry.storage === "sqlite").map((e) => e.className);
  const keyValue = fresh.filter((entry) => entry.storage !== "sqlite").map((e) => e.className);
  return {
    tag: `v${existing.size + fresh.length}`,
    ...(sqlite.length > 0 ? { new_sqlite_classes: sqlite } : {}),
    ...(keyValue.length > 0 ? { new_classes: keyValue } : {}),
  };
}

function stringList(value: JsonValue | undefined): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 ? value : undefined;
}
