import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Miniflare } from "miniflare";
import { createStaticTestTakoformHost as createTakoformHost } from "./app.ts";
import { migrateSqlite } from "./migrate-sqlite.ts";
import { createMemoryObjectStore } from "./objects-mem.ts";
import type {
  ProviderOffering,
  ProviderRelation,
  ProviderResult,
  ProviderTicket,
} from "./provider-port.ts";
import { CloudflareProvider } from "./providers/cloudflare.ts";
import { createSqliteSql } from "./sql-sqlite.ts";
import { createTakoformArtifacts } from "./takoform/artifacts.ts";
import type {
  InstalledTakoformForm,
  TakoformDriverRelation,
  TakoformResourceDriver,
} from "./takoform/types.ts";
import { TakoformHostError } from "./takoform/types.ts";
import { createJavaScriptWorkerModuleInspector } from "./takoform/worker-module-inspector.ts";
import { loadProviderEraTestCatalog } from "./worker-stable-local-composition.ts";

const STABLE_API_PATH = "/apis/forms.takoform.com/v1";
const STABLE_DISCOVERY_PATH = "/.well-known/takoform/v1";
const ACCOUNT_ID = "account_stable_local";
const WORKER_SUFFIX = "stable-local.workers.invalid";
const HOST_FORMS = [
  "ModuleWorker",
  "SQLiteDatabase",
  "SQLiteMigrationSet",
  "SQLiteMigrationApplication",
  "EdgeKVNamespace",
  "AtLeastOnceQueue",
  "WorkerBundle",
  "StaticAssetBundle",
  "WorkerVersion",
  "WorkerDeployment",
  "WorkerEndpoint",
  "QueueConsumer",
  "WorkerCronTrigger",
] as const;
const INTRINSIC = new Set([
  "WorkerBundle",
  "StaticAssetBundle",
  "SQLiteMigrationSet",
  "SQLiteMigrationApplication",
]);

export interface StableLocalCloudflareHost {
  readonly endpoint: string;
  readonly diagnosticRuntimeEndpoint: string;
  readonly space: string;
  readonly classification: "test-only-local-cloudflare-adapter";
  report(): {
    readonly classification: "test-only-local-cloudflare-adapter";
    readonly installedFormKindCount: 13;
    readonly resourceGraphCount: 13;
    readonly currentObjectBucketIdentities: 0;
    readonly currentEdgeObjectsReferences: 0;
    readonly resources: Readonly<Record<string, number>>;
  };
  exerciseNativeHandlers(): Promise<{
    readonly queueHandlerInvocations: number;
    readonly scheduledHandlerInvocations: number;
  }>;
  close(): Promise<void>;
}

/**
 * Uses the production Cloudflare Provider adapter against an in-process REST
 * account and real workerd. It is test-only: stable package bytes are external
 * unpublished inputs and the assigned HTTPS URL is not public admission.
 */
