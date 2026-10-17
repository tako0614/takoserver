import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../src/json.ts";
import { EDGE_KV_NAMESPACE_FORM_URL } from "../src/takoform-v2/forms/edge-kv-namespace.ts";
import { OBJECT_BUCKET_FORM_URL } from "../src/takoform-v2/forms/object-bucket.ts";
import { SQLITE_DATABASE_FORM_URL } from "../src/takoform-v2/forms/sqlite-database.ts";
import { SQLITE_MIGRATION_APPLICATION_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-application.ts";
import {
  parseSQLiteMigrationSetSpec,
  SQLITE_MIGRATION_SET_FORM_URL,
  type SQLiteMigrationManifestFile,
  validateSQLiteMigrationPayload,
} from "../src/takoform-v2/forms/sqlite-migration-set.ts";
import {
  parseStaticAssetBundleSpec,
  STATIC_ASSET_BUNDLE_FORM_URL,
  validateStaticAssetBundlePayload,
} from "../src/takoform-v2/forms/static-asset-bundle.ts";
import {
  parseWorkerBundleSpec,
  validateWorkerBundlePayload,
  WORKER_BUNDLE_FORM_URL,
  type WorkerBundleManifestFile,
} from "../src/takoform-v2/forms/worker-bundle.ts";
import { WORKER_CRON_TRIGGER_FORM_URL } from "../src/takoform-v2/forms/worker-cron-trigger.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseWorkerVersionSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
  type WorkerVersionSpec,
} from "../src/takoform-v2/forms/worker-specs.ts";

export const WFP_HOSTED_SAMPLE_FIXTURE_KIND =
  "takoserver.wfp-hosted-staging-sample-fixture@v2" as const;
export const WFP_HOSTED_SAMPLE_EVIDENCE_KIND =
  "takoserver.wfp-hosted-staging-e2e-evidence@v1" as const;

export const WFP_HOSTED_SAMPLE_E2E_FORMS = [
  MODULE_WORKER_FORM_URL,
  SQLITE_DATABASE_FORM_URL,
  SQLITE_MIGRATION_APPLICATION_FORM_URL,
  EDGE_KV_NAMESPACE_FORM_URL,
  OBJECT_BUCKET_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
  WORKER_CRON_TRIGGER_FORM_URL,
  STATIC_ASSET_BUNDLE_FORM_URL,
] as const;

const ORIGIN_RESERVATION_FORMAT = "takoserver.worker-endpoint-origin-reservation.v2";
const ORIGIN_RESERVATION_TTL_SECONDS = 86_400;
const DEFAULT_POLL_SECONDS = 300;
const DEFAULT_SCHEDULE_SECONDS = 240;
const RUN_HEADER = "x-takoserver-e2e-run";
const MAX_HTTP_BODY_BYTES = 8 * 1024 * 1024;
export const SAMPLE_COUNTS = { members: 100, rooms: 20, posts: 1_000, attachments: 20 } as const;
const FIXTURE_DIRECTORY = new URL("../tests/fixtures/wfp-hosted-portable-sample/", import.meta.url);

type JsonRecord = Record<string, unknown>;
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

class HostedSampleError extends Error {}

interface ArtifactSpec {
  readonly url: string;
  readonly sha256: string;
}

interface FixtureArtifact {
  readonly artifact: ArtifactSpec;
  readonly manifest: {
    readonly path: string;
    readonly sha256: string;
    readonly byteSize: number;
  };
  readonly files: readonly {
    readonly path: string;
    readonly url: string;
    readonly sha256: string;
    readonly mediaType: string;
    readonly byteSize: number;
  }[];
}

export interface HostedSampleFixtureDocument {
  readonly kind: typeof WFP_HOSTED_SAMPLE_FIXTURE_KIND;
  readonly generatedAt: string;
  readonly artifactBaseUrl: string;
  readonly sqliteMigrationSet: FixtureArtifact;
  readonly workerBundle: FixtureArtifact & { readonly entrypoint: "worker.mjs" };
  readonly serviceBundle: FixtureArtifact;
  readonly staticAssetBundle: FixtureArtifact;
  readonly counts: typeof SAMPLE_COUNTS;
  readonly resourceGraph: readonly {
    readonly name: string;
    readonly form: string;
    readonly proves: readonly string[];
  }[];
}

interface BuiltArtifact {
  readonly artifact: ArtifactSpec;
  readonly manifestBytes: Uint8Array;
  readonly files: readonly {
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly url: string;
    readonly sha256: string;
    readonly mediaType: string;
  }[];
}

interface ResourceResult {
  readonly uid: string;
  readonly operationId: string;
  readonly resource: JsonRecord;
  readonly operation: JsonRecord;
}

interface GraphResults {
  readonly worker: ResourceResult;
  readonly database: ResourceResult;
  readonly migrationSet: ResourceResult;
  readonly migrationApplication: ResourceResult;
  readonly kv: ResourceResult;
  readonly bucket: ResourceResult;
  readonly bundle: ResourceResult;
  readonly version: ResourceResult;
  readonly deployment: ResourceResult;
  readonly endpoint: ResourceResult;
  readonly cron: ResourceResult;
  readonly serviceWorker: ResourceResult;
  readonly serviceBundle: ResourceResult;
  readonly serviceVersion: ResourceResult;
  readonly serviceDeployment: ResourceResult;
  readonly staticAssetBundle: ResourceResult;
}

interface RunOptions {
  readonly fixturePath: string;
  readonly origin: string;
  readonly writerSecretPath: string;
  readonly evidenceSecretPath: string;
  readonly outputPath: string;
  readonly journalPath: string;
  readonly sourceCommit: string;
  readonly space: string;
  readonly reservationOfferingId?: string;
  readonly runId: string;
  readonly pollSeconds: number;
  readonly scheduleSeconds: number;
  readonly fetcher: Fetcher;
  readonly now: () => Date;
  readonly pause?: (milliseconds: number) => Promise<void>;
}

interface PreparedClient {
  readonly origin: string;
  readonly baseUrl: string;
  readonly writerToken: string;
  readonly evidenceToken: string;
  readonly fetcher: Fetcher;
  readonly journal: (entry: JsonRecord) => Promise<void>;
}

export function hostedSampleWorkerSource(): string {
  return readFileSync(new URL("worker.mjs", FIXTURE_DIRECTORY), "utf8");
}

export function sqliteMigrationSource(): string {
  return readFileSync(new URL("0001_sample.sql", FIXTURE_DIRECTORY), "utf8");
}

export async function buildHostedSampleFixtureDocument(
  artifactBaseUrl: string,
  now: Date = new Date(),
): Promise<{
  readonly document: HostedSampleFixtureDocument;
  readonly worker: BuiltArtifact;
  readonly migration: BuiltArtifact;
  readonly service: BuiltArtifact;
  readonly assets: BuiltArtifact;
}> {
  const base = normalizeArtifactBaseUrl(artifactBaseUrl);
  const worker = await buildWorkerArtifact(new URL("worker/", base).toString());
  const migration = await buildMigrationArtifact(new URL("sqlite/", base).toString());
  const service = await buildWorkerArtifact(
    new URL("service/", base).toString(),
    readFileSync(new URL("service.mjs", FIXTURE_DIRECTORY), "utf8"),
  );
  const assets = await buildStaticArtifact(new URL("assets/", base).toString());
  const document: HostedSampleFixtureDocument = {
    kind: WFP_HOSTED_SAMPLE_FIXTURE_KIND,
    generatedAt: now.toISOString(),
    artifactBaseUrl: base,
    counts: SAMPLE_COUNTS,
    sqliteMigrationSet: artifactDocument("sqlite/manifest.json", migration),
    workerBundle: {
      ...artifactDocument("worker/manifest.json", worker),
      entrypoint: "worker.mjs",
    },
    serviceBundle: artifactDocument("service/manifest.json", service),
    staticAssetBundle: artifactDocument("assets/manifest.json", assets),
    resourceGraph: hostedSampleResourceGraphSummary(),
  };
  return { document, worker, migration, service, assets };
}

