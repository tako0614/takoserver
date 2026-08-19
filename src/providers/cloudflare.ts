import type { JsonObject, JsonValue } from "../ports.ts";
import type { ProviderRelation } from "../provider-port.ts";
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
 * This module runs inside the API Worker itself (ADR 0001): customer Workers
 * are separate scripts with separate bundles, so holding a scoped account
 * token here hands reach to nobody else. The token must stay scoped — Workers
 * Scripts, R2, D1, and the configured zones only — because the blast radius
 * of this isolate is exactly what that token can do.
 *
 * Everything Cloudflare-shaped stops here: URLs, envelopes, and error bodies.
 * What crosses back is a classified ticket.
 */

const API_ORIGIN = "https://api.cloudflare.com/client/v4";

/** The name a script reaches its own static assets by. */
const ASSETS_BINDING = "ASSETS";

/** Cloudflare's code for "that hostname already resolves to something else". */
const DNS_RECORDS_PRESENT = 100_117;

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
  readonly files?: readonly {
    readonly path: string;
    readonly mediaType: string;
    readonly size: number;
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
  /**
   * Whether the zone's own name may be served.
   *
   * A customer who brought their own domain needs their apex — `example.com`
   * with nothing in front of it is the address they actually want. A shared
   * platform zone must never offer its apex, because that name *is* the
   * platform, so this defaults to refusing it and is turned on per zone.
   */
  readonly apex?: boolean;
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
  /** Exact suffix assigned to this account, for example `team.workers.dev`. */
  readonly workerEndpointSuffix?: string;
  readonly workerCompatibilityDate?: string;
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
  readonly #workerEndpointSuffix: string | undefined;
  readonly #workerCompatibilityDate: string;

  constructor(options: CloudflareProviderOptions) {
    this.id = options.id ?? "cloudflare";
    this.#accountId = options.accountId;
    this.#origin = options.apiOrigin ?? API_ORIGIN;
    this.offerings = structuredClone(options.offerings);
    this.#artifacts = options.artifacts;
    this.#zones = [...(options.zones ?? [])];
    this.#authorize = options.authorize;
    this.#fetch = options.fetch ?? ((request) => fetch(request));
    this.#workerEndpointSuffix = options.workerEndpointSuffix;
    this.#workerCompatibilityDate = options.workerCompatibilityDate ?? "2026-08-19";
  }

  async apply(input: ApplyInput): Promise<ProviderTicket> {
    if (
      input.offering.kind.startsWith("takoform.") &&
      input.offering.form.apiVersion === "edge.forms.takoform.com/v1beta1"
    ) {
      switch (input.offering.form.kind) {
        case "ModuleWorker":
          return await this.#applyModuleWorker(input);
        case "EdgeKVNamespace":
          return await this.#applyKvNamespace(input);
        case "SQLiteDatabase":
          return await this.#applyDatabase(input);
        case "AtLeastOnceQueue":
          return await this.#applyQueue(input);
        case "ObjectBucket":
          return await this.#applyBucket(input);
        case "WorkerVersion":
          return await this.#applyWorkerVersion(input);
        case "WorkerDeployment":
          return await this.#applyWorkerDeployment(input);
        case "WorkerEndpoint":
          return await this.#applyWorkerEndpoint(input);
        case "WorkerCustomDomain":
          return await this.#applyWorkerCustomDomain(input);
        case "WorkerCronTrigger":
          return await this.#applyWorkerCronTrigger(input);
        case "QueueConsumer":
          return await this.#applyQueueConsumer(input);
      }
    }
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
    if (native.kind === "worker" && input.offering.form.kind === "ModuleWorker") {
      return succeeded({
        nativeId: input.nativeId,
        observed: { scriptName: native.name, allocated: true },
        outputs: { scriptName: native.name },
      });
    }
    if (native.kind === "version") {
      const read = await this.#call(
        "GET",
        `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(native.parent)}/versions/${encodeURIComponent(native.name)}`,
      );
      if (!read.ok) return read.ticket;
      return succeeded({
        nativeId: input.nativeId,
        observed: {
          scriptName: native.parent,
          versionId: native.name,
          ...(record(read.result) ?? {}),
        },
        outputs: { scriptName: native.parent, versionId: native.name },
      });
    }
    if (native.kind === "deployment") {
      const read = await this.#call(
        "GET",
        `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(native.parent)}/deployments/${encodeURIComponent(native.name)}`,
      );
      if (!read.ok) return read.ticket;
      return succeeded({
        nativeId: input.nativeId,
        observed: {
          scriptName: native.parent,
          deploymentId: native.name,
          ...(record(read.result) ?? {}),
        },
        outputs: {},
      });
    }
    if (native.kind === "endpoint") {
      const read = await this.#call(
        "GET",
        `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(native.name)}/subdomain`,
      );
      if (!read.ok) return read.ticket;
      if (record(read.result)?.enabled !== true || !this.#workerEndpointSuffix) {
        return failed("not_found", "the Worker endpoint is not active");
      }
      const hostname = `${native.name}.${this.#workerEndpointSuffix}`.toLowerCase();
      return succeeded({
        nativeId: input.nativeId,
        observed: { enabled: true, scriptName: native.name },
        outputs: { hostname, url: `https://${hostname}/` },
      });
    }
    if (native.kind === "domain") {
      const read = await this.#call(
        "GET",
        `/accounts/${this.#accountId}/workers/domains/${encodeURIComponent(native.name)}`,
      );
      if (!read.ok) return read.ticket;
      const domain = record(read.result);
      return succeeded({
        nativeId: input.nativeId,
        observed: {
          domainId: native.name,
          ...(optionalString(domain?.hostname) ? { hostname: domain?.hostname as string } : {}),
          ...(optionalString(domain?.service) ? { scriptName: domain?.service as string } : {}),
        },
        outputs: {},
      });
    }
    if (native.kind === "cron") {
      const read = await this.#call(
        "GET",
        `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(native.parent)}/schedules`,
      );
      if (!read.ok) return read.ticket;
      const cron = optionalString(input.spec?.cron);
      if (!cron || !scheduleValues(read.result).includes(cron)) {
        return failed("not_found", "the Worker schedule does not exist");
      }
      return succeeded({
        nativeId: input.nativeId,
        observed: { cron, scriptName: native.parent },
        outputs: {},
      });
    }
    if (native.kind === "consumer") {
      const read = await this.#call(
        "GET",
        `/accounts/${this.#accountId}/queues/${encodeURIComponent(native.parent)}/consumers/${encodeURIComponent(native.name)}`,
      );
      if (!read.ok) return read.ticket;
      const consumer = record(read.result);
      return succeeded({
        nativeId: input.nativeId,
        observed: {
          queueId: native.parent,
          consumerId: native.name,
          ...(optionalString(consumer?.script_name)
            ? { scriptName: consumer?.script_name as string }
            : {}),
        },
        outputs: {},
      });
    }
    const path =
      native.kind === "r2"
        ? `/accounts/${this.#accountId}/r2/buckets/${encodeURIComponent(native.name)}`
        : native.kind === "d1"
          ? `/accounts/${this.#accountId}/d1/database/${encodeURIComponent(native.name)}`
          : native.kind === "kv"
            ? `/accounts/${this.#accountId}/storage/kv/namespaces/${encodeURIComponent(native.name)}`
            : native.kind === "queue"
              ? `/accounts/${this.#accountId}/queues/${encodeURIComponent(native.name)}`
              : `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(native.name)}`;
    const read = await this.#call("GET", path);
    if (!read.ok) return read.ticket;
    return succeeded({
      nativeId: input.nativeId,
      observed: { name: native.name, present: true, ...(record(read.result) ?? {}) },
      outputs: outputsFor(native, record(read.result)),
    });
  }

  async delete(input: {
    operationId: string;
    offering: ProviderOffering;
    nativeId: string;
    identity: { tenantRef: string; space: string; name: string };
    spec?: JsonObject;
  }): Promise<ProviderTicket> {
    const native = parseNativeId(input.nativeId);
    if (!native) return failed("not_found", "unrecognised native identity");
    if (native.kind === "version") {
      // The stable Workers Scripts Versions API has no delete method. Preserve
      // the immutable provider revision and record that truth in Deployment
      // state; deleting the ModuleWorker later removes the script and all of
      // its versions.
      return succeeded({
        nativeId: input.nativeId,
        disposition: "retained",
        observed: { scriptName: native.parent, versionId: native.name, retained: true },
        outputs: { scriptName: native.parent, versionId: native.name },
      });
    }
    if (native.kind === "cron") {
      const path = `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(native.parent)}/schedules`;
      const read = await this.#call("GET", path);
      if (!read.ok && read.status !== 404) return read.ticket;
      if (read.ok) {
        const cron = optionalString(input.spec?.cron);
        if (!cron) return failed("invalid_spec", "the Worker schedule is incomplete");
        const schedules = scheduleValues(read.result)
          .filter((value) => value !== cron)
          .map((value) => ({ cron: value }));
        const updated = await this.#call("PUT", path, schedules);
        if (!updated.ok) return updated.ticket;
      }
      return succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} });
    }
    const path =
      native.kind === "deployment"
        ? `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(native.parent)}/deployments/${encodeURIComponent(native.name)}`
        : native.kind === "endpoint"
          ? `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(native.name)}/subdomain`
          : native.kind === "domain"
            ? `/accounts/${this.#accountId}/workers/domains/${encodeURIComponent(native.name)}`
            : native.kind === "consumer"
              ? `/accounts/${this.#accountId}/queues/${encodeURIComponent(native.parent)}/consumers/${encodeURIComponent(native.name)}`
              : native.kind === "r2"
                ? `/accounts/${this.#accountId}/r2/buckets/${encodeURIComponent(native.name)}`
                : native.kind === "d1"
                  ? `/accounts/${this.#accountId}/d1/database/${encodeURIComponent(native.name)}`
                  : native.kind === "kv"
                    ? `/accounts/${this.#accountId}/storage/kv/namespaces/${encodeURIComponent(native.name)}`
                    : native.kind === "queue"
                      ? `/accounts/${this.#accountId}/queues/${encodeURIComponent(native.name)}`
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

  // --- edge identity --------------------------------------------------------

  async #applyModuleWorker(input: ApplyInput): Promise<ProviderTicket> {
    const name = input.previous
      ? (parseNativeId(input.previous.nativeId)?.name ?? "")
      : await derivedName("tsw", input.identity);
    if (!name) return failed("invalid_spec", "the previous native identity is unusable");
    // The script container is materialized by WorkerVersion. Allocating its
    // collision-free provider name is the complete ModuleWorker identity act.
    return succeeded({
      nativeId: `worker:${name}`,
      observed: { scriptName: name, allocated: true },
      outputs: { scriptName: name },
    });
  }

  async #applyKvNamespace(input: ApplyInput): Promise<ProviderTicket> {
    if (input.previous) {
      return await this.observe({ ...input, nativeId: input.previous.nativeId });
    }
    const title = await derivedName("tskv", input.identity);
    const created = await this.#call("POST", `/accounts/${this.#accountId}/storage/kv/namespaces`, {
      title,
    });
    if (!created.ok) return created.ticket;
    const id = optionalString(record(created.result)?.id);
    if (!id) return failed("provider_error", "the namespace was created without an identifier");
    return succeeded({
      nativeId: `kv:${id}`,
      observed: { title, id },
      outputs: { namespaceId: id },
    });
  }

  async #applyQueue(input: ApplyInput): Promise<ProviderTicket> {
    if (input.previous) {
      return await this.observe({ ...input, nativeId: input.previous.nativeId });
    }
    const queueName = await derivedName("tsq", input.identity);
    const created = await this.#call("POST", `/accounts/${this.#accountId}/queues`, {
      queue_name: queueName,
      settings: {
        delivery_delay: integer(input.spec.deliveryDelaySeconds) ?? 0,
        message_retention_period: integer(input.spec.messageRetentionSeconds),
      },
    });
    if (!created.ok) return created.ticket;
    const result = record(created.result);
    const id = optionalString(result?.queue_id);
    if (!id) return failed("provider_error", "the queue was created without an identifier");
    return succeeded({
      nativeId: `queue:${id}`,
      observed: { queueId: id, queueName },
      outputs: { queueId: id, queueName },
    });
  }

  async #applyWorkerVersion(input: ApplyInput): Promise<ProviderTicket> {
    if (input.previous) return failed("invalid_spec", "Worker Versions are immutable");
    const worker = relationDeployment(input.relations, "/worker", "worker");
    const bundle = relationResource(input.relations, "/bundle", "WorkerBundle");
    const manifestDigest = optionalString(bundle?.spec.manifestDigest);
    if (!worker || !manifestDigest)
      return failed("invalid_spec", "the Worker Version is incomplete");
    const scriptName = worker.name;
    const manifest = await this.#artifacts.manifest(input.identity.tenantRef, manifestDigest);
    if (!manifest || manifest.kind !== "WorkerBundle" || !manifest.mainModule) {
      return failed("invalid_spec", "the Worker Bundle is not available");
    }
    const modules = manifest.modules ?? [];
    if (modules.length === 0) return failed("invalid_spec", "the Worker Bundle has no modules");

    const bindings = edgeBindings(input.spec, input.relations);
    if (!bindings) return failed("invalid_spec", "a Worker binding has no provider deployment");
    const assetsSpec = record(input.spec.assets);
    let assetToken: string | null = null;
    if (assetsSpec) {
      const assetsResource = relationResource(
        input.relations,
        "/assets/bundle",
        "StaticAssetBundle",
      );
      const assetsDigest = optionalString(assetsResource?.spec.manifestDigest);
      if (!assetsDigest) return failed("invalid_spec", "the Static Asset Bundle is unavailable");
      const uploaded = await this.#uploadAssets(scriptName, input.identity.tenantRef, {
        bundle: assetsDigest,
      });
      if (typeof uploaded !== "string") return uploaded;
      assetToken = uploaded;
    }
    const form = new FormData();
    form.set(
      "metadata",
      new Blob(
        [
          JSON.stringify({
            main_module: manifest.mainModule,
            compatibility_date: this.#workerCompatibilityDate,
            bindings: [
              ...bindings,
              ...(assetToken ? [{ type: "assets", name: ASSETS_BINDING }] : []),
            ],
            keep_bindings: ["secret_text"],
            ...(assetToken
              ? {
                  assets: {
                    jwt: assetToken,
                    config: {
                      html_handling: "auto-trailing-slash",
                      not_found_handling:
                        assetsSpec?.notFoundHandling === "single_page_application"
                          ? "single-page-application"
                          : "none",
                      run_worker_first: assetsSpec?.runWorkerFirst === true,
                    },
                  },
                }
              : {}),
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
        new Blob([bytes.buffer as ArrayBuffer], { type: module.mediaType }),
        module.name,
      );
    }
    const uploaded = await this.#callForm(
      "POST",
      `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(scriptName)}/versions`,
      form,
    );
    if (!uploaded.ok) return uploaded.ticket;
    const versionId = optionalString(record(uploaded.result)?.id);
    if (!versionId) return failed("provider_error", "the Worker Version has no identifier");
    return succeeded({
      nativeId: `version:${scriptName}:${versionId}`,
      observed: { scriptName, versionId },
      outputs: { scriptName, versionId },
    });
  }

  async #applyWorkerDeployment(input: ApplyInput): Promise<ProviderTicket> {
    const worker = relationDeployment(input.relations, "/worker", "worker");
    const versions = Array.isArray(input.spec.versions) ? input.spec.versions : [];
    if (!worker || versions.length === 0) {
      return failed("invalid_spec", "the Worker Deployment is incomplete");
    }
    const weighted: { version_id: string; percentage: number }[] = [];
    for (let index = 0; index < versions.length; index += 1) {
      const relation = relationDeployment(
        input.relations,
        `/versions/${index}/workerVersion`,
        "version",
      );
      const declared = record(versions[index]);
      const weight = integer(declared?.weight);
      if (!relation || relation.parent !== worker.name || weight === undefined) {
        return failed("invalid_spec", "a deployed version does not belong to this Worker");
      }
      weighted.push({ version_id: relation.name, percentage: weight / 100 });
    }
    const deployed = await this.#call(
      "POST",
      `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(worker.name)}/deployments`,
      { strategy: "percentage", versions: weighted },
    );
    if (!deployed.ok) return deployed.ticket;
    const id = optionalString(record(deployed.result)?.id);
    if (!id) return failed("provider_error", "the Worker Deployment has no identifier");
    return succeeded({
      nativeId: `deployment:${worker.name}:${id}`,
      observed: { scriptName: worker.name, deploymentId: id, versions: weighted },
      outputs: {},
    });
  }

  async #applyWorkerEndpoint(input: ApplyInput): Promise<ProviderTicket> {
    const worker = relationDeployment(input.relations, "/worker", "worker");
    if (!worker || !this.#workerEndpointSuffix) {
      return failed("invalid_spec", "this provider installation offers no Worker endpoint suffix");
    }
    const enabled = await this.#call(
      "POST",
      `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(worker.name)}/subdomain`,
      { enabled: true, previews_enabled: false },
    );
    if (!enabled.ok) return enabled.ticket;
    const hostname = `${worker.name}.${this.#workerEndpointSuffix}`.toLowerCase();
    return succeeded({
      nativeId: `endpoint:${worker.name}`,
      observed: { enabled: true },
      outputs: { hostname, url: `https://${hostname}/` },
    });
  }

  async #applyWorkerCustomDomain(input: ApplyInput): Promise<ProviderTicket> {
    const worker = relationDeployment(input.relations, "/worker", "worker");
    const hostname = optionalString(input.spec.hostname)?.toLowerCase().replace(/\.$/u, "");
    if (!worker || !hostname) return failed("invalid_spec", "the custom domain is incomplete");
    const zone = this.#zoneFor(hostname, input.identity.tenantRef);
    if (!zone) return failed("invalid_spec", "no configured zone serves this hostname");
    const attached = await this.#attach(zone, hostname, worker.name);
    if (!attached.ok) return attached.ticket;
    const domainId = optionalString(record(attached.result)?.id);
    if (!domainId) return failed("provider_error", "the Worker domain has no identifier");
    return succeeded({
      nativeId: `domain:${domainId}`,
      observed: { domainId, hostname, scriptName: worker.name },
      outputs: {},
    });
  }

  async #applyWorkerCronTrigger(input: ApplyInput): Promise<ProviderTicket> {
    const worker = relationDeployment(input.relations, "/worker", "worker");
    const cron = optionalString(input.spec.cron);
    if (!worker || !cron) return failed("invalid_spec", "the cron trigger is incomplete");
    const read = await this.#call(
      "GET",
      `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(worker.name)}/schedules`,
    );
    if (!read.ok) return read.ticket;
    const existing = scheduleValues(read.result);
    const schedules = [...new Set([...existing, cron])].sort().map((value) => ({ cron: value }));
    const updated = await this.#call(
      "PUT",
      `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(worker.name)}/schedules`,
      schedules,
    );
    if (!updated.ok) return updated.ticket;
    return succeeded({
      nativeId: `cron:${worker.name}:${await shortDigest(cron)}`,
      observed: { cron, scriptName: worker.name },
      outputs: {},
    });
  }

  async #applyQueueConsumer(input: ApplyInput): Promise<ProviderTicket> {
    const worker = relationDeployment(input.relations, "/worker", "worker");
    const queue = relationDeployment(input.relations, "/queue", "queue");
    const deadLetter = relationDeployment(input.relations, "/deadLetterQueue", "queue", true);
    if (!worker || !queue) return failed("invalid_spec", "the Queue Consumer is incomplete");
    const body = {
      type: "worker",
      script_name: worker.name,
      settings: {
        batch_size: integer(input.spec.maxBatchSize),
        max_wait_time_ms: (integer(input.spec.maxBatchTimeoutSeconds) ?? 0) * 1_000,
        max_retries: integer(input.spec.maxRetries),
        retry_delay: integer(input.spec.retryDelaySeconds),
        max_concurrency: integer(input.spec.maxConcurrency),
      },
      ...(deadLetter
        ? {
            dead_letter_queue: relationOutputName(input.relations, "/deadLetterQueue", "queueName"),
          }
        : {}),
    };
    const created = await this.#call(
      "POST",
      `/accounts/${this.#accountId}/queues/${encodeURIComponent(queue.name)}/consumers`,
      body,
    );
    if (!created.ok) return created.ticket;
    const id = optionalString(record(created.result)?.consumer_id);
    if (!id) return failed("provider_error", "the Queue Consumer has no identifier");
    return succeeded({
      nativeId: `consumer:${queue.name}:${id}`,
      observed: { consumerId: id, queueId: queue.name, scriptName: worker.name },
      outputs: {},
    });
  }

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
      nativeId: `d1:${uuid}`,
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

    // Assets are uploaded before the script, because the script's metadata
    // must carry the completion token the asset upload returns.
    const assets = record(input.spec.assets);
    // A script that declares assets is given a binding to them. Without one the
    // asset layer only answers requests that match a file exactly: anything
    // else reaches the Worker, and `notFoundHandling` — the whole reason an
    // application with client-side routing survives a reload — never applies.
    // The Worker has to be able to ask, so it is always handed the means.
    if (
      assets &&
      bindingsOf(input.spec.bindings).some((binding) => binding.name === ASSETS_BINDING)
    ) {
      return failed(
        "invalid_spec",
        `a script that declares assets is given a binding named ${ASSETS_BINDING}; ` +
          "declare your own binding under a different name",
      );
    }
    let assetToken: string | null = null;
    if (assets) {
      const uploaded = await this.#uploadAssets(name, input.identity.tenantRef, assets);
      if (typeof uploaded !== "string") return uploaded;
      assetToken = uploaded;
    }

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
              ...(assetToken ? [{ type: "assets", name: ASSETS_BINDING }] : []),
            ],
            // A single-script upload carries one migration object, not a list
            // of them; the list form belongs to the multi-script API.
            // A script upload replaces the whole binding set, which would
            // silently delete every secret the operator had set. Secrets are
            // deliberately not declarable in a Form — a declaration is stored,
            // readable, and versioned, which is everything a secret must not
            // be — so they are operator-managed and preserved across applies.
            keep_bindings: ["secret_text"],
            ...(assetToken
              ? {
                  assets: {
                    jwt: assetToken,
                    config: {
                      html_handling: "auto-trailing-slash",
                      not_found_handling:
                        optionalString(assets?.notFoundHandling) ?? "single-page-application",
                    },
                  },
                }
              : {}),
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
        // The Workers and Bun lib types disagree about what a Blob part is.
        // Both accept the bytes; only the declarations differ.
        new Blob([bytes.buffer as ArrayBuffer], { type: module.mediaType }),
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
      const replaceable = new Set(stringList(input.spec.replaceExistingRecords));
      let attached = await this.#attach(zone, hostname, name);
      if (
        !attached.ok &&
        attached.codes.includes(DNS_RECORDS_PRESENT) &&
        replaceable.has(hostname)
      ) {
        // The declaration asked for this hostname by name, knowing it points
        // somewhere. Clearing the records is destructive and one-way, which is
        // exactly why it happens only when it was asked for.
        const cleared = await this.#clearRecords(zone, hostname);
        if (!cleared.ok) return cleared.ticket;
        attached = await this.#attach(zone, hostname, name);
      }
      if (!attached.ok) {
        // Cloudflare refuses to attach a Worker to a hostname that already has
        // DNS records, which is the ordinary state of a domain somebody brought
        // with them. Reported as "the resource is busy" it reads as a transient
        // fault worth retrying; it is neither, and only the customer can clear
        // it.
        if (attached.codes.includes(DNS_RECORDS_PRESENT)) {
          return failed(
            "invalid_spec",
            `${hostname} already has DNS records of its own; remove them in the zone and apply ` +
              "again, and this deployment will create the record it needs",
          );
        }
        return attached.ticket;
      }
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

  /**
   * Uploads a committed asset bundle and returns the completion token the
   * script upload must carry.
   *
   * Cloudflare asks first which files it does not already hold, so an unchanged
   * asset never travels twice — the same content-addressed idea the artifact
   * store already uses, one layer down.
   */
  async #uploadAssets(
    scriptName: string,
    tenantRef: string,
    assets: Record<string, unknown>,
  ): Promise<string | ProviderTicket> {
    const digest = optionalString(assets.bundle);
    if (!digest) return failed("invalid_spec", "an asset bundle digest is required");
    const manifest = await this.#artifacts.manifest(tenantRef, digest);
    if (!manifest || manifest.kind !== "StaticAssetBundle") {
      return failed("invalid_spec", "the declared assets are not a committed StaticAssetBundle");
    }
    const files = manifest.files ?? [];
    if (files.length === 0) return failed("invalid_spec", "the asset bundle declares no files");

    const declared: Record<string, { hash: string; size: number }> = {};
    const byHash = new Map<string, { name: string; digest: string; mediaType: string }>();
    for (const file of files) {
      // Cloudflare identifies an asset by a 32-hex-character hash, not by the
      // full digest, so the digest is truncated consistently on both sides.
      const hash = file.digest.slice("sha256:".length, "sha256:".length + 32);
      declared[`/${file.path}`] = { hash, size: file.size };
      byHash.set(hash, { name: file.path, digest: file.digest, mediaType: file.mediaType });
    }

    const started = await this.#call(
      "POST",
      `/accounts/${this.#accountId}/workers/scripts/${encodeURIComponent(scriptName)}/assets-upload-session`,
      { manifest: declared },
    );
    if (!started.ok) return started.ticket;
    const session = record(started.result);
    const token = optionalString(session?.jwt);
    const buckets = Array.isArray(session?.buckets) ? (session.buckets as string[][]) : [];
    // No buckets means every file was already held; the token alone completes.
    if (buckets.length === 0) return token ?? failed("provider_error", "no asset upload token");

    let completion = token;
    for (const bucket of buckets) {
      const payload = new FormData();
      for (const hash of bucket) {
        const file = byHash.get(hash);
        const bytes = file ? await this.#artifacts.blob(file.digest) : null;
        if (!file || !bytes) return failed("invalid_spec", "a declared asset is missing");
        payload.set(
          hash,
          new File([base64(bytes)], hash, { type: file.mediaType || "application/octet-stream" }),
          hash,
        );
      }
      const sent = await this.#sendAssets(completion ?? "", payload);
      if (!sent.ok) return sent.ticket;
      const result = record(sent.result);
      completion = optionalString(result?.jwt) ?? completion;
    }
    return completion ?? failed("provider_error", "asset upload did not complete");
  }

  async #sendAssets(token: string, payload: FormData): Promise<CallResult> {
    let response: Response;
    try {
      response = await this.#fetch(
        new Request(
          `${this.#origin}/accounts/${this.#accountId}/workers/assets/upload?base64=true`,
          {
            method: "POST",
            headers: { accept: "application/json", authorization: `Bearer ${token}` },
            body: payload,
          },
        ),
      );
    } catch {
      return {
        ok: false,
        status: 0,
        ticket: failed("unavailable", "asset upload unreachable", true),
        codes: [],
      };
    }
    const envelope = await readEnvelope(response);
    if (response.ok && envelope?.success === true) {
      return { ok: true, status: response.status, result: envelope.result };
    }
    console.error(
      JSON.stringify({
        event: "takoserver.provider.refused",
        provider: this.id,
        method: "POST",
        path: "/workers/assets/upload",
        status: response.status,
        errors: Array.isArray(envelope?.errors) ? envelope.errors : undefined,
      }).slice(0, 4_096),
    );
    return {
      ok: false,
      status: response.status,
      ticket: classify(response.status),
      codes: errorCodes(envelope?.errors),
    };
  }

  /** Points a hostname at a script. */
  async #attach(zone: CloudflareZone, hostname: string, script: string): Promise<CallResult> {
    return await this.#call("PUT", `/accounts/${this.#accountId}/workers/domains`, {
      zone_id: zone.zoneId,
      hostname,
      service: script,
      environment: "production",
    });
  }

  /**
   * Removes the records standing where a hostname is about to be served.
   *
   * Only the records for that exact name: a zone holds other people's names
   * too, and a delete that reached one of those would take a service down that
   * nobody was talking about.
   */
  async #clearRecords(zone: CloudflareZone, hostname: string): Promise<CallResult> {
    const listed = await this.#call(
      "GET",
      `/zones/${zone.zoneId}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`,
    );
    if (!listed.ok) return listed;
    const records = Array.isArray(listed.result) ? listed.result : [];
    for (const record of records) {
      const id = (record as { id?: unknown })?.id;
      const type = (record as { type?: unknown })?.type;
      // Only the kinds that stand in the way. A TXT record proving domain
      // ownership somewhere else is not in the way, and deleting it would
      // break something invisible from here.
      if (typeof id !== "string" || (type !== "A" && type !== "AAAA" && type !== "CNAME")) {
        continue;
      }
      const removed = await this.#call("DELETE", `/zones/${zone.zoneId}/dns_records/${id}`);
      if (!removed.ok && removed.status !== 404) return removed;
    }
    return { ok: true, status: 200 };
  }

  /** The zone that may serve a hostname, if this deployment offers one. */
  #zoneFor(hostname: string, tenantRef: string): CloudflareZone | undefined {
    const eligible = this.#zones.filter(
      (zone) =>
        (zone.tenantRef === undefined || zone.tenantRef === tenantRef) &&
        (hostname === zone.suffix
          ? zone.apex === true
          : hostname.endsWith(`.${zone.suffix}`) && this.#labelAllowed(zone, hostname)),
    );
    // The most specific zone wins, so a tenant zone nested inside a platform
    // zone is not shadowed by it. Where two zones cover the same suffix — the
    // usual shape for an operator holding back names it needs from a zone it
    // also offers to customers — the one granted to a named tenant is the more
    // specific of the two. Deciding this by rule rather than by the order the
    // zones happen to be configured in is what keeps the grant from depending
    // on where somebody put a line in a list.
    return eligible.sort(
      (left, right) =>
        right.suffix.length - left.suffix.length ||
        Number(right.tenantRef !== undefined) - Number(left.tenantRef !== undefined),
    )[0];
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

  async #callForm(method: "POST" | "PUT", path: string, form: FormData): Promise<CallResult> {
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
      return { ok: false, status: 0, ticket: failed("denied", "no usable credential"), codes: [] };
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
        codes: [],
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
    return {
      ok: false,
      status: response.status,
      ticket: classify(response.status),
      codes: errorCodes(envelope?.errors),
    };
  }
}