export async function startStableLocalCloudflareHost(input: {
  readonly takoformRepositoryRoot: string;
  readonly token: string;
  readonly runtimeValues: Readonly<Record<string, string>>;
  readonly space?: string;
  readonly port?: number;
}): Promise<StableLocalCloudflareHost> {
  if (input.token.length < 16 || input.token.length > 4_096) {
    throw new Error("stable local Host token must contain 16-4096 characters");
  }
  const space = input.space ?? "default";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(space)) {
    throw new Error("stable local Host Space is invalid");
  }
  const runtimeNames = Object.keys(input.runtimeValues).sort();
  if (
    runtimeNames.length === 0 ||
    runtimeNames.some(
      (name) =>
        !/^[A-Z][A-Z0-9_]{0,127}$/u.test(name) ||
        input.runtimeValues[name] === undefined ||
        input.runtimeValues[name]?.length === 0,
    )
  ) {
    throw new Error("stable local runtime values are invalid");
  }

  const catalog = await loadProviderEraTestCatalog(input.takoformRepositoryRoot);
  const forms = HOST_FORMS.map((kind) => exactForm(catalog.forms, kind));
  const database = new Database(":memory:");
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  const objects = createMemoryObjectStore();
  const artifacts = createTakoformArtifacts({
    sql,
    objects,
    clock: () => new Date(),
    randomId: () => crypto.randomUUID(),
  });
  const dataRoot = await mkdtemp(join(tmpdir(), "takoserver-stable-cloudflare-"));
  const cloudflare = new LocalCloudflare(dataRoot);
  const offerings = forms
    .filter((form) => !INTRINSIC.has(form.identity.formRef.kind))
    .map(technicalOffering);
  const provider = new CloudflareProvider({
    accountId: ACCOUNT_ID,
    offerings,
    artifacts: {
      manifest: (tenantRef, digest) => artifacts.resolveManifest(tenantRef, digest),
      blob: (digest) => artifacts.resolveBlob("org_stable_local", digest),
    },
    authorize: () => "Bearer local-cloudflare-authority",
    apiOrigin: "https://api.cloudflare.test/client/v4",
    workerEndpointSuffix: WORKER_SUFFIX,
    workerCompatibilityDate: "2026-08-18",
    runtimeMaterializer: {
      async materializeRuntimeBindings(request) {
        const requested = [...request.bindings].sort();
        if (
          JSON.stringify(requested) !== JSON.stringify(runtimeNames) ||
          request.request.kind !== "takoserver.stable-local-runtime-materialization@v1"
        ) {
          throw new Error("stable local runtime authority mismatch");
        }
        return { values: structuredClone(input.runtimeValues) };
      },
      async commitRuntimeBindings() {},
      async rollbackRuntimeBindings() {},
    },
    fetch: (request) => cloudflare.fetch(request),
  });
  const driver = localProviderDriver(provider, offerings);
  const standardServiceResolver = {
    async satisfiable({ serviceRef }: { serviceRef: { apiVersion: string; protocol: string } }) {
      return (
        serviceRef.apiVersion === "standards.takoform.com/v1" &&
        serviceRef.protocol === "com.amazonaws.s3"
      );
    },
    async resolve({
      tenantId,
      space: targetSpace,
      slot,
    }: {
      tenantId: string;
      space: string;
      slot: { name: string; service: { apiVersion: string; protocol: string } };
    }) {
      if (
        slot.service.apiVersion !== "standards.takoform.com/v1" ||
        slot.service.protocol !== "com.amazonaws.s3"
      ) {
        return null;
      }
      const bucketName = `tss3-${createHash("sha256")
        .update(`${tenantId}\0${targetSpace}\0${slot.name}`)
        .digest("hex")
        .slice(0, 40)}`;
      cloudflare.registerStandardBucket(bucketName);
      return {
        endpoint: {
          kind: "takoserver.cloudflare-r2-bucket@v1",
          bucketName,
        },
        credential: { kind: "takoserver.cloudflare-r2-binding@v1" },
      };
    },
  };

  let route = async (_request: Request): Promise<Response> =>
    new Response("stable local Host is starting\n", { status: 503 });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: input.port ?? 0,
    fetch: (request) => route(request),
  });
  const endpoint = new URL(server.url).origin;
  const host = createTakoformHost({
    sql,
    objects,
    artifacts,
    forms,
    bindings: catalog.bindings,
    driver,
    standardServiceResolver,
    workerModuleInspector: createJavaScriptWorkerModuleInspector(),
    authenticate: async (request) =>
      request.headers.get("authorization") === `Bearer ${input.token}`
        ? {
            tenantId: "org_stable_local",
            principalId: "provider3_local_e2e",
            scope: {
              mode: "tenant-run" as const,
              space,
              runtimeMaterialization: {
                kind: "takoserver.stable-local-runtime-materialization@v1",
              },
            },
          }
        : null,
  });
  route = async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === STABLE_DISCOVERY_PATH) {
      return Response.json({
        api_versions: ["forms.takoform.com/v1"],
        features: {
          service_forms: true,
          exact_form_ref: true,
          optimistic_concurrency: true,
          idempotent_lifecycle: true,
          operations: true,
          artifact_upload: true,
          support_profiles: true,
        },
        endpoints: { api: `${endpoint}${STABLE_API_PATH}` },
      });
    }
    if (url.pathname === STABLE_API_PATH || url.pathname.startsWith(`${STABLE_API_PATH}/`)) {
      return (await host.handle(request)) ?? notFound();
    }
    return await cloudflare.dispatch(request);
  };

  let closed = false;
  return {
    endpoint,
    diagnosticRuntimeEndpoint: endpoint,
    space,
    classification: "test-only-local-cloudflare-adapter",
    report() {
      return {
        classification: "test-only-local-cloudflare-adapter",
        installedFormKindCount: HOST_FORMS.length,
        resourceGraphCount: 13,
        currentObjectBucketIdentities: 0,
        currentEdgeObjectsReferences: 0,
        resources: cloudflare.resourceCounts(),
      };
    },
    exerciseNativeHandlers: () => cloudflare.exerciseNativeHandlers(),
    async close() {
      if (closed) return;
      closed = true;
      server.stop(true);
      database.close();
      await cloudflare.dispose();
      await rm(dataRoot, { recursive: true, force: true });
    },
  };
}