export async function writeHostedSampleFixture(input: {
  readonly artifactBaseUrl: string;
  readonly outputDirectory: string;
  readonly now?: Date;
}): Promise<HostedSampleFixtureDocument> {
  const { document, worker, migration, service, assets } = await buildHostedSampleFixtureDocument(
    input.artifactBaseUrl,
    input.now,
  );
  for (const [directory, artifact] of [
    ["worker", worker],
    ["sqlite", migration],
    ["service", service],
    ["assets", assets],
  ] as const) {
    await mkdir(join(input.outputDirectory, directory, "files"), { recursive: true });
    for (const file of artifact.files) {
      await writeNoOverwrite(
        join(input.outputDirectory, directory, "files", file.path),
        file.bytes,
      );
    }
    await writeNoOverwrite(
      join(input.outputDirectory, directory, "manifest.json"),
      artifact.manifestBytes,
    );
  }
  await writeNoOverwrite(
    join(input.outputDirectory, "fixture.json"),
    `${canonicalJson(document)}\n`,
  );
  return document;
}

export function hostedSampleResourceGraphSummary(): HostedSampleFixtureDocument["resourceGraph"] {
  return [
    { name: "assets", form: STATIC_ASSET_BUNDLE_FORM_URL, proves: ["Static GET/HEAD/range"] },
    {
      name: "service-worker",
      form: MODULE_WORKER_FORM_URL,
      proves: ["current target Service fetch"],
    },
    { name: "worker", form: MODULE_WORKER_FORM_URL, proves: ["Worker lifecycle"] },
    { name: "database", form: SQLITE_DATABASE_FORM_URL, proves: ["D1/SQLite resource"] },
    {
      name: "migration-set",
      form: SQLITE_MIGRATION_SET_FORM_URL,
      proves: ["D1 schema artifact custody"],
    },
    {
      name: "migration-application",
      form: SQLITE_MIGRATION_APPLICATION_FORM_URL,
      proves: ["D1 schema application"],
    },
    { name: "kv", form: EDGE_KV_NAMESPACE_FORM_URL, proves: ["KV resource"] },
    { name: "bucket", form: OBJECT_BUCKET_FORM_URL, proves: ["R2/ObjectBucket resource"] },
    { name: "bundle", form: WORKER_BUNDLE_FORM_URL, proves: ["Worker bundle custody"] },
    {
      name: "version",
      form: WORKER_VERSION_FORM_URL,
      proves: [
        "fetch",
        "scheduled",
        "sqlite",
        "object-bucket",
        "edge-kv",
        "service",
        "assets",
        "update/rollback",
      ],
    },
    {
      name: "deployment",
      form: WORKER_DEPLOYMENT_FORM_URL,
      proves: ["active Worker deployment"],
    },
    { name: "endpoint", form: WORKER_ENDPOINT_FORM_URL, proves: ["public Worker endpoint"] },
    {
      name: "cron",
      form: WORKER_CRON_TRIGGER_FORM_URL,
      proves: ["scheduled delivery attachment"],
    },
  ];
}

export function buildWorkerVersionSpec(input: {
  readonly runId: string;
  readonly workerUid: string;
  readonly bundleUid: string;
  readonly databaseUid: string;
  readonly kvUid: string;
  readonly bucketUid: string;
  readonly serviceWorkerUid: string;
  readonly assetsUid: string;
  readonly revision?: string;
}): WorkerVersionSpec {
  return parseWorkerVersionSpec({
    worker: { resourceUid: input.workerUid },
    bundle: { resourceUid: input.bundleUid },
    handlers: ["fetch", "scheduled"],
    vars: { E2E_RUN_ID: input.runId, E2E_REVISION: input.revision ?? "v1" },
    requiredSensitiveVars: [],
    sqliteBindings: [{ name: "DB", resource: { resourceUid: input.databaseUid } }],
    kvBindings: [{ name: "KV", resource: { resourceUid: input.kvUid } }],
    bucketBindings: [{ name: "BUCKET", resource: { resourceUid: input.bucketUid } }],
    queueProducerBindings: [],
    serviceBindings: [{ name: "SERVICE", resource: { resourceUid: input.serviceWorkerUid } }],
    actorBindings: [],
    workflowBindings: [],
    assets: {
      bundle: { resourceUid: input.assetsUid },
      runWorkerFirst: false,
      notFoundHandling: "none",
    },
  });
}

export function parseHostedSampleFixtureDocument(input: unknown): HostedSampleFixtureDocument {
  const value = record(input, "fixture document must be an object");
  if (
    value.kind !== WFP_HOSTED_SAMPLE_FIXTURE_KIND ||
    typeof value.generatedAt !== "string" ||
    typeof value.artifactBaseUrl !== "string"
  ) {
    throw new TypeError("fixture document has an invalid header");
  }
  const sqliteMigrationSet = fixtureArtifact(value.sqliteMigrationSet, "sqliteMigrationSet");
  const workerBundleValue = record(value.workerBundle, "workerBundle must be an object");
  const workerBundle = {
    ...fixtureArtifact(workerBundleValue, "workerBundle"),
    entrypoint: stringField(workerBundleValue.entrypoint, "workerBundle.entrypoint"),
  };
  if (workerBundle.entrypoint !== "worker.mjs") {
    throw new TypeError("workerBundle.entrypoint is invalid");
  }
  parseSQLiteMigrationSetSpec({ artifact: sqliteMigrationSet.artifact });
  parseWorkerBundleSpec({ artifact: workerBundle.artifact });
  const serviceBundle = fixtureArtifact(value.serviceBundle, "serviceBundle");
  const staticAssetBundle = fixtureArtifact(value.staticAssetBundle, "staticAssetBundle");
  parseWorkerBundleSpec({ artifact: serviceBundle.artifact });
  parseStaticAssetBundleSpec({ artifact: staticAssetBundle.artifact });
  if (canonicalJson(value.counts) !== canonicalJson(SAMPLE_COUNTS)) {
    throw new TypeError("fixture counts must be 100/20/1000/20");
  }
  if (!Array.isArray(value.resourceGraph) || value.resourceGraph.length < 10) {
    throw new TypeError("fixture resourceGraph is invalid");
  }
  return {
    kind: WFP_HOSTED_SAMPLE_FIXTURE_KIND,
    generatedAt: value.generatedAt,
    artifactBaseUrl: normalizeArtifactBaseUrl(value.artifactBaseUrl),
    counts: SAMPLE_COUNTS,
    sqliteMigrationSet,
    workerBundle: { ...workerBundle, entrypoint: "worker.mjs" },
    serviceBundle,
    staticAssetBundle,
    resourceGraph: hostedSampleResourceGraphSummary(),
  };
}