type CallResult =
  | { readonly ok: true; readonly status: number; readonly result?: unknown }
  | {
      readonly ok: false;
      readonly status: number;
      readonly ticket: ProviderTicket;
      /**
       * The backend's own error codes. Its *words* are written for an operator
       * of that cloud and never cross back, but a few of its codes describe
       * something only our customer can fix, and those deserve a message in our
       * vocabulary rather than a generic refusal.
       */
      readonly codes: readonly number[];
    };

/** The numeric codes in a Cloudflare error envelope, if it carried any. */
function errorCodes(errors: unknown): readonly number[] {
  if (!Array.isArray(errors)) return [];
  return errors
    .map((entry) => (entry as { code?: unknown } | null)?.code)
    .filter((code): code is number => typeof code === "number");
}

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
  const bytes = new TextEncoder().encode(
    `${identity.tenantRef}\0${identity.space}\0${identity.name}`,
  );
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource),
  );
  const hex = [...digest.slice(0, 20)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${hex}`;
}

type NativeId =
  | {
      readonly kind: "r2" | "d1" | "kv" | "queue" | "worker" | "endpoint" | "domain";
      readonly name: string;
    }
  | {
      readonly kind: "version" | "deployment" | "cron" | "consumer";
      readonly parent: string;
      readonly name: string;
    };

function parseNativeId(value: string): NativeId | null {
  const parts = value.split(":");
  const kind = parts[0];
  if (
    (kind === "r2" ||
      kind === "d1" ||
      kind === "kv" ||
      kind === "queue" ||
      kind === "worker" ||
      kind === "endpoint" ||
      kind === "domain") &&
    parts.length === 2 &&
    nativeSegment(parts[1])
  ) {
    return { kind, name: parts[1] };
  }
  if (
    (kind === "version" || kind === "deployment" || kind === "cron" || kind === "consumer") &&
    parts.length === 3 &&
    nativeSegment(parts[1]) &&
    nativeSegment(parts[2])
  ) {
    return { kind, parent: parts[1], name: parts[2] };
  }
  return null;
}

function outputsFor(native: NativeId, result?: Record<string, unknown>): JsonObject {
  if (native.kind === "r2") return { protocol: "s3", bucketName: native.name };
  if (native.kind === "d1") {
    const databaseName = optionalString(result?.name);
    return {
      databaseId: native.name,
      ...(databaseName ? { databaseName } : {}),
    };
  }
  if (native.kind === "kv") return { namespaceId: native.name };
  if (native.kind === "queue") {
    const queueName = optionalString(result?.queue_name);
    return {
      queueId: native.name,
      ...(queueName ? { queueName } : {}),
    };
  }
  if (native.kind === "worker") return { scriptName: native.name };
  return {};
}

function nativeSegment(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u.test(value);
}

function scheduleValues(value: unknown): string[] {
  const result = record(value);
  const list = Array.isArray(value)
    ? value
    : Array.isArray(result?.schedules)
      ? result.schedules
      : [];
  return [
    ...new Set(list.map((item) => optionalString(record(item)?.cron)).filter(isString)),
  ].sort();
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? Number(value) : undefined;
}

interface RelationNative {
  readonly kind: string;
  readonly name: string;
  readonly parent?: string;
}

function relationDeployment(
  relations: readonly ProviderRelation[] | undefined,
  pointer: string,
  kind: string,
  optional = false,
): RelationNative | null {
  const relation = relations?.find((candidate) => candidate.pointer === pointer);
  const nativeId = relation?.deployment?.nativeId;
  if (!nativeId) return optional ? null : null;
  const parts = nativeId.split(":");
  if (parts[0] !== kind) return null;
  if (parts.length === 2 && parts[1]) return { kind, name: parts[1] };
  if (parts.length === 3 && parts[1] && parts[2]) {
    return { kind, parent: parts[1], name: parts[2] };
  }
  return null;
}

function relationResource(
  relations: readonly ProviderRelation[] | undefined,
  pointer: string,
  kind: string,
): ProviderRelation["resource"] | null {
  const relation = relations?.find((candidate) => candidate.pointer === pointer);
  return relation?.resource.kind === kind ? relation.resource : null;
}

function relationOutputName(
  relations: readonly ProviderRelation[] | undefined,
  pointer: string,
  output: string,
): string | undefined {
  const relation = relations?.find((candidate) => candidate.pointer === pointer);
  return optionalString(relation?.deployment?.outputs[output]);
}

function edgeBindings(
  spec: JsonObject,
  relations: readonly ProviderRelation[] | undefined,
): readonly JsonObject[] | null {
  const result: JsonObject[] = [];
  const vars = record(spec.vars) ?? {};
  for (const [name, value] of Object.entries(vars).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    result.push({ type: "plain_text", name, text: JSON.stringify(value) });
  }
  for (const [field, relationPrefix, type, output, targetKey] of [
    ["kvBindings", "/kvBindings", "kv_namespace", "namespaceId", "namespace_id"],
    ["bucketBindings", "/bucketBindings", "r2_bucket", "bucketName", "bucket_name"],
    ["sqliteBindings", "/sqliteBindings", "d1", "databaseId", "id"],
    ["queueProducerBindings", "/queueProducerBindings", "queue", "queueName", "queue_name"],
    ["serviceBindings", "/serviceBindings", "service", "scriptName", "service"],
  ] as const) {
    const declarations = Array.isArray(spec[field]) ? spec[field] : [];
    for (let index = 0; index < declarations.length; index += 1) {
      const declaration = record(declarations[index]);
      const name = optionalString(declaration?.name);
      const target = relationOutputName(relations, `${relationPrefix}/${index}/resource`, output);
      if (!name || !target) return null;
      result.push({ type, name, [targetKey]: target });
    }
  }
  return result;
}

async function shortDigest(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value) as unknown as BufferSource,
    ),
  );
  return [...digest.slice(0, 10)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 ? value : undefined;
}