function localProviderDriver(
  provider: CloudflareProvider,
  offerings: readonly ProviderOffering[],
): TakoformResourceDriver {
  const byKind = new Map(offerings.map((offering) => [offering.form.kind, offering]));
  const deployments = new Map<string, ProviderRelation["deployment"]>();

  const relations = (values: readonly TakoformDriverRelation[]): readonly ProviderRelation[] =>
    values.map((value) => {
      const deployment = deployments.get(value.targetUid);
      return {
        ...structuredClone(value),
        ...(deployment ? { deployment: structuredClone(deployment) } : {}),
      };
    });
  const offering = (form: InstalledTakoformForm): ProviderOffering => {
    const result = byKind.get(form.identity.formRef.kind);
    if (!result || !sameForm(result.form, form.identity.formRef)) {
      throw new TakoformHostError("unsupported_capability", 422);
    }
    return result;
  };
  const intrinsic = (form: InstalledTakoformForm) => INTRINSIC.has(form.identity.formRef.kind);

  const driver: TakoformResourceDriver = {
    async apply(value) {
      if (intrinsic(value.form)) return { observed: structuredClone(value.spec) };
      const selected = offering(value.form);
      const current = deployments.get(value.resourceUid);
      const result = ticketResult(
        await provider.apply({
          operationId: value.operationId,
          offering: selected,
          identity: {
            tenantRef: value.tenantId,
            space: value.space,
            name: value.name,
          },
          spec: value.spec,
          relations: relations(value.relations),
          ...(value.runtimeMaterialization
            ? { runtimeMaterialization: value.runtimeMaterialization }
            : {}),
          ...(value.standardServices
            ? { standardServices: structuredClone(value.standardServices) }
            : {}),
          ...(current
            ? {
                previous: {
                  nativeId: current.nativeId,
                  spec: value.previous?.spec ?? value.spec,
                },
              }
            : {}),
        }),
      );
      const timestamp = new Date().toISOString();
      deployments.set(value.resourceUid, {
        tenantId: value.tenantId,
        id: `dep_${value.operationId}`,
        resourceUid: value.resourceUid,
        offeringId: selected.id,
        providerPackRef: provider.id,
        providerInstallationRef: "cloudflare.stable-local",
        nativeId: result.nativeId,
        state: "active",
        observed: structuredClone(result.observed),
        outputs: structuredClone(result.outputs),
        createdAt: current?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
      return { observed: result.observed, outputs: result.outputs };
    },
    async observe(value) {
      if (INTRINSIC.has(value.resource.form.formRef.kind)) {
        return {
          observed: structuredClone(value.resource.status.observed ?? value.resource.spec),
          ...(value.resource.status.outputs
            ? { outputs: structuredClone(value.resource.status.outputs) }
            : {}),
        };
      }
      const current = deployments.get(value.resourceUid);
      if (!current) throw new TakoformHostError("resource_not_found", 404);
      const selected = byKind.get(value.resource.form.formRef.kind);
      if (!selected) throw new TakoformHostError("unsupported_capability", 422);
      const result = ticketResult(
        await provider.observe({
          offering: selected,
          nativeId: current.nativeId,
          spec: value.resource.spec,
        }),
      );
      return { observed: result.observed, outputs: result.outputs };
    },
    async delete(value) {
      if (INTRINSIC.has(value.resource.form.formRef.kind)) return;
      const current = deployments.get(value.resourceUid);
      if (!current) return;
      const selected = byKind.get(value.resource.form.formRef.kind);
      if (!selected) throw new TakoformHostError("unsupported_capability", 422);
      ticketResult(
        await provider.delete({
          operationId: value.operationId,
          offering: selected,
          nativeId: current.nativeId,
          identity: {
            tenantRef: value.tenantId,
            space: value.resource.metadata.space,
            name: value.resource.metadata.name,
          },
          spec: value.resource.spec,
        }),
      );
      deployments.delete(value.resourceUid);
    },
    sqliteMigrations: {
      async readLedger({ database }) {
        const current = deployments.get(database.metadata.uid);
        if (!current) throw new TakoformHostError("resource_not_found", 404);
        const result = await provider.sqliteMigrations.readLedger({
          nativeId: current.nativeId,
        });
        if (!result.ok) throw providerFailure(result.failure.code);
        return result.value;
      },
      async applySuffix({ database, expectedPrefix, migrations }) {
        const current = deployments.get(database.metadata.uid);
        if (!current) throw new TakoformHostError("resource_not_found", 404);
        const result = await provider.sqliteMigrations.applySuffix({
          nativeId: current.nativeId,
          expectedPrefix,
          migrations,
        });
        if (!result.ok) throw providerFailure(result.failure.code);
      },
    },
  };
  return driver;
}

function technicalOffering(form: InstalledTakoformForm): ProviderOffering {
  return {
    id: `stable.local.${form.identity.formRef.kind.toLowerCase()}`,
    kind: `takoform.${form.identity.formRef.kind}`,
    displayName: form.displayName ?? form.identity.formRef.kind,
    form: structuredClone(form.identity.formRef),
    providedInterfaces: structuredClone(form.providedInterfaces ?? []),
    bindingRefs: structuredClone(form.acceptedBindings ?? []),
    capabilities: form.operations.filter(
      (operation): operation is ProviderOffering["capabilities"][number] =>
        operation === "create" ||
        operation === "update" ||
        operation === "delete" ||
        operation === "import" ||
        operation === "observe",
    ),
  };
}

function exactForm(
  forms: readonly InstalledTakoformForm[],
  kind: (typeof HOST_FORMS)[number],
): InstalledTakoformForm {
  const matches = forms.filter(
    (form) =>
      form.identity.formRef.apiVersion === "edge.forms.takoform.com" &&
      form.identity.formRef.kind === kind,
  );
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(`stable local Form missing: ${kind}`);
  }
  return matches[0];
}

function sameForm(left: ProviderOffering["form"], right: ProviderOffering["form"]): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.kind === right.kind &&
    left.definitionVersion === right.definitionVersion &&
    left.schemaDigest === right.schemaDigest
  );
}