export async function runHostedStagingE2E(options: RunOptions): Promise<JsonRecord> {
  exactStagingOrigin(options.origin);
  resourcePrefix(options.runId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.space))
    throw new HostedSampleError("space must be the explicit organization ID");
  if (
    options.reservationOfferingId !== undefined &&
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.reservationOfferingId)
  )
    throw new HostedSampleError("reservation Offering ID is invalid");
  if (!/^[a-f0-9]{40}$/u.test(options.sourceCommit))
    throw new HostedSampleError("source commit must be a full SHA");
  const fixture = await checkHostedSampleFixture(options.fixturePath);
  await mkdir(dirname(options.outputPath), { recursive: true });
  await mkdir(dirname(options.journalPath), { recursive: true });
  const journalFile = await open(options.journalPath, "wx", 0o600);
  let outputFile: Awaited<ReturnType<typeof open>> | undefined;
  const journal = async (entry: JsonRecord) => {
    await journalFile.write(`${canonicalJson({ at: options.now().toISOString(), ...entry })}\n`);
    await journalFile.sync();
  };
  try {
    outputFile = await open(options.outputPath, "wx", 0o600);
    await journal({ kind: "start", runId: options.runId, sourceCommit: options.sourceCommit });
    const client = await prepareClient(options, journal);
    await assertSupportedForms(client);
    await assertOrganizationSpace(client, options.space);
    const endpointName = hostedSampleEndpointName(options.runId);
    for (const name of [
      "worker",
      "service-worker",
      "service-bundle",
      "service-version",
      "service-deployment",
      "assets",
      "db",
      "migration-set",
      "migration-application",
      "kv",
      "bucket",
      "bundle",
      "version",
      "deployment",
      "endpoint",
      "cron",
      "version-v2",
      "service-version-v2",
    ]) {
      for (const prefix of [resourcePrefix(options.runId), `wfp-${options.runId}`]) {
        const existing = record(
          await requestJson(
            client,
            "evidence",
            `/resources?space=${encodeURIComponent(options.space)}&name=${encodeURIComponent(`${prefix}-${name}`)}`,
            { method: "GET" },
          ),
          "fixture name preflight invalid",
        );
        if (!Array.isArray(existing.items) || existing.items.length !== 0)
          throw new HostedSampleError("fixture name already exists; use its journal for readback");
      }
    }
    const endpointExisting = record(
      await requestJson(
        client,
        "evidence",
        `/resources?space=${encodeURIComponent(options.space)}&name=${encodeURIComponent(endpointName)}`,
        { method: "GET" },
      ),
      "Endpoint name preflight invalid",
    );
    if (!Array.isArray(endpointExisting.items) || endpointExisting.items.length !== 0)
      throw new HostedSampleError("fixture name already exists; use its journal for readback");
    const reservation = await prepareOriginalReservation(client, options, endpointName);
    const graph = await createGraph({
      client,
      endpointName,
      fixture,
      space: options.space,
      runId: options.runId,
      pollSeconds: options.pollSeconds,
    });
    const endpointUrl = typedEndpointUrlFromResource({
      endpoint: graph.endpoint,
      name: endpointName,
      space: options.space,
      workerUid: graph.worker.uid,
      reservedOrigin: reservation.canonicalPublicOrigin,
    });
    await journal({
      kind: "endpoint-binding-confirmed",
      name: endpointName,
      uid: graph.endpoint.uid,
      operationId: graph.endpoint.operationId,
      reservationId: reservation.reservationId,
      origin: endpointUrl,
    });
    const probe = async (path: string, method = "GET") => {
      await journal({ kind: "endpoint-request-intent", path, method });
      return await callEndpointJson({
        fetcher: options.fetcher,
        endpointUrl,
        path,
        method,
        runId: options.runId,
      });
    };
    await journal({ kind: "app-mutation-intent", phase: "seed" });
    const seed = await probe("/e2e/seed", "POST");
    assertSampleEvidence(seed, options.runId, "v1");
    await journal({ kind: "app-mutation-confirmed", phase: "seed", counts: SAMPLE_COUNTS });
    const exercise = await probe("/e2e/exercise", "POST");
    assertPortableExercise(exercise, options.runId);
    const firstFeed = record(await probe("/e2e/feed"), "feed must be an object");
    const secondFeed = record(await probe("/e2e/feed"), "feed must be an object");
    if (
      firstFeed.cache !== "miss" ||
      secondFeed.cache !== "hit" ||
      !Array.isArray(firstFeed.posts) ||
      firstFeed.posts.length !== 50 ||
      canonicalJson(firstFeed.posts) !== canonicalJson(secondFeed.posts)
    )
      throw new HostedSampleError("SQL-backed KV feed disagrees");
    await verifyStaticDelivery(options.fetcher, endpointUrl, fixture.staticAssetBundle);
    assertRevision(await probe("/e2e/service"), options.runId, "v1");
    const quietStart = options.now().getTime();
    await journal({ kind: "quiet-start", start: quietStart, durationSeconds: 130 });
    await (options.pause ?? sleep)(130_000);
    const quietEnd = options.now().getTime();
    const scheduled = await waitForScheduledEvidence({
      fetcher: options.fetcher,
      endpointUrl,
      runId: options.runId,
      timeoutSeconds: options.scheduleSeconds,
      quietStart,
      quietEnd,
    });
    await journal({ kind: "quiet-confirmed", start: quietStart, end: quietEnd, slots: scheduled });
    const create = (name: string, spec: JsonRecord) =>
      createResource(client, {
        space: options.space,
        name: `${resourcePrefix(options.runId)}-${name}`,
        form: WORKER_VERSION_FORM_URL,
        spec,
        idempotencyKey: `${resourcePrefix(options.runId)}-${name}-create`,
        pollSeconds: options.pollSeconds,
      });
    const version2 = await create(
      "version-v2",
      buildWorkerVersionSpec({
        runId: options.runId,
        revision: "v2",
        workerUid: graph.worker.uid,
        bundleUid: graph.bundle.uid,
        databaseUid: graph.database.uid,
        kvUid: graph.kv.uid,
        bucketUid: graph.bucket.uid,
        serviceWorkerUid: graph.serviceWorker.uid,
        assetsUid: graph.staticAssetBundle.uid,
      }) as unknown as JsonRecord,
    );
    const serviceVersion2 = await create("service-version-v2", {
      worker: { resourceUid: graph.serviceWorker.uid },
      bundle: { resourceUid: graph.serviceBundle.uid },
      handlers: ["fetch"],
      vars: { E2E_RUN_ID: options.runId, E2E_REVISION: "v2" },
    });
    const update = (current: ResourceResult, versionUid: string, name: string) =>
      updateResource(client, current, {
        spec: {
          worker:
            current.resource.spec &&
            record(current.resource.spec, "deployment spec missing").worker,
          versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
        },
        idempotencyKey: `${resourcePrefix(options.runId)}-${name}`,
        pollSeconds: options.pollSeconds,
      });
    const serviceV2 = await update(graph.serviceDeployment, serviceVersion2.uid, "service-upgrade");
    assertRevision(await probe("/e2e/service"), options.runId, "v2");
    assertRevision(await probe("/health"), options.runId, "v1");
    const callerV2 = await update(graph.deployment, version2.uid, "caller-upgrade");
    assertSampleEvidence(await probe("/e2e/evidence"), options.runId, "v2");
    const callerRollback = await update(callerV2, graph.version.uid, "caller-rollback");
    const serviceRollback = await update(serviceV2, graph.serviceVersion.uid, "service-rollback");
    assertSampleEvidence(await probe("/e2e/evidence"), options.runId, "v1");
    assertRevision(await probe("/e2e/service"), options.runId, "v1");
    const live: Record<string, ResourceResult> = {
      ...graph,
      version2,
      serviceVersion2,
      deployment: callerRollback,
      serviceDeployment: serviceRollback,
    };
    for (const name of Object.keys(live)) {
      const current = resourceAt(live, name);
      live[name] = await updateResource(client, current, {
        spec: record(current.resource.spec, "Resource spec missing"),
        idempotencyKey: `${resourcePrefix(options.runId)}-${name}-same-spec`,
        pollSeconds: options.pollSeconds,
      });
    }
    for (const name of ["bundle", "serviceBundle", "migrationSet", "staticAssetBundle"]) {
      const current = resourceAt(live, name);
      const spec = record(current.resource.spec, "artifact spec missing");
      const artifact = record(spec.artifact, "artifact identity missing");
      await expectRefusal(
        client,
        current,
        "PUT",
        `${resourcePrefix(options.runId)}-${name}-immutable-refusal`,
        {
          spec: {
            artifact: {
              ...artifact,
              sha256: artifact.sha256 === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64),
            },
          },
        },
      );
    }
    for (const name of ["database", "kv", "bucket", "serviceWorker"]) {
      await expectRefusal(
        client,
        resourceAt(live, name),
        "DELETE",
        `${resourcePrefix(options.runId)}-${name}-bound-refusal`,
      );
    }
    const deleted: JsonRecord[] = [];
    const remove = async (name: string) => {
      const current = resourceAt(live, name);
      deleted.push(
        await deleteResource(
          client,
          current,
          `${resourcePrefix(options.runId)}-${name}-delete`,
          options.pollSeconds,
        ),
      );
    };
    await remove("cron");
    await remove("migrationApplication");
    assertSampleEvidence(await probe("/e2e/evidence"), options.runId, "v1");
    const clear = record(await probe("/e2e/clear", "POST"), "clear readback missing");
    if (clear.cleared !== true) throw new HostedSampleError("app data cleanup not confirmed");
    await remove("endpoint");
    const absentEndpoint = await guardedFetch(
      options.fetcher,
      new URL("/health", endpointUrl).toString(),
      { redirect: "error", signal: AbortSignal.timeout(60_000) },
    );
    if (absentEndpoint.status !== 404 && absentEndpoint.status !== 410)
      throw new HostedSampleError("deleted Endpoint still serves or absence is unknown");
    await absentEndpoint.body?.cancel();
    for (const name of [
      "deployment",
      "version2",
      "version",
      "worker",
      "serviceDeployment",
      "serviceVersion2",
      "serviceVersion",
      "serviceWorker",
      "bundle",
      "serviceBundle",
      "staticAssetBundle",
      "migrationSet",
      "database",
      "kv",
      "bucket",
    ])
      await remove(name);
    const evidence = {
      kind: WFP_HOSTED_SAMPLE_EVIDENCE_KIND,
      status: "HOSTED_STAGING_SCENARIOS_PASSED",
      runId: options.runId,
      sourceCommit: options.sourceCommit,
      origin: client.origin,
      baseUrl: client.baseUrl,
      completedAt: options.now().toISOString(),
      fixtureSha256: sha256Hex(new TextEncoder().encode(canonicalJson(fixture))),
      artifactDigests: {
        worker: fixture.workerBundle.artifact.sha256,
        service: fixture.serviceBundle.artifact.sha256,
        migration: fixture.sqliteMigrationSet.artifact.sha256,
        assets: fixture.staticAssetBundle.artifact.sha256,
      },
      resources: {
        ...graphEvidence(graph),
        version2: version2.uid,
        serviceVersion2: serviceVersion2.uid,
      },
      endpoint: {
        url: endpointUrl,
        name: endpointName,
        uid: graph.endpoint.uid,
        operationId: graph.endpoint.operationId,
      },
      originalReservation: { ...reservation, retained: true, globalNameReusable: false },
      counts: SAMPLE_COUNTS,
      quiet: { start: quietStart, end: quietEnd, slots: scheduled },
      journeys: [
        "portable-sql-kv-object",
        "static-get-head-range",
        "service-current-target",
        "version-update-rollback",
      ],
      cleanup: deleted,
      lifecycleAcceptance:
        "portable Host create/read/same-spec-update/delete; cross-org and native-owner readback require separate qualification",
      launchAcceptance:
        "unqualified: self-host Linux/Docker and independent target qualification are separate evidence",
      rollback: { caller: callerRollback.operationId, service: serviceRollback.operationId },
    };
    await journal({
      kind: "original-reservation-retained",
      reservationId: reservation.reservationId,
      globalNameReusable: false,
    });
    await journal({ kind: "finished", status: "HOSTED_STAGING_SCENARIOS_PASSED" });
    await outputFile.writeFile(`${canonicalJson(evidence)}\n`);
    await outputFile.sync();
    return evidence;
  } catch (error) {
    const message =
      error instanceof HostedSampleError
        ? error.message
        : "sample acceptance did not confirm; retain the journal for readback";
    await journal({ kind: "halt", status: "INCOMPLETE", message });
    if (outputFile) {
      await outputFile.writeFile(
        `${canonicalJson({
          kind: WFP_HOSTED_SAMPLE_EVIDENCE_KIND,
          status: "INCOMPLETE",
          runId: options.runId,
          sourceCommit: options.sourceCommit,
          journalPath: options.journalPath,
          recovery:
            "read back recorded Resource/Operation IDs; do not rerun mutations or remove claims",
        })}\n`,
      );
      await outputFile.sync();
    }
    throw new HostedSampleError(message);
  } finally {
    await outputFile?.close();
    await journalFile.close();
  }
}

export async function checkHostedSampleFixture(path: string): Promise<HostedSampleFixtureDocument> {
  const input: unknown = JSON.parse(await readFile(path, "utf8"));
  const fixture = parseHostedSampleFixtureDocument(input);
  const rebuilt = await buildHostedSampleFixtureDocument(
    fixture.artifactBaseUrl,
    new Date(fixture.generatedAt),
  );
  if (canonicalJson(input) !== canonicalJson(rebuilt.document))
    throw new HostedSampleError("fixture differs from this harness's pinned source");
  for (const [directory, artifact] of [
    ["worker", rebuilt.worker],
    ["service", rebuilt.service],
    ["sqlite", rebuilt.migration],
    ["assets", rebuilt.assets],
  ] as const) {
    const manifest = await readFile(join(dirname(path), directory, "manifest.json"));
    if (sha256Hex(manifest) !== artifact.artifact.sha256)
      throw new HostedSampleError("local manifest digest disagrees");
    for (const file of artifact.files) {
      if (
        sha256Hex(await readFile(join(dirname(path), directory, "files", file.path))) !==
        file.sha256
      ) {
        throw new HostedSampleError("local artifact file digest disagrees");
      }
    }
  }
  return fixture;
}

export function assertRevision(input: unknown, runId: string, revision: string): void {
  const result = record(input, "revision probe must be an object");
  if (result.runId !== runId || result.revision !== revision)
    throw new HostedSampleError("wrong fixture run or deployed revision");
}

export function assertSampleEvidence(input: unknown, runId: string, revision: string): void {
  assertRevision(input, runId, revision);
  const result = record(input, "sample evidence must be an object");
  if (canonicalJson(result.counts) !== canonicalJson(SAMPLE_COUNTS))
    throw new HostedSampleError("sample scale does not match 100/20/1000/20");
  if (
    canonicalJson(result.attachments) !==
    canonicalJson(Array.from({ length: 20 }, (_, i) => `Attachment ${i}`))
  ) {
    throw new HostedSampleError("retained attachment bytes disagree");
  }
}

export function assertPortableExercise(input: unknown, runId: string): void {
  const expected = {
    sqlite: { updated: "after", remaining: 0, transactionRefused: true },
    kv: { value: "portable-kv", metadata: { fixture: runId }, listed: true, deleted: true },
    object: {
      size: 15,
      range: "portable",
      conditional: "portable-object",
      multipart: "multipart-object",
      listed: true,
      deleted: true,
    },
  };
  if (canonicalJson(input) !== canonicalJson(expected))
    throw new HostedSampleError("portable SQL/KV/ObjectBucket postconditions failed");
}

async function verifyStaticDelivery(
  fetcher: Fetcher,
  endpointUrl: string,
  artifact: FixtureArtifact,
): Promise<void> {
  const url = new URL("/sample.txt", endpointUrl).toString();
  const response = await guardedFetch(fetcher, url, { redirect: "error" });
  const body = new TextEncoder().encode(await boundedText(response));
  if (response.status !== 200 || sha256Hex(body) !== artifact.files[0]?.sha256)
    throw new HostedSampleError("Static GET bytes disagree");
  const head = await guardedFetch(fetcher, url, { method: "HEAD", redirect: "error" });
  if (
    head.status !== 200 ||
    (await boundedText(head)) !== "" ||
    head.headers.get("content-length") !== String(body.byteLength)
  )
    throw new HostedSampleError("Static HEAD disagrees");
  const range = await guardedFetch(fetcher, url, {
    headers: { range: "bytes=0-9" },
    redirect: "error",
  });
  if (
    range.status !== 206 ||
    (await boundedText(range)) !== new TextDecoder().decode(body.slice(0, 10))
  ) {
    throw new HostedSampleError("Static range disagrees");
  }
}

async function buildWorkerArtifact(
  baseUrl: string,
  workerSource = hostedSampleWorkerSource(),
): Promise<BuiltArtifact> {
  const source = new TextEncoder().encode(workerSource);
  const file = {
    path: "worker.mjs",
    bytes: source,
    url: artifactFileUrl(baseUrl, "worker.mjs"),
    sha256: sha256Hex(source),
    mediaType: "application/javascript+module",
  } as const;
  const manifest = {
    entrypoint: file.path,
    files: [
      {
        path: file.path,
        url: file.url,
        sha256: file.sha256,
        mediaType: file.mediaType,
      } satisfies WorkerBundleManifestFile,
    ],
  };
  const manifestBytes = new TextEncoder().encode(canonicalJson(manifest));
  const artifact = {
    url: new URL("manifest.json", baseUrl).toString(),
    sha256: sha256Hex(manifestBytes),
  };
  await validateWorkerBundlePayload({
    spec: { artifact },
    manifestBytes,
    fileBytes: [source],
  });
  return { artifact, manifestBytes, files: [file] };
}

async function buildStaticArtifact(baseUrl: string): Promise<BuiltArtifact> {
  const source = new Uint8Array(readFileSync(new URL("sample.txt", FIXTURE_DIRECTORY)));
  const file = {
    path: "sample.txt",
    bytes: source,
    url: artifactFileUrl(baseUrl, "sample.txt"),
    sha256: sha256Hex(source),
    mediaType: "text/plain",
  };
  const manifestBytes = new TextEncoder().encode(
    canonicalJson({
      files: [
        {
          path: file.path,
          url: file.url,
          sha256: file.sha256,
          mediaType: file.mediaType,
        },
      ],
    }),
  );
  const artifact = {
    url: new URL("manifest.json", baseUrl).toString(),
    sha256: sha256Hex(manifestBytes),
  };
  await validateStaticAssetBundlePayload({
    spec: { artifact },
    manifestBytes,
    fileBytes: [source],
  });
  return { artifact, manifestBytes, files: [file] };
}