function ticketResult(ticket: ProviderTicket): ProviderResult {
  if (ticket.phase === "succeeded") return ticket.result;
  if (ticket.phase === "running") {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  throw providerFailure(ticket.failure.code);
}

function providerFailure(code: string): TakoformHostError {
  switch (code) {
    case "invalid_spec":
      return new TakoformHostError("invalid_argument", 400);
    case "conflict":
      return new TakoformHostError("resource_busy", 409);
    case "not_found":
      return new TakoformHostError("resource_not_found", 404);
    default:
      return new TakoformHostError("backend_unavailable", 503);
  }
}

interface LocalAssetDeclaration {
  readonly hash: string;
  readonly size: number;
}

interface LocalAssetSession {
  readonly script: string;
  readonly manifest: Readonly<Record<string, LocalAssetDeclaration>>;
  readonly missing: ReadonlySet<string>;
}

interface LocalVersionAssets {
  readonly manifest: Readonly<Record<string, LocalAssetDeclaration>>;
  readonly config: {
    readonly htmlHandling?:
      | "auto-trailing-slash"
      | "drop-trailing-slash"
      | "force-trailing-slash"
      | "none";
    readonly notFoundHandling?: "none" | "single-page-application" | "404-page";
    readonly runWorkerFirst?: boolean;
  };
}

class LocalCloudflare {
  runtime: Miniflare | undefined;
  readonly #root: string;
  readonly #buckets = new Set<string>();
  readonly #scripts = new Set<string>();
  readonly #databases = new Map<string, string>();
  readonly #kvNamespaces = new Map<string, string>();
  readonly #queues = new Map<string, string>();
  readonly #consumers = new Map<
    string,
    {
      queueId: string;
      scriptName: string;
      maxBatchSize?: number;
      maxBatchTimeout?: number;
      maxRetries?: number;
      deadLetterQueue?: string;
      retryDelay?: number;
    }
  >();
  readonly #schedules = new Map<string, string[]>();
  readonly #migrationSql: string[] = [];
  readonly #migrationLedger = new Map<
    string,
    { sequence: number; path: string; digest: string }[]
  >();
  readonly #versions = new Map<
    string,
    {
      metadata: Record<string, unknown>;
      modules: Map<string, Uint8Array>;
      assets?: LocalVersionAssets;
    }
  >();
  readonly #assetBlobs = new Map<string, Uint8Array>();
  readonly #assetSessions = new Map<string, LocalAssetSession>();
  readonly #deployments = new Map<string, { script: string; version: string }>();
  #active: { script: string; version: string } | undefined;
  #nextVersion = 1;
  #nextDeployment = 1;
  #nextDatabase = 1;
  #nextNamespace = 1;
  #nextQueue = 1;
  #nextConsumer = 1;
  #nextAssetSession = 1;
  #runtimeMigrationsApplied = false;
  #runtimeTriggerCounts = { queue: 0, scheduled: 0 };

  constructor(root: string) {
    this.#root = root;
  }

  registerStandardBucket(name: string): void {
    this.#buckets.add(name);
  }

  resourceCounts(): Readonly<Record<string, number>> {
    return Object.freeze({
      buckets: this.#buckets.size,
      scripts: this.#scripts.size,
      databases: this.#databases.size,
      kvNamespaces: this.#kvNamespaces.size,
      queues: this.#queues.size,
      consumers: this.#consumers.size,
      deployments: this.#deployments.size,
      schedules: [...this.#schedules.values()].reduce((total, values) => total + values.length, 0),
      activeRuntimes: this.runtime ? 1 : 0,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/client\/v4/u, "");
    if (request.method === "POST" && path === `/accounts/${ACCOUNT_ID}/workers/assets/upload`) {
      return await this.#uploadAssets(request);
    }
    if (request.headers.get("authorization") !== "Bearer local-cloudflare-authority") {
      return envelope(undefined, 403, [{ code: 9109 }]);
    }
    let match: RegExpExecArray | null;

    if (request.method === "POST" && path === `/accounts/${ACCOUNT_ID}/d1/database`) {
      const body = (await request.json()) as { name?: string };
      if (!body.name) return envelope(undefined, 400);
      const id = `database-${this.#nextDatabase++}`;
      this.#databases.set(id, body.name);
      return envelope({ uuid: id, name: body.name });
    }
    match = new RegExp(`^/accounts/${ACCOUNT_ID}/d1/database/([^/]+)$`, "u").exec(path);
    if (match && request.method === "GET") {
      const id = decoded(match, 1);
      const name = this.#databases.get(id);
      return name ? envelope({ uuid: id, name }) : envelope(undefined, 404);
    }
    if (match && request.method === "DELETE") {
      const id = decoded(match, 1);
      this.#migrationLedger.delete(id);
      return this.#databases.delete(id) ? envelope({}) : envelope(undefined, 404);
    }
    match = new RegExp(`^/accounts/${ACCOUNT_ID}/d1/database/([^/]+)/query$`, "u").exec(path);
    if (match && request.method === "POST") {
      return await this.#d1Query(decoded(match, 1), request);
    }

    if (request.method === "POST" && path === `/accounts/${ACCOUNT_ID}/storage/kv/namespaces`) {
      const body = (await request.json()) as { title?: string };
      if (!body.title) return envelope(undefined, 400);
      const id = `namespace-${this.#nextNamespace++}`;
      this.#kvNamespaces.set(id, body.title);
      return envelope({ id, title: body.title });
    }
    match = new RegExp(`^/accounts/${ACCOUNT_ID}/storage/kv/namespaces/([^/]+)$`, "u").exec(path);
    if (match && request.method === "GET") {
      const id = decoded(match, 1);
      const title = this.#kvNamespaces.get(id);
      return title ? envelope({ id, title }) : envelope(undefined, 404);
    }
    if (match && request.method === "DELETE") {
      return this.#kvNamespaces.delete(decoded(match, 1)) ? envelope({}) : envelope(undefined, 404);
    }

    if (request.method === "POST" && path === `/accounts/${ACCOUNT_ID}/queues`) {
      const body = (await request.json()) as { queue_name?: string };
      if (!body.queue_name) return envelope(undefined, 400);
      const id = `queue-${this.#nextQueue++}`;
      this.#queues.set(id, body.queue_name);
      return envelope({ queue_id: id, queue_name: body.queue_name });
    }
    match = new RegExp(`^/accounts/${ACCOUNT_ID}/queues/([^/]+)$`, "u").exec(path);
    if (match && request.method === "GET") {
      const id = decoded(match, 1);
      const queueName = this.#queues.get(id);
      return queueName
        ? envelope({ queue_id: id, queue_name: queueName })
        : envelope(undefined, 404);
    }
    if (match && request.method === "DELETE") {
      return this.#queues.delete(decoded(match, 1)) ? envelope({}) : envelope(undefined, 404);
    }
    match = new RegExp(`^/accounts/${ACCOUNT_ID}/queues/([^/]+)/consumers$`, "u").exec(path);
    if (match && request.method === "POST") {
      const queueId = decoded(match, 1);
      const body = (await request.json()) as {
        script_name?: string;
        settings?: {
          batch_size?: number;
          max_wait_time_ms?: number;
          max_retries?: number;
          retry_delay?: number;
        };
        dead_letter_queue?: string;
      };
      if (!this.#queues.has(queueId) || !body.script_name) {
        return envelope(undefined, 400);
      }
      const id = `consumer-${this.#nextConsumer++}`;
      this.#consumers.set(id, {
        queueId,
        scriptName: body.script_name,
        ...(body.settings?.batch_size !== undefined
          ? { maxBatchSize: body.settings.batch_size }
          : {}),
        ...(body.settings?.max_wait_time_ms !== undefined
          ? { maxBatchTimeout: body.settings.max_wait_time_ms / 1_000 }
          : {}),
        ...(body.settings?.max_retries !== undefined
          ? { maxRetries: body.settings.max_retries }
          : {}),
        ...(body.settings?.retry_delay !== undefined
          ? { retryDelay: body.settings.retry_delay }
          : {}),
        ...(body.dead_letter_queue ? { deadLetterQueue: body.dead_letter_queue } : {}),
      });
      return envelope({ consumer_id: id });
    }
    match = new RegExp(`^/accounts/${ACCOUNT_ID}/queues/([^/]+)/consumers/([^/]+)$`, "u").exec(
      path,
    );
    if (match && request.method === "GET") {
      const queueId = decoded(match, 1);
      const id = decoded(match, 2);
      const consumer = this.#consumers.get(id);
      return consumer?.queueId === queueId
        ? envelope({ consumer_id: id, script_name: consumer.scriptName })
        : envelope(undefined, 404);
    }
    if (match && request.method === "DELETE") {
      const queueId = decoded(match, 1);
      const id = decoded(match, 2);
      const consumer = this.#consumers.get(id);
      if (consumer?.queueId !== queueId) return envelope(undefined, 404);
      this.#consumers.delete(id);
      return envelope({});
    }

    match = new RegExp(`^/accounts/${ACCOUNT_ID}/workers/scripts/([^/]+)$`, "u").exec(path);
    if (match && request.method === "PUT") {
      this.#scripts.add(decoded(match, 1));
      return envelope({});
    }
    if (match && request.method === "GET") {
      return this.#scripts.has(decoded(match, 1)) ? envelope({}) : envelope(undefined, 404);
    }
    if (match && request.method === "DELETE") {
      const script = decoded(match, 1);
      this.#scripts.delete(script);
      for (const key of [...this.#versions.keys()]) {
        if (key.startsWith(`${script}:`)) this.#versions.delete(key);
      }
      for (const [id, deployment] of this.#deployments) {
        if (deployment.script === script) this.#deployments.delete(id);
      }
      this.#schedules.delete(script);
      if (this.#active?.script === script) {
        await this.runtime?.dispose();
        this.runtime = undefined;
        this.#active = undefined;
      }
      return envelope({});
    }

    match = new RegExp(
      `^/accounts/${ACCOUNT_ID}/workers/scripts/([^/]+)/assets-upload-session$`,
      "u",
    ).exec(path);
    if (match && request.method === "POST") {
      return await this.#startAssetSession(decoded(match, 1), request);
    }

    match = new RegExp(`^/accounts/${ACCOUNT_ID}/workers/scripts/([^/]+)/versions$`, "u").exec(
      path,
    );
    if (match && request.method === "GET") {
      const script = decoded(match, 1);
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "20");
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        !Number.isSafeInteger(perPage) ||
        perPage < 1 ||
        perPage > 100
      ) {
        return envelope(undefined, 400);
      }
      const versionIds = [...this.#versions.keys()]
        .filter((key) => key.startsWith(`${script}:`))
        .map((key) => key.slice(script.length + 1))
        .reverse();
      const offset = (page - 1) * perPage;
      const items = versionIds.slice(offset, offset + perPage).map((id) => ({ id }));
      return envelope({ items }, 200, [], {
        page,
        per_page: perPage,
        count: items.length,
        total_count: versionIds.length,
        total_pages: Math.ceil(versionIds.length / perPage),
      });
    }
    if (match && request.method === "POST") {
      return await this.#createVersion(decoded(match, 1), request);
    }
    match = new RegExp(
      `^/accounts/${ACCOUNT_ID}/workers/scripts/([^/]+)/versions/([^/]+)$`,
      "u",
    ).exec(path);
    if (match && request.method === "GET") {
      const id = decoded(match, 2);
      const held = this.#versions.get(`${decoded(match, 1)}:${id}`);
      return held
        ? envelope({
            id,
            ...(held.metadata.annotations !== undefined
              ? { annotations: structuredClone(held.metadata.annotations) }
              : {}),
          })
        : envelope(undefined, 404);
    }

    match = new RegExp(`^/accounts/${ACCOUNT_ID}/workers/scripts/([^/]+)/deployments$`, "u").exec(
      path,
    );
    if (match && request.method === "POST") {
      const script = decoded(match, 1);
      const body = (await request.json()) as {
        versions?: { version_id?: string }[];
      };
      const version = body.versions?.[0]?.version_id;
      if (!version || !this.#versions.has(`${script}:${version}`)) {
        return envelope(undefined, 400);
      }
      const id = `deployment-${this.#nextDeployment++}`;
      this.#deployments.set(id, { script, version });
      this.#active = { script, version };
      return envelope({ id });
    }
    match = new RegExp(
      `^/accounts/${ACCOUNT_ID}/workers/scripts/([^/]+)/deployments/([^/]+)$`,
      "u",
    ).exec(path);
    if (match && request.method === "GET") {
      return this.#deployments.has(decoded(match, 2))
        ? envelope({ id: match[2] })
        : envelope(undefined, 404);
    }
    if (match && request.method === "DELETE") {
      return this.#deployments.delete(decoded(match, 2)) ? envelope({}) : envelope(undefined, 404);
    }

    match = new RegExp(`^/accounts/${ACCOUNT_ID}/workers/scripts/([^/]+)/subdomain$`, "u").exec(
      path,
    );
    if (match && request.method === "POST") {
      const script = decoded(match, 1);
      if (!this.#active || this.#active.script !== script) {
        return envelope(undefined, 400);
      }
      await this.#startRuntime(this.#active.script, this.#active.version);
      return envelope({ enabled: true });
    }
    if (match && request.method === "GET") {
      return this.runtime ? envelope({ enabled: true }) : envelope(undefined, 404);
    }
    if (match && request.method === "DELETE") {
      await this.runtime?.dispose();
      this.runtime = undefined;
      return envelope({ enabled: false });
    }

    match = new RegExp(`^/accounts/${ACCOUNT_ID}/workers/scripts/([^/]+)/schedules$`, "u").exec(
      path,
    );
    if (match && request.method === "GET") {
      return envelope((this.#schedules.get(decoded(match, 1)) ?? []).map((cron) => ({ cron })));
    }
    if (match && request.method === "PUT") {
      const body = (await request.json()) as { cron?: string }[];
      if (!Array.isArray(body) || body.some((entry) => typeof entry.cron !== "string")) {
        return envelope(undefined, 400);
      }
      this.#schedules.set(
        decoded(match, 1),
        body.map((entry) => entry.cron ?? ""),
      );
      return envelope(body);
    }
    return envelope(undefined, 404);
  }

  async dispatch(request: Request): Promise<Response> {
    if (!this.runtime) {
      return new Response("stable local Worker is not deployed\n", {
        status: 409,
      });
    }
    return (await this.runtime.dispatchFetch(request as never)) as unknown as Response;
  }

  async exerciseNativeHandlers(): Promise<{
    queueHandlerInvocations: number;
    scheduledHandlerInvocations: number;
  }> {
    if (!this.runtime || !this.#active) {
      throw new Error("stable local Worker is not deployed");
    }
    await this.#startRuntime(this.#active.script, this.#active.version);
    if (this.#runtimeTriggerCounts.queue !== 1 || this.#runtimeTriggerCounts.scheduled !== 1) {
      throw new Error(
        `native handler triggers are incomplete: ${JSON.stringify(this.#runtimeTriggerCounts)}`,
      );
    }
    const producer = await this.runtime.getQueueProducer(
      "DELIVERY_QUEUE",
      "yurucommu-stable-local",
    );
    await producer.send({ kind: "stable-local-invalid-probe" });
    await this.runtime.dispatchFetch(
      new Request("http://stable-local.invalid/cdn-cgi/local/scheduled?cron=0+*+*+*+*") as never,
    );
    const deadline = Date.now() + 8_000;
    let lastReport: {
      queueHandlerInvocations?: number;
      scheduledHandlerInvocations?: number;
      queueHandlerAttempts?: number;
      queueHandlerError?: string | null;
      queueIdentity?: unknown;
    } = {};
    while (Date.now() < deadline) {
      const response = (await this.runtime.dispatchFetch(
        new Request("http://stable-local.invalid/__stable_local_runtime_report") as never,
      )) as unknown as Response;
      const report = (await response.json()) as {
        queueHandlerInvocations?: number;
        scheduledHandlerInvocations?: number;
        queueHandlerAttempts?: number;
        queueHandlerError?: string | null;
        queueIdentity?: unknown;
      };
      lastReport = report;
      if (report.queueHandlerInvocations === 1 && report.scheduledHandlerInvocations === 1) {
        return {
          queueHandlerInvocations: 1,
          scheduledHandlerInvocations: 1,
        };
      }
      await Bun.sleep(25);
    }
    throw new Error(
      `native queue/scheduled handlers did not complete: ${JSON.stringify({ lastReport, triggers: this.#runtimeTriggerCounts })}`,
    );
  }

  async dispose(): Promise<void> {
    await this.runtime?.dispose();
    this.runtime = undefined;
  }

  async #d1Query(id: string, request: Request): Promise<Response> {
    if (!this.#databases.has(id)) return envelope(undefined, 404);
    const body = (await request.json()) as {
      sql?: string;
      batch?: { sql?: string; params?: unknown[] }[];
    };
    if (typeof body.sql === "string") {
      const ledger = this.#migrationLedger.get(id) ?? [];
      const results = body.sql.includes("sqlite_master")
        ? ledger.length > 0
          ? [{ name: "_takoform_sqlite_migrations" }]
          : []
        : body.sql.includes("SELECT sequence, path, digest")
          ? ledger
          : [];
      return envelope([{ success: true, results }]);
    }
    if (!Array.isArray(body.batch)) return envelope(undefined, 400);
    for (const statement of body.batch) {
      if (
        statement.sql?.includes(
          "INSERT INTO _takoform_sqlite_migrations (sequence, path, digest) VALUES",
        ) &&
        Array.isArray(statement.params) &&
        typeof statement.params[0] === "number" &&
        typeof statement.params[1] === "string" &&
        typeof statement.params[2] === "string"
      ) {
        const ledger = this.#migrationLedger.get(id) ?? [];
        ledger.push({
          sequence: statement.params[0],
          path: statement.params[1],
          digest: statement.params[2],
        });
        this.#migrationLedger.set(id, ledger);
      }
      const sql = stripSqlComments(statement.sql ?? "").trim();
      if (
        sql.length > 0 &&
        statement.params === undefined &&
        !sql.includes("_takoform_sqlite_migrations")
      ) {
        this.#migrationSql.push(sql);
      }
    }
    return envelope(body.batch.map(() => ({ success: true, results: [] })));
  }

  async #startAssetSession(script: string, request: Request): Promise<Response> {
    if (!this.#scripts.has(script)) return envelope(undefined, 404);
    const body = (await request.json()) as { manifest?: unknown };
    const manifest = localAssetManifest(body.manifest);
    if (!manifest) return envelope(undefined, 400);
    const token = `asset-session-${this.#nextAssetSession++}`;
    const missing = new Set(
      [...new Set(Object.values(manifest).map((declaration) => declaration.hash))].filter(
        (hash) => !this.#assetBlobs.has(hash),
      ),
    );
    this.#assetSessions.set(token, { script, manifest, missing });
    return envelope({
      jwt: token,
      buckets: missing.size > 0 ? [[...missing].sort()] : [],
    });
  }

  async #uploadAssets(request: Request): Promise<Response> {
    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
    const session = this.#assetSessions.get(token);
    if (!session) return envelope(undefined, 403, [{ code: 9109 }]);
    const form = await request.formData();
    const received = new Set<string>();
    for (const [hash, value] of form.entries()) {
      if (typeof value === "string" || received.has(hash) || !session.missing.has(hash)) {
        return envelope(undefined, 400);
      }
      const encoded = await (value as unknown as { text(): Promise<string> }).text();
      const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
      const declarations = Object.values(session.manifest).filter(
        (declaration) => declaration.hash === hash,
      );
      if (
        declarations.length === 0 ||
        declarations.some((declaration) => declaration.size !== bytes.byteLength) ||
        createHash("sha256").update(bytes).digest("hex").slice(0, 32) !== hash
      ) {
        return envelope(undefined, 400);
      }
      received.add(hash);
      this.#assetBlobs.set(hash, bytes);
    }
    if ([...session.missing].some((hash) => !this.#assetBlobs.has(hash))) {
      return envelope(undefined, 400);
    }
    return envelope({ jwt: token });
  }

  async #createVersion(script: string, request: Request): Promise<Response> {
    const form = await request.formData();
    const metadataPart = form.get("metadata");
    if (metadataPart === null) return envelope(undefined, 400);
    const metadata = JSON.parse(
      typeof metadataPart === "string" ? metadataPart : await metadataPart.text(),
    ) as Record<string, unknown>;
    const assets = localVersionAssets(
      metadata.assets,
      script,
      this.#assetSessions,
      this.#assetBlobs,
    );
    if (metadata.assets !== undefined && !assets) return envelope(undefined, 400);
    const modules = new Map<string, Uint8Array>();
    for (const [name, value] of form.entries()) {
      if (name === "metadata" || typeof value === "string") continue;
      const bytes = await (
        value as unknown as { arrayBuffer(): Promise<ArrayBuffer> }
      ).arrayBuffer();
      modules.set(name, new Uint8Array(bytes));
    }
    const id = `version-${this.#nextVersion++}`;
    this.#versions.set(`${script}:${id}`, { metadata, modules, ...(assets ? { assets } : {}) });
    return envelope({ id });
  }

  async #startRuntime(script: string, version: string): Promise<void> {
    const held = this.#versions.get(`${script}:${version}`);
    if (!held) throw new Error("deployed version vanished");
    await this.runtime?.dispose();
    const env: Record<string, unknown> = {};
    const bindings = Array.isArray(held.metadata.bindings) ? held.metadata.bindings : [];
    for (const raw of bindings) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const binding = raw as Record<string, unknown>;
      const name = typeof binding.name === "string" ? binding.name : undefined;
      if (!name) continue;
      if (binding.type === "plain_text" || binding.type === "secret_text") {
        env[name] = { type: "text", value: binding.text };
      } else if (binding.type === "json") {
        env[name] = { type: "json", value: binding.json };
      } else if (binding.type === "r2_bucket") {
        env[name] = { type: "r2", name: binding.bucket_name };
      } else if (binding.type === "d1") {
        env[name] = { type: "d1", id: binding.id };
      } else if (binding.type === "kv_namespace") {
        env[name] = { type: "kv", id: binding.namespace_id };
      } else if (binding.type === "queue") {
        env[name] = { type: "queue", name: binding.queue_name };
      } else if (binding.type === "assets") {
        env[name] = { type: "assets" };
      }
    }
    const assetsDirectory = held.assets
      ? await this.#materializeAssets(script, version, held.assets.manifest)
      : undefined;
    const publicOrigin = `https://${script}.${WORKER_SUFFIX}`;
    const modules: Record<string, { type: "esm"; contents: string | Uint8Array }> =
      Object.fromEntries(
        [...held.modules].map(([path, contents]) => [path, { type: "esm", contents }]),
      );
    const mainModule = String(held.metadata.main_module ?? "");
    const released = modules[mainModule];
    if (!mainModule || !released) throw new Error("released Worker main module is missing");
    const releasedModuleName = ["__stable", "local", "released"].join("_");
    modules[releasedModuleName] = released;
    modules[mainModule] = {
      type: "esm",
      contents: `import worker from ${JSON.stringify(`./${releasedModuleName}`)};
let queueHandlerInvocations = 0;
let scheduledHandlerInvocations = 0;
let queueHandlerAttempts = 0;
let queueHandlerError = null;
let queueIdentity = null;
export default {
  async fetch(request, env, context) {
    const local = new URL(request.url);
    if (local.pathname === "/__stable_local_runtime_report") {
      return Response.json({
        queueHandlerInvocations,
        scheduledHandlerInvocations,
        queueHandlerAttempts,
        queueHandlerError,
        queueIdentity,
      });
    }
    return worker.fetch(new Request(new URL(local.pathname + local.search, ${JSON.stringify(
      `${publicOrigin}/`,
    )}), request), env, context);
  },
  async queue(batch, env, context) {
    if (typeof worker.queue !== "function") return;
    queueHandlerAttempts += 1;
    queueIdentity = {
      batch: batch.queue,
      delivery: env.DELIVERY_QUEUE_NAME,
      deadLetter: env.DELIVERY_DLQ_NAME,
    };
    try {
      await worker.queue(batch, env, context);
      queueHandlerInvocations += 1;
    } catch (error) {
      queueHandlerError = String(error?.stack ?? error);
      throw error;
    }
  },
  async scheduled(controller, env, context) {
    if (typeof worker.scheduled !== "function") return;
    await worker.scheduled(controller, env, context);
    scheduledHandlerInvocations += 1;
  }
};`,
    };
    const triggers = [
      ...[...this.#consumers.values()]
        .filter((consumer) => consumer.scriptName === script)
        .map((consumer) => ({
          type: "queue" as const,
          name: this.#queues.get(consumer.queueId) ?? consumer.queueId,
          ...(consumer.maxBatchSize !== undefined ? { maxBatchSize: consumer.maxBatchSize } : {}),
          ...(consumer.maxBatchTimeout !== undefined
            ? { maxBatchTimeout: consumer.maxBatchTimeout }
            : {}),
          ...(consumer.maxRetries !== undefined ? { maxRetries: consumer.maxRetries } : {}),
          ...(consumer.deadLetterQueue ? { deadLetterQueue: consumer.deadLetterQueue } : {}),
          ...(consumer.retryDelay !== undefined ? { retryDelay: consumer.retryDelay } : {}),
        })),
      ...(this.#schedules.get(script) ?? []).map((schedule) => ({
        type: "scheduled" as const,
        schedule,
      })),
    ];
    this.#runtimeTriggerCounts = {
      queue: triggers.filter((trigger) => trigger.type === "queue").length,
      scheduled: triggers.filter((trigger) => trigger.type === "scheduled").length,
    };
    this.runtime = new Miniflare({
      resourcePersistencePath: this.#root,
      unsafeTriggerHandlers: true,
      workers: [
        {
          config: {
            name: "yurucommu-stable-local",
            type: "worker",
            compatibilityDate: "2026-08-18",
            manifest: { mainModule, modules },
            env,
            triggers,
            ...(assetsDirectory && held.assets
              ? {
                  assets: {
                    directory: assetsDirectory,
                    hasUserWorker: true,
                    ...held.assets.config,
                  },
                }
              : {}),
          },
        },
      ],
    });
    await this.runtime.ready;
    if (!this.#runtimeMigrationsApplied && this.#migrationSql.length > 0 && "DB" in env) {
      const database = await this.runtime.getD1Database("DB");
      for (const sql of this.#migrationSql) {
        for (const statement of splitD1Statements(sql)) {
          await database.prepare(statement).run();
        }
      }
      this.#runtimeMigrationsApplied = true;
    }
  }

  async #materializeAssets(
    script: string,
    version: string,
    manifest: Readonly<Record<string, LocalAssetDeclaration>>,
  ): Promise<string> {
    const directory = join(
      this.#root,
      "assets",
      createHash("sha256").update(`${script}\0${version}`).digest("hex"),
    );
    await rm(directory, { recursive: true, force: true });
    for (const [path, declaration] of Object.entries(manifest)) {
      const relative = localAssetPath(path);
      const bytes = this.#assetBlobs.get(declaration.hash);
      if (!relative || !bytes || bytes.byteLength !== declaration.size) {
        throw new Error("stable local asset session is incomplete");
      }
      const destination = join(directory, relative);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    return directory;
  }
}