async function buildMigrationArtifact(baseUrl: string): Promise<BuiltArtifact> {
  const sql = new TextEncoder().encode(sqliteMigrationSource());
  const file = {
    path: "0001_wfp_hosted_sample.sql",
    bytes: sql,
    url: artifactFileUrl(baseUrl, "0001_wfp_hosted_sample.sql"),
    sha256: sha256Hex(sql),
    mediaType: "application/sql",
  } as const;
  const manifest = {
    files: [
      {
        path: file.path,
        url: file.url,
        sha256: file.sha256,
        mediaType: file.mediaType,
      } satisfies SQLiteMigrationManifestFile,
    ],
  };
  const manifestBytes = new TextEncoder().encode(canonicalJson(manifest));
  const artifact = {
    url: new URL("manifest.json", baseUrl).toString(),
    sha256: sha256Hex(manifestBytes),
  };
  await validateSQLiteMigrationPayload({
    spec: { artifact },
    manifestBytes,
    fileBytes: [sql],
  });
  return { artifact, manifestBytes, files: [file] };
}

async function createGraph(input: {
  readonly client: PreparedClient;
  readonly endpointName: string;
  readonly fixture: HostedSampleFixtureDocument;
  readonly space: string;
  readonly runId: string;
  readonly pollSeconds: number;
}): Promise<GraphResults> {
  const prefix = resourcePrefix(input.runId);
  const create = (name: string, form: string, spec: JsonRecord) =>
    createResource(input.client, {
      space: input.space,
      name: name === "endpoint" ? input.endpointName : `${prefix}-${name}`,
      form,
      spec,
      idempotencyKey: `${prefix}-${name}-create`,
      pollSeconds: input.pollSeconds,
    });
  const worker = await create("worker", MODULE_WORKER_FORM_URL, {});
  const serviceWorker = await create("service-worker", MODULE_WORKER_FORM_URL, {});
  const serviceBundle = await create("service-bundle", WORKER_BUNDLE_FORM_URL, {
    artifact: input.fixture.serviceBundle.artifact,
  });
  const serviceVersion = await create("service-version", WORKER_VERSION_FORM_URL, {
    worker: { resourceUid: serviceWorker.uid },
    bundle: { resourceUid: serviceBundle.uid },
    handlers: ["fetch"],
    vars: { E2E_RUN_ID: input.runId, E2E_REVISION: "v1" },
  });
  const serviceDeployment = await create("service-deployment", WORKER_DEPLOYMENT_FORM_URL, {
    worker: { resourceUid: serviceWorker.uid },
    versions: [{ workerVersion: { resourceUid: serviceVersion.uid }, weight: 10_000 }],
  });
  const staticAssetBundle = await create("assets", STATIC_ASSET_BUNDLE_FORM_URL, {
    artifact: input.fixture.staticAssetBundle.artifact,
  });
  const database = await create("db", SQLITE_DATABASE_FORM_URL, {});
  const migrationSet = await create("migration-set", SQLITE_MIGRATION_SET_FORM_URL, {
    artifact: input.fixture.sqliteMigrationSet.artifact,
  });
  const migrationApplication = await create(
    "migration-application",
    SQLITE_MIGRATION_APPLICATION_FORM_URL,
    {
      database: { resourceUid: database.uid },
      migrationSet: { resourceUid: migrationSet.uid },
    },
  );
  const kv = await create("kv", EDGE_KV_NAMESPACE_FORM_URL, {});
  const bucket = await create("bucket", OBJECT_BUCKET_FORM_URL, {});
  const bundle = await create("bundle", WORKER_BUNDLE_FORM_URL, {
    artifact: input.fixture.workerBundle.artifact,
  });
  const version = await create(
    "version",
    WORKER_VERSION_FORM_URL,
    buildWorkerVersionSpec({
      runId: input.runId,
      workerUid: worker.uid,
      bundleUid: bundle.uid,
      databaseUid: database.uid,
      kvUid: kv.uid,
      bucketUid: bucket.uid,
      serviceWorkerUid: serviceWorker.uid,
      assetsUid: staticAssetBundle.uid,
    }) as unknown as JsonRecord,
  );
  const deployment = await create("deployment", WORKER_DEPLOYMENT_FORM_URL, {
    worker: { resourceUid: worker.uid },
    versions: [{ workerVersion: { resourceUid: version.uid }, weight: 10_000 }],
  });
  const endpoint = await create("endpoint", WORKER_ENDPOINT_FORM_URL, {
    worker: { resourceUid: worker.uid },
  });
  const cron = await create("cron", WORKER_CRON_TRIGGER_FORM_URL, {
    worker: { resourceUid: worker.uid },
    cron: "* * * * *",
  });
  return {
    worker,
    database,
    migrationSet,
    migrationApplication,
    kv,
    bucket,
    bundle,
    version,
    deployment,
    endpoint,
    cron,
    serviceWorker,
    serviceBundle,
    serviceVersion,
    serviceDeployment,
    staticAssetBundle,
  };
}

async function prepareClient(
  options: RunOptions,
  journal: PreparedClient["journal"],
): Promise<PreparedClient> {
  const origin = exactStagingOrigin(options.origin);
  const writerToken = await readSecret(options.writerSecretPath, "writer secret");
  const evidenceToken = await readSecret(options.evidenceSecretPath, "evidence secret");
  const discovery = await fetchJson(options.fetcher, `${origin}/.well-known/takoform/v2`, {
    method: "GET",
  });
  const baseUrl = stringField(record(discovery, "discovery must be an object").baseUrl, "baseUrl");
  if (
    record(discovery, "discovery must be an object").api !== "forms.takoform.com/v2" ||
    new URL(baseUrl).origin !== origin
  )
    throw new HostedSampleError("v2 discovery changed the staging origin");
  return {
    origin,
    baseUrl: exactOriginOrPath(baseUrl),
    writerToken,
    evidenceToken,
    fetcher: options.fetcher,
    journal,
  };
}

async function assertSupportedForms(client: PreparedClient): Promise<void> {
  for (const form of [
    ...WFP_HOSTED_SAMPLE_E2E_FORMS,
    SQLITE_MIGRATION_SET_FORM_URL,
    WORKER_BUNDLE_FORM_URL,
  ]) {
    const support = record(
      await requestJson(client, "evidence", `/support?form=${encodeURIComponent(form)}`, {
        method: "GET",
      }),
      `support response for ${form} must be an object`,
    );
    if (support.supported !== true || support.form !== form) {
      throw new HostedSampleError(`staging Host does not support required Form ${form}`);
    }
  }
}

async function assertOrganizationSpace(client: PreparedClient, space: string): Promise<void> {
  // The owning v2 account adapter authorizes an organization key only when
  // space === its authenticated organization ID, including an empty list.
  for (const role of ["writer", "evidence"] as const) {
    const result = record(
      await requestJson(client, role, `/resources?space=${encodeURIComponent(space)}&limit=1`, {
        method: "GET",
      }),
      "organization Space proof must be an object",
    );
    if (
      !Array.isArray(result.items) ||
      result.items.length > 1 ||
      result.items.some((item) => record(item, "organization Space item invalid").space !== space)
    )
      throw new HostedSampleError("organization Space proof is invalid");
    await client.journal({ kind: "organization-space-confirmed", space, role });
  }
}

interface OriginalReservation {
  readonly format: typeof ORIGIN_RESERVATION_FORMAT;
  readonly reservationId: string;
  readonly requestedSubdomain: string;
  readonly canonicalPublicOrigin: string;
  readonly revision: string;
  readonly expiresAt: string;
  readonly status: "prepared";
}

async function prepareOriginalReservation(
  client: PreparedClient,
  options: RunOptions,
  name: string,
): Promise<OriginalReservation> {
  const reservationId = `${resourcePrefix(options.runId)}-origin`;
  const url = `${client.origin}/v1/worker-endpoint-origin-reservations/${encodeURIComponent(reservationId)}`;
  const headers = { authorization: `Bearer ${client.writerToken}` };
  const existing = await guardedFetch(client.fetcher, url, { method: "GET", headers });
  const existingBody = record(
    JSON.parse(await boundedText(existing)),
    "reservation preflight invalid",
  );
  if (
    existing.status !== 404 ||
    record(existingBody.error, "reservation absence invalid").code !== "not_found"
  )
    throw new HostedSampleError(
      "original reservation is present or absence is unknown; retain its journal",
    );
  const body = {
    format: ORIGIN_RESERVATION_FORMAT,
    requestedSubdomain: name,
    expiresInSeconds: ORIGIN_RESERVATION_TTL_SECONDS,
    ...(options.reservationOfferingId === undefined
      ? {}
      : { offeringId: options.reservationOfferingId }),
  };
  await client.journal({ kind: "original-reservation-intent", reservationId, ...body });
  const response = await guardedFetch(client.fetcher, url, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: canonicalJson(body),
  });
  const value: unknown = JSON.parse(await boundedText(response));
  if (response.status !== 201)
    throw new HostedSampleError(
      `HTTP ${response.status} refused original reservation; retain its intent`,
    );
  const reservation = originalReservation(value, reservationId, name, options.now());
  await client.journal({ kind: "original-reservation-acknowledged", ...reservation });
  const readback = await fetchJson(client.fetcher, url, { method: "GET", headers });
  const current = originalReservation(readback, reservationId, name, options.now());
  if (canonicalJson(current) !== canonicalJson(reservation))
    throw new HostedSampleError("original reservation changed during readback; retain its journal");
  await client.journal({ kind: "original-reservation-confirmed", ...reservation });
  return reservation;
}

function originalReservation(
  input: unknown,
  reservationId: string,
  name: string,
  now: Date,
): OriginalReservation {
  const value = record(input, "original reservation projection invalid");
  if (
    Object.keys(value).sort().join(",") !==
      "canonicalPublicOrigin,expiresAt,format,requestedSubdomain,reservationId,revision,status" ||
    value.format !== ORIGIN_RESERVATION_FORMAT ||
    value.reservationId !== reservationId ||
    value.requestedSubdomain !== name ||
    value.canonicalPublicOrigin !== `https://${name}.app-staging.takos.jp` ||
    typeof value.revision !== "string" ||
    !/^[1-9][0-9]*$/u.test(value.revision) ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= now.getTime() ||
    value.status !== "prepared"
  )
    throw new HostedSampleError(
      "original reservation does not match the exact prepared staging intent",
    );
  return {
    format: ORIGIN_RESERVATION_FORMAT,
    reservationId,
    requestedSubdomain: name,
    canonicalPublicOrigin: `https://${name}.app-staging.takos.jp`,
    revision: value.revision,
    expiresAt: value.expiresAt,
    status: "prepared",
  };
}

async function createResource(
  client: PreparedClient,
  input: {
    readonly space: string;
    readonly name: string;
    readonly form: string;
    readonly spec: JsonRecord;
    readonly idempotencyKey: string;
    readonly pollSeconds: number;
  },
): Promise<ResourceResult> {
  await client.journal({
    kind: "mutation-intent",
    method: "POST",
    name: input.name,
    form: input.form,
    key: input.idempotencyKey,
  });
  const accepted = record(
    await requestJson(client, "writer", "/resources", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey },
      body: canonicalJson({
        form: input.form,
        space: input.space,
        name: input.name,
        spec: input.spec,
      }),
    }),
    `${input.name} create response must be an object`,
  );
  const operationId = stringField(accepted.id, `${input.name}.operationId`);
  await client.journal({ kind: "accepted-operation", name: input.name, operationId });
  const uid = stringField(accepted.resourceUid, `${input.name}.resourceUid`);
  await client.journal({ kind: "accepted", action: "create", name: input.name, uid, operationId });
  const operation = await waitForOperation(client, operationId, input.pollSeconds);
  const resource = record(
    await requestJson(client, "evidence", `/resources/${encodeURIComponent(uid)}`, {
      method: "GET",
    }),
    `${input.name} resource readback must be an object`,
  );
  if (
    resource.uid !== uid ||
    resource.lastOperation !== operationId ||
    resource.phase !== "idle" ||
    resource.observedGeneration !== resource.generation
  ) {
    throw new HostedSampleError(`${input.name} resource did not settle to idle observed state`);
  }
  return { uid, operationId, resource, operation };
}

async function updateResource(
  client: PreparedClient,
  current: ResourceResult,
  input: {
    readonly spec: JsonRecord;
    readonly idempotencyKey: string;
    readonly pollSeconds: number;
  },
): Promise<ResourceResult> {
  await client.journal({
    kind: "mutation-intent",
    method: "PUT",
    uid: current.uid,
    key: input.idempotencyKey,
    expectedGeneration: current.resource.generation,
  });
  const accepted = record(
    await requestJson(client, "writer", `/resources/${encodeURIComponent(current.uid)}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "idempotency-key": input.idempotencyKey,
        "takoform-expected-generation": String(current.resource.generation),
      },
      body: canonicalJson({ spec: input.spec }),
    }),
    "update response must be an object",
  );
  const operationId = stringField(accepted.id, "update operation ID");
  await client.journal({ kind: "accepted", action: "update", uid: current.uid, operationId });
  if (accepted.resourceUid !== current.uid)
    throw new HostedSampleError("update changed Resource UID");
  const operation = await waitForOperation(client, operationId, input.pollSeconds);
  const resource = record(
    await requestJson(client, "evidence", `/resources/${encodeURIComponent(current.uid)}`, {
      method: "GET",
    }),
    "update readback must be an object",
  );
  if (
    resource.uid !== current.uid ||
    resource.phase !== "idle" ||
    resource.lastOperation !== operationId ||
    resource.observedGeneration !== resource.generation
  )
    throw new HostedSampleError("update readback did not settle");
  return { uid: current.uid, operationId, resource, operation };
}

async function waitForOperation(
  client: PreparedClient,
  operationId: string,
  pollSeconds: number,
): Promise<JsonRecord> {
  const deadline = Date.now() + pollSeconds * 1000;
  while (Date.now() <= deadline) {
    const operation = record(
      await requestJson(client, "evidence", `/operations/${encodeURIComponent(operationId)}`, {
        method: "GET",
      }),
      "operation readback must be an object",
    );
    if (operation.status === "succeeded") {
      if (operation.id !== operationId || operation.effect !== "complete")
        throw new HostedSampleError("Operation success lacks complete effect");
      await client.journal({
        kind: "settled",
        operationId,
        status: "succeeded",
        effect: "complete",
      });
      return operation;
    }
    if (operation.status === "failed") {
      await client.journal({
        kind: "failed-operation",
        operationId,
        status: "failed",
        effect: ["none", "unknown", "partial", "complete"].includes(String(operation.effect))
          ? operation.effect
          : "unclassified",
      });
      throw new HostedSampleError(`operation ${operationId} failed`);
    }
    await sleep(1_000);
  }
  throw new HostedSampleError(`operation ${operationId} did not finish before timeout`);
}

function resourceAt(resources: Record<string, ResourceResult>, name: string): ResourceResult {
  const result = resources[name];
  if (!result) throw new HostedSampleError("owned fixture Resource missing");
  return result;
}

async function expectRefusal(
  client: PreparedClient,
  current: ResourceResult,
  method: string,
  key: string,
  body?: JsonRecord,
): Promise<void> {
  await client.journal({ kind: "refusal-probe-intent", method, uid: current.uid, key });
  const response = await guardedFetch(
    client.fetcher,
    `${client.baseUrl}/resources/${encodeURIComponent(current.uid)}`,
    {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: {
        authorization: `Bearer ${client.writerToken}`,
        "idempotency-key": key,
        "takoform-expected-generation": String(current.resource.generation),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: canonicalJson(body) } : {}),
    },
  );
  let refusal: JsonRecord;
  try {
    refusal = record(JSON.parse(await boundedText(response)), "refusal response invalid");
  } catch {
    throw new HostedSampleError("immutable/bound refusal response is invalid");
  }
  if (
    response.status !== (method === "PUT" ? 400 : 409) ||
    (method === "PUT"
      ? refusal.code !== "invalid_spec"
      : !["dependency_conflict", "resource_in_use"].includes(String(refusal.code)))
  ) {
    throw new HostedSampleError("immutable/bound refusal was not confirmed");
  }
  const reread = record(
    await requestJson(client, "evidence", `/resources/${encodeURIComponent(current.uid)}`, {
      method: "GET",
    }),
    "refusal Resource missing",
  );
  if (
    reread.generation !== current.resource.generation ||
    reread.lastOperation !== current.operationId ||
    reread.phase !== "idle"
  ) {
    throw new HostedSampleError("refused mutation changed owned Resource state");
  }
  await client.journal({ kind: "refusal-confirmed", uid: current.uid, status: response.status });
}

async function deleteResource(
  client: PreparedClient,
  current: ResourceResult,
  key: string,
  pollSeconds: number,
): Promise<JsonRecord> {
  await client.journal({
    kind: "mutation-intent",
    method: "DELETE",
    uid: current.uid,
    key,
    expectedGeneration: current.resource.generation,
  });
  const accepted = record(
    await requestJson(client, "writer", `/resources/${encodeURIComponent(current.uid)}`, {
      method: "DELETE",
      headers: {
        "idempotency-key": key,
        "takoform-expected-generation": String(current.resource.generation),
      },
    }),
    "delete response must be an object",
  );
  const operationId = stringField(accepted.id, "delete operation ID");
  await client.journal({ kind: "accepted", action: "delete", uid: current.uid, operationId });
  if (accepted.resourceUid !== current.uid)
    throw new HostedSampleError("delete changed Resource UID");
  await waitForOperation(client, operationId, pollSeconds);
  const absent = await guardedFetch(
    client.fetcher,
    `${client.baseUrl}/resources/${encodeURIComponent(current.uid)}`,
    {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${client.evidenceToken}` },
    },
  );
  if (absent.status !== 404 && absent.status !== 410) {
    await absent.body?.cancel();
    throw new HostedSampleError("deleted Resource absence is unknown");
  }
  const absence = record(JSON.parse(await boundedText(absent)), "delete absence response invalid");
  if (absent.status === 410 && absence.code !== "gone")
    throw new HostedSampleError("delete tombstone not confirmed");
  await client.journal({ kind: "absence-confirmed", uid: current.uid, operationId });
  return { uid: current.uid, operationId, hostAbsence: true };
}