function localAssetManifest(
  value: unknown,
): Readonly<Record<string, LocalAssetDeclaration>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 20_000) return null;
  const manifest: Record<string, LocalAssetDeclaration> = {};
  for (const [path, candidate] of entries) {
    if (
      !localAssetPath(path) ||
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      return null;
    }
    const declaration = candidate as Record<string, unknown>;
    if (
      JSON.stringify(Object.keys(declaration).sort()) !== JSON.stringify(["hash", "size"]) ||
      typeof declaration.hash !== "string" ||
      !/^[0-9a-f]{32}$/u.test(declaration.hash) ||
      !Number.isSafeInteger(declaration.size) ||
      (declaration.size as number) < 0 ||
      (declaration.size as number) > 268_435_456
    ) {
      return null;
    }
    manifest[path] = {
      hash: declaration.hash,
      size: declaration.size as number,
    };
  }
  return Object.freeze(manifest);
}

function localAssetPath(path: string): string | null {
  if (!path.startsWith("/") || path.length < 2 || path.length > 241) return null;
  const relative = path.slice(1);
  if (
    !/^[A-Za-z0-9_.][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_.][A-Za-z0-9._-]*)*$/u.test(relative) ||
    relative.split("/").some((part) => part === "." || part === "..")
  ) {
    return null;
  }
  return relative;
}