async function requestJson(
  client: PreparedClient,
  token: "writer" | "evidence",
  path: string,
  init: RequestInit,
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set(
    "authorization",
    `Bearer ${token === "writer" ? client.writerToken : client.evidenceToken}`,
  );
  return await fetchJson(client.fetcher, `${client.baseUrl}${path}`, { ...init, headers });
}

async function fetchJson(fetcher: Fetcher, input: string, init: RequestInit): Promise<unknown> {
  const response = await guardedFetch(fetcher, input, init);
  const text = await boundedText(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HostedSampleError(`HTTP ${response.status} returned non-JSON response`);
  }
  if (!response.ok) {
    throw new HostedSampleError(`HTTP ${response.status} refused request`);
  }
  return parsed;
}

async function guardedFetch(fetcher: Fetcher, input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetcher(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new HostedSampleError(
      "network acknowledgement unknown; read back journal before any further mutation",
    );
  }
}

async function callEndpointJson(input: {
  readonly fetcher: Fetcher;
  readonly endpointUrl: string;
  readonly path: string;
  readonly method: string;
  readonly runId: string;
  readonly body?: JsonRecord;
}): Promise<unknown> {
  const headers = new Headers({ [RUN_HEADER]: input.runId });
  let body: string | undefined;
  if (input.body !== undefined) {
    headers.set("content-type", "application/json");
    body = canonicalJson(input.body);
  }
  return await fetchJson(input.fetcher, new URL(input.path, input.endpointUrl).toString(), {
    method: input.method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

export function scheduledSlots(
  input: unknown,
  runId: string,
  quietStart: number,
  quietEnd: number,
): number[] {
  const evidence = record(input, "scheduled evidence must be an object");
  if (
    evidence.runId !== runId ||
    quietEnd - quietStart < 120_000 ||
    !Array.isArray(evidence.scheduled)
  ) {
    throw new HostedSampleError("scheduled evidence has no qualifying quiet interval");
  }
  const slots = new Set<number>();
  for (const item of evidence.scheduled) {
    const receipt = record(item, "scheduled receipt must be an object");
    const slot = receipt.slot;
    if (
      typeof slot !== "number" ||
      !Number.isSafeInteger(slot) ||
      slot < quietStart ||
      slot > quietEnd
    )
      continue;
    let payload: JsonRecord;
    try {
      payload = record(JSON.parse(stringField(receipt.sql, "SQL receipt")), "SQL receipt invalid");
    } catch {
      throw new HostedSampleError("scheduled SQL receipt is invalid");
    }
    const invokedAt = payload.invokedAt;
    if (
      typeof invokedAt !== "number" ||
      !Number.isSafeInteger(invokedAt) ||
      invokedAt < quietStart ||
      invokedAt > quietEnd
    )
      continue;
    const expected = JSON.stringify({ runId, slot, posts: SAMPLE_COUNTS.posts, invokedAt });
    if (receipt.sql !== expected || receipt.kv !== expected || receipt.object !== expected) {
      throw new HostedSampleError("scheduled SQL/KV/ObjectBucket receipts disagree");
    }
    if (slots.has(slot)) throw new HostedSampleError("duplicate scheduled SQL receipt");
    slots.add(slot);
  }
  return [...slots].sort((a, b) => a - b);
}

async function waitForScheduledEvidence(input: {
  readonly fetcher: Fetcher;
  readonly endpointUrl: string;
  readonly runId: string;
  readonly timeoutSeconds: number;
  readonly quietStart: number;
  readonly quietEnd: number;
}): Promise<number[]> {
  const deadline = Date.now() + input.timeoutSeconds * 1000;
  while (Date.now() <= deadline) {
    const evidence = await callEndpointJson({
      fetcher: input.fetcher,
      endpointUrl: input.endpointUrl,
      path: "/e2e/evidence",
      method: "GET",
      runId: input.runId,
    });
    const slots = scheduledSlots(evidence, input.runId, input.quietStart, input.quietEnd);
    if (slots.length >= 2) return slots;
    await sleep(10_000);
  }
  throw new HostedSampleError(
    "two automatic scheduled receipts did not appear inside the quiet interval",
  );
}

export function hostedSampleEndpointName(runId: string): string {
  resourcePrefix(runId);
  return `integration-${sha256Hex(new TextEncoder().encode(runId)).slice(0, 16)}-ep`;
}

export function typedEndpointUrlFromResource(input: {
  readonly endpoint: ResourceResult;
  readonly name: string;
  readonly space: string;
  readonly workerUid: string;
  readonly reservedOrigin: string;
}): string {
  const { endpoint, name, space, workerUid, reservedOrigin } = input;
  const resource = endpoint.resource;
  const operation = endpoint.operation;
  const spec = record(resource.spec, "Endpoint spec is invalid");
  const worker = record(spec.worker, "Endpoint Worker binding is invalid");
  const hostname = `${name}.app-staging.takos.jp`;
  const output = record(resource.output, "Endpoint output is invalid");
  if (
    !/^integration-[a-f0-9]{16}-ep$/u.test(name) ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(endpoint.uid) ||
    resource.uid !== endpoint.uid ||
    resource.form !== WORKER_ENDPOINT_FORM_URL ||
    resource.name !== name ||
    resource.space !== space ||
    resource.generation !== 1 ||
    resource.observedGeneration !== 1 ||
    resource.phase !== "idle" ||
    resource.lastOperation !== endpoint.operationId ||
    operation.id !== endpoint.operationId ||
    operation.resourceUid !== endpoint.uid ||
    operation.action !== "create" ||
    operation.generation !== 1 ||
    operation.status !== "succeeded" ||
    operation.effect !== "complete" ||
    worker.resourceUid !== workerUid ||
    reservedOrigin !== `https://${hostname}` ||
    output.hostname !== hostname ||
    output.url !== `${reservedOrigin}/`
  )
    throw new HostedSampleError(
      "Endpoint readback does not match its accepted name, UID, Operation and reserved staging origin",
    );
  return reservedOrigin;
}

export function endpointUrlFromResource(resource: JsonRecord, acceptedResourceUid: string): string {
  if (
    typeof acceptedResourceUid !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(acceptedResourceUid) ||
    resource.uid !== acceptedResourceUid
  ) {
    throw new HostedSampleError("Endpoint readback does not match its accepted Resource UID");
  }
  const output = record(resource.output, "endpoint output must be an object");
  const hostname = `integration-v2-${acceptedResourceUid.replaceAll("-", "")}.app-staging.takos.jp`;
  if (output.hostname !== hostname || output.url !== `https://${hostname}/`) {
    throw new HostedSampleError("Endpoint origin does not match its accepted staging Resource UID");
  }
  return `https://${hostname}`;
}

function graphEvidence(graph: GraphResults): JsonRecord {
  return Object.fromEntries(
    Object.entries(graph).map(([key, value]) => [
      key,
      { uid: value.uid, operationId: value.operationId },
    ]),
  );
}

function artifactDocument(path: string, artifact: BuiltArtifact): FixtureArtifact {
  return {
    artifact: artifact.artifact,
    manifest: {
      path,
      sha256: artifact.artifact.sha256,
      byteSize: artifact.manifestBytes.byteLength,
    },
    files: artifact.files.map((file) => ({
      path: file.path,
      url: file.url,
      sha256: file.sha256,
      mediaType: file.mediaType,
      byteSize: file.bytes.byteLength,
    })),
  };
}

function fixtureArtifact(input: unknown, name: string): FixtureArtifact {
  const value = record(input, `${name} must be an object`);
  const artifactValue = record(value.artifact, `${name}.artifact must be an object`);
  const manifestValue = record(value.manifest, `${name}.manifest must be an object`);
  const filesValue = value.files;
  if (!Array.isArray(filesValue) || filesValue.length < 1) {
    throw new TypeError(`${name}.files must be a non-empty array`);
  }
  return {
    artifact: {
      url: stringField(artifactValue.url, `${name}.artifact.url`),
      sha256: digestField(artifactValue.sha256, `${name}.artifact.sha256`),
    },
    manifest: {
      path: stringField(manifestValue.path, `${name}.manifest.path`),
      sha256: digestField(manifestValue.sha256, `${name}.manifest.sha256`),
      byteSize: integerField(manifestValue.byteSize, `${name}.manifest.byteSize`),
    },
    files: filesValue.map((file, index) => {
      const recordValue = record(file, `${name}.files[${index}] must be an object`);
      return {
        path: stringField(recordValue.path, `${name}.files[${index}].path`),
        url: stringField(recordValue.url, `${name}.files[${index}].url`),
        sha256: digestField(recordValue.sha256, `${name}.files[${index}].sha256`),
        mediaType: stringField(recordValue.mediaType, `${name}.files[${index}].mediaType`),
        byteSize: integerField(recordValue.byteSize, `${name}.files[${index}].byteSize`),
      };
    }),
  };
}

function normalizeArtifactBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new TypeError("artifact base URL must be absolute HTTPS without userinfo/query/hash");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function artifactFileUrl(baseUrl: string, path: string): string {
  return new URL(`files/${path.split("/").map(encodeURIComponent).join("/")}`, baseUrl).toString();
}

function resourcePrefix(runId: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{5,63}$/u.test(runId)) {
    throw new TypeError("run id must contain 6-64 lowercase identifier characters");
  }
  return `integration-wfp-${runId}`;
}

export function exactStagingOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    (url.pathname !== "/" && url.pathname !== "") ||
    !/^(?:integration|staging)-[a-z0-9]/u.test(url.hostname) ||
    !(url.hostname.endsWith(".takoserver.com") || url.hostname.endsWith(".workers.dev"))
  ) {
    throw new TypeError("only an explicit Takoserver integration/staging origin is allowed");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function exactOriginOrPath(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new TypeError("URL must be absolute HTTPS without userinfo/query/hash");
  }
  return url.toString().replace(/\/$/u, "");
}

async function readSecret(path: string, label: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (!/^[A-Za-z0-9._~+/-]{16,4096}$/u.test(value)) {
    throw new HostedSampleError(`${label} file has an invalid secret shape`);
  }
  return value;
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HTTP_BODY_BYTES) {
        await reader.cancel();
        throw new HostedSampleError("HTTP response body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function record(value: unknown, message: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(message);
  }
  return value as JsonRecord;
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function digestField(value: unknown, name: string): string {
  const digest = stringField(value, name);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new TypeError(`${name} must be a sha256 hex digest`);
  }
  return digest;
}

function integerField(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeNoOverwrite(path: string, data: string | Uint8Array): Promise<void> {
  await writeFile(path, data, { flag: "wx" });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) throw new HostedSampleError("unexpected positional argument");
    const index = arg.indexOf("=");
    if (index < 0) {
      flags.set(arg.slice(2), "1");
    } else {
      flags.set(arg.slice(2, index), arg.slice(index + 1));
    }
  }
  return flags;
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name) ?? process.env[name];
  if (!value) throw new HostedSampleError(`missing --${name}=...`);
  return value;
}