function localVersionAssets(
  value: unknown,
  script: string,
  sessions: ReadonlyMap<string, LocalAssetSession>,
  blobs: ReadonlyMap<string, Uint8Array>,
): LocalVersionAssets | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const token = typeof record.jwt === "string" ? record.jwt : "";
  const session = sessions.get(token);
  if (
    !session ||
    session.script !== script ||
    [...session.missing].some((hash) => !blobs.has(hash))
  ) {
    return null;
  }
  if (!record.config || typeof record.config !== "object" || Array.isArray(record.config)) {
    return null;
  }
  const raw = record.config as Record<string, unknown>;
  const htmlHandling = raw.html_handling;
  const notFoundHandling = raw.not_found_handling;
  const runWorkerFirst = raw.run_worker_first;
  if (
    (htmlHandling !== undefined &&
      htmlHandling !== "auto-trailing-slash" &&
      htmlHandling !== "drop-trailing-slash" &&
      htmlHandling !== "force-trailing-slash" &&
      htmlHandling !== "none") ||
    (notFoundHandling !== undefined &&
      notFoundHandling !== "none" &&
      notFoundHandling !== "single-page-application" &&
      notFoundHandling !== "404-page") ||
    (runWorkerFirst !== undefined && typeof runWorkerFirst !== "boolean")
  ) {
    return null;
  }
  return {
    manifest: session.manifest,
    config: {
      ...(htmlHandling !== undefined ? { htmlHandling } : {}),
      ...(notFoundHandling !== undefined ? { notFoundHandling } : {}),
      ...(runWorkerFirst !== undefined ? { runWorkerFirst } : {}),
    },
  };
}