function optionalInteger(flags: Map<string, string>, name: string, fallback: number): number {
  const value = flags.get(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new HostedSampleError(`--${name} must be positive`);
  return parsed;
}

function usage(): string {
  return [
    "usage:",
    "  bun scripts/wfp-hosted-staging-e2e.ts --emit-fixture --artifact-base-url=https://.../ --output-dir=/tmp/wfp-fixture",
    "  bun scripts/wfp-hosted-staging-e2e.ts --check-fixture --fixture=/tmp/wfp-fixture/fixture.json",
    "  bun scripts/wfp-hosted-staging-e2e.ts --run --fixture=/tmp/wfp-fixture/fixture.json --origin=https://integration-api.takoserver.com --writer-secret=/path/writer.secret --evidence-secret=/path/evidence.secret --source-commit=<full-sha> --space=<actual-organization-id> [--reservation-offering-id=<eligible-offering-id>] --journal=/tmp/run.jsonl --output=/tmp/evidence.json",
  ].join("\n");
}

async function main(argv: readonly string[]): Promise<number> {
  const flags = parseFlags(argv);
  if (flags.has("help") || argv.length === 0) {
    process.stdout.write(`${usage()}\n`);
    return flags.has("help") ? 0 : 2;
  }
  if (flags.has("emit-fixture")) {
    const document = await writeHostedSampleFixture({
      artifactBaseUrl: requireFlag(flags, "artifact-base-url"),
      outputDirectory: requireFlag(flags, "output-dir"),
    });
    process.stdout.write(`${canonicalJson(document)}\n`);
    return 0;
  }
  if (flags.has("check-fixture")) {
    const path = requireFlag(flags, "fixture");
    await checkHostedSampleFixture(path);
    process.stdout.write(`${canonicalJson({ ok: true, fixture: path })}\n`);
    return 0;
  }
  if (flags.has("run")) {
    const space = flags.get("space");
    if (!space) throw new HostedSampleError("missing --space=<actual-organization-id>");
    const sourceCommit = requireFlag(flags, "source-commit");
    const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: repository,
      encoding: "utf8",
    });
    if (head !== sourceCommit || dirty !== "")
      throw new HostedSampleError("live run requires the clean pinned source commit");
    const runId = flags.get("run-id") ?? `wfp-${randomUUID()}`;
    const evidence = await runHostedStagingE2E({
      fixturePath: requireFlag(flags, "fixture"),
      origin: requireFlag(flags, "origin"),
      writerSecretPath: requireFlag(flags, "writer-secret"),
      evidenceSecretPath: requireFlag(flags, "evidence-secret"),
      space,
      ...(flags.has("reservation-offering-id")
        ? { reservationOfferingId: requireFlag(flags, "reservation-offering-id") }
        : {}),
      runId,
      pollSeconds: optionalInteger(flags, "poll-seconds", DEFAULT_POLL_SECONDS),
      scheduleSeconds: optionalInteger(flags, "schedule-timeout-seconds", DEFAULT_SCHEDULE_SECONDS),
      fetcher: fetch,
      now: () => new Date(),
      outputPath: requireFlag(flags, "output"),
      journalPath: requireFlag(flags, "journal"),
      sourceCommit,
    });
    process.stdout.write(`${canonicalJson(evidence)}\n`);
    return 0;
  }
  process.stderr.write(`${usage()}\n`);
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof HostedSampleError ? error.message : "staging E2E input or file validation failed"}\n`,
      );
      process.exit(1);
    },
  );
}