function stripSqlComments(value: string): string {
  return value.replace(/--[^\n\r]*/gu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
}

function splitD1Statements(value: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | "]" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    current += character;
    if (quote) {
      if (quote === "]") {
        if (character === "]") quote = undefined;
        continue;
      }
      if (character !== quote) continue;
      if (value[index + 1] === quote) {
        current += value.charAt(++index);
        continue;
      }
      quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "[") {
      quote = "]";
      continue;
    }
    if (character !== ";") continue;
    const normalized = current.trim();
    if (normalized.toUpperCase().startsWith("CREATE TRIGGER") && !/\bEND;$/iu.test(normalized)) {
      continue;
    }
    if (normalized.length > 1) statements.push(normalized);
    current = "";
  }
  const trailing = current.trim();
  if (trailing.length > 0) statements.push(trailing);
  return statements;
}

function decoded(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined || value.length === 0) {
    throw new Error("stable local Cloudflare route capture is missing");
  }
  return decodeURIComponent(value);
}

function envelope(
  result?: unknown,
  status = 200,
  errors: unknown[] = [],
  resultInfo?: Readonly<Record<string, unknown>>,
): Response {
  return Response.json(
    status >= 200 && status < 300
      ? {
          success: true,
          result,
          ...(resultInfo ? { result_info: resultInfo } : {}),
        }
      : { success: false, errors },
    { status },
  );
}

function notFound(): Response {
  return Response.json(
    {
      error: {
        code: "not_found",
        message: "not found",
        requestId: "req_local",
      },
    },
    { status: 404 },
  );
}
