import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64UrlEncode, bytesDigest } from "../src/json.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";
import { ACTOR_NAMESPACE_FORM_URL } from "../src/takoform-v2/forms/actor-namespace.ts";
import { AT_LEAST_ONCE_QUEUE_FORM_URL } from "../src/takoform-v2/forms/at-least-once-queue.ts";
import { DURABLE_WORKFLOW_FORM_URL } from "../src/takoform-v2/forms/durable-workflow.ts";
import { EDGE_KV_NAMESPACE_FORM_URL } from "../src/takoform-v2/forms/edge-kv-namespace.ts";
import { OBJECT_BUCKET_FORM_URL } from "../src/takoform-v2/forms/object-bucket.ts";
import { QUEUE_CONSUMER_FORM_URL } from "../src/takoform-v2/forms/queue-consumer.ts";
import { SQLITE_DATABASE_FORM_URL } from "../src/takoform-v2/forms/sqlite-database.ts";
import { SQLITE_MIGRATION_SET_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-set.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { WORKER_CRON_TRIGGER_FORM_URL } from "../src/takoform-v2/forms/worker-cron-trigger.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";

const OPT_IN = process.env.TAKOSERVER_V2_ENTRY_NATIVE;
const PUBLIC_ORIGIN = "https://v2-entry.takoserver.test";
const PUBLIC_HOST = "v2-entry.takoserver.test";
const V2 = "/apis/forms.takoform.com/v2";
const MANIFEST_URL = "https://artifacts.example.test/migration-manifest.json";
const FILE_URL = "https://artifacts.example.test/0001.sql";
const MANIFEST_KEY = "operator-held/v2/manifest";
const FILE_KEY = "operator-held/v2/0001.sql";
const BUNDLE_MANIFEST_URL = "https://artifacts.example.test/worker-bundle-manifest.json";
const BUNDLE_FILE_URL = "https://artifacts.example.test/worker.js";
const BUNDLE_MANIFEST_KEY = "operator-held/v2/worker-bundle-manifest";
const BUNDLE_FILE_KEY = "operator-held/v2/worker.js";
const ASSET_MANIFEST_URL = "https://artifacts.example.test/static-asset-manifest.json";
const ASSET_FILE_URL = "https://artifacts.example.test/assets/site.css";
const ASSET_MANIFEST_KEY = "operator-held/v2/static-asset-manifest";
const ASSET_FILE_KEY = "operator-held/v2/assets/site.css";
const CURSOR_KEY = base64UrlEncode(new Uint8Array(32).fill(0x74));
const WORKER_TARGET = "selfhost-v2-worker-primary";
const WORKER_SUFFIX = "workers.native.test";
const COMPLETE_WORKER_FORM_URLS = [
  MODULE_WORKER_FORM_URL,
  WORKER_VERSION_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_CRON_TRIGGER_FORM_URL,
  ACTOR_NAMESPACE_FORM_URL,
  DURABLE_WORKFLOW_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  SQLITE_DATABASE_FORM_URL,
  EDGE_KV_NAMESPACE_FORM_URL,
  OBJECT_BUCKET_FORM_URL,
  AT_LEAST_ONCE_QUEUE_FORM_URL,
  QUEUE_CONSUMER_FORM_URL,
] as const;

type Child = ReturnType<typeof Bun.spawn>;
type Json = Record<string, unknown>;

function fixtureConfig(
  heldArtifacts?: readonly Json[],
  workerBundleHeldArtifacts?: readonly Json[],
  staticAssetBundleHeldArtifacts?: readonly Json[],
  workerTargetKey = "native-entry-worker-bundle-v1",
) {
  return JSON.stringify({
    documentation: "https://docs.example.test/takoform-v2",
    authenticationDocumentation: "https://docs.example.test/takoform-v2/authentication",
    ...(heldArtifacts === undefined
      ? {}
      : {
          sqliteMigrationSet: {
            targetKey: "native-entry-local-sqlite-v1",
            heldArtifacts,
          },
        }),
    ...(workerBundleHeldArtifacts === undefined
      ? {}
      : {
          workerBundle: {
            targetKey: workerTargetKey,
            heldArtifacts: workerBundleHeldArtifacts,
          },
        }),
    ...(staticAssetBundleHeldArtifacts === undefined
      ? {}
      : {
          staticAssetBundle: {
            targetKey:
              workerTargetKey === "native-entry-worker-bundle-v1"
                ? "native-entry-static-assets-v1"
                : workerTargetKey,
            heldArtifacts: staticAssetBundleHeldArtifacts,
          },
        }),
  });
}

function expectWorkerBundleCustody(
  root: string,
  resourceUid: string,
  manifestSha256: string,
  fileBytes: number,
  exists: boolean,
): void {
  const database = new Database(join(root, "control.sqlite"), { readonly: true });
  try {
    const owner = database
      .query(
        "SELECT form_url, manifest_sha256, state FROM tf_v2_artifact_owners WHERE resource_uid = ?",
      )
      .get(resourceUid) as Json | null;
    if (!exists) {
      expect(owner).toBeNull();
      expect(
        database
          .query("SELECT count(*) AS chunks FROM tf_v2_artifact_chunks WHERE resource_uid = ?")
          .get(resourceUid),
      ).toEqual({ chunks: 0 });
      return;
    }

    expect(owner).toEqual({
      form_url: WORKER_BUNDLE_FORM_URL,
      manifest_sha256: manifestSha256,
      state: "verified",
    });
    expect(
      database
        .query(
          "SELECT count(*) AS chunks, coalesce(sum(length(bytes)), 0) AS byte_count FROM tf_v2_artifact_chunks WHERE resource_uid = ?",
        )
        .get(resourceUid),
    ).toEqual({ chunks: 1, byte_count: fileBytes });
  } finally {
    database.close();
  }
}

async function workerBundleCustodyBytes(
  root: string,
  resourceUid: string,
): Promise<{
  readonly manifestDigest: string;
  readonly chunkDigests: readonly { fileIndex: number; chunkIndex: number; digest: string }[];
}> {
  const database = new Database(join(root, "control.sqlite"), { readonly: true });
  try {
    const owner = database
      .query("SELECT manifest_bytes FROM tf_v2_artifact_owners WHERE resource_uid = ?")
      .get(resourceUid) as { manifest_bytes: Uint8Array } | null;
    if (!owner || !(owner.manifest_bytes instanceof Uint8Array)) {
      throw new Error("foreign custody manifest is unavailable");
    }
    const chunks = database
      .query(
        `SELECT file_index, chunk_index, bytes FROM tf_v2_artifact_chunks
         WHERE resource_uid = ? ORDER BY file_index, chunk_index`,
      )
      .all(resourceUid) as {
      file_index: number;
      chunk_index: number;
      bytes: Uint8Array;
    }[];
    return {
      manifestDigest: await bytesDigest(owner.manifest_bytes),
      chunkDigests: await Promise.all(
        chunks.map(async (chunk) => {
          if (!(chunk.bytes instanceof Uint8Array)) {
            throw new Error("foreign custody chunk is unavailable");
          }
          return {
            fileIndex: chunk.file_index,
            chunkIndex: chunk.chunk_index,
            digest: await bytesDigest(chunk.bytes),
          };
        }),
      ),
    };
  } finally {
    database.close();
  }
}

function expectStaticAssetBundleCustody(
  root: string,
  resourceUid: string,
  manifestSha256: string,
  fileBytes: number,
  exists: boolean,
): void {
  const database = new Database(join(root, "control.sqlite"), { readonly: true });
  try {
    const owner = database
      .query(
        "SELECT form_url, manifest_sha256, state FROM tf_v2_artifact_owners WHERE resource_uid = ?",
      )
      .get(resourceUid) as Json | null;
    if (!exists) {
      expect(owner).toBeNull();
      expect(
        database
          .query("SELECT count(*) AS chunks FROM tf_v2_artifact_chunks WHERE resource_uid = ?")
          .get(resourceUid),
      ).toEqual({ chunks: 0 });
      return;
    }

    expect(owner).toEqual({
      form_url: STATIC_ASSET_BUNDLE_FORM_URL,
      manifest_sha256: manifestSha256,
      state: "verified",
    });
    expect(
      database
        .query(
          "SELECT count(*) AS chunks, coalesce(sum(length(bytes)), 0) AS byte_count FROM tf_v2_artifact_chunks WHERE resource_uid = ?",
        )
        .get(resourceUid),
    ).toEqual({ chunks: 1, byte_count: fileBytes });
  } finally {
    database.close();
  }
}

function requestAt(port: number, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", PUBLIC_HOST);
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(10_000),
  });
}

async function jsonAt(
  port: number,
  method: string,
  path: string,
  wantedStatus: number,
  body?: Json,
  headers: Record<string, string> = {},
): Promise<Json> {
  const response = await requestAt(port, path, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status !== wantedStatus) {
    const problem = (await response.json().catch(() => null)) as { code?: unknown } | null;
    const code = typeof problem?.code === "string" ? ` (${problem.code})` : "";
    throw new Error(
      `native v2 request returned ${response.status}${code}, expected ${wantedStatus}`,
    );
  }
  return (await response.json()) as Json;
}

async function choosePort(): Promise<number> {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 503 }),
  });
  const port = reservation.port;
  await reservation.stop(true);
  if (port === undefined) throw new Error("Bun did not reserve a port");
  return port;
}

async function chooseUnusedPort(excluded: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const port = await choosePort();
    if (!excluded.has(port)) {
      excluded.add(port);
      return port;
    }
  }
  throw new Error("native entry port allocation unavailable");
}

function nativeHttps(hostname: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port: 443,
        servername: hostname,
        path,
        headers: { host: hostname },
        rejectUnauthorized: false,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.setTimeout(10_000, () => request.destroy(new Error("native Endpoint timed out")));
    request.once("error", reject);
    request.end();
  });
}

async function startHost(
  root: string,
  port: number,
  config: string,
  extraEnv: Record<string, string> = {},
): Promise<Child> {
  const child = Bun.spawn([process.execPath, "--no-env-file", "src/entry-bun.ts"], {
    cwd: join(import.meta.dir, ".."),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      TMPDIR: root,
      CI: "1",
      NO_COLOR: "1",
      PORT: String(port),
      TAKOSERVER_DATA_ROOT: root,
      TAKOSERVER_DB: join(root, "control.sqlite"),
      TAKOSERVER_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      TAKOSERVER_TAKOFORM_V2_CONFIG: config,
      TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: CURSOR_KEY,
      ...extraEnv,
    },
  });
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("normal Bun entry exited during startup");
      try {
        const ready = await requestAt(port, "/_takoserver/health/ready");
        await ready.arrayBuffer();
        if (ready.status === 200) return child;
      } catch {
        // The listener may not have bound yet.
      }
      await Bun.sleep(100);
    }
    throw new Error("normal Bun entry readiness deadline exceeded");
  } catch (error) {
    await stopHost(child);
    throw error;
  }
}

async function stopHost(child: Child | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const graceful = await Promise.race([child.exited, Bun.sleep(10_000).then(() => null)]);
  if (graceful !== null) return;
  child.kill("SIGKILL");
  await Promise.race([child.exited, Bun.sleep(3_000)]);
  throw new Error("normal Bun entry did not stop gracefully");
}

async function killHost(child: Child): Promise<void> {
  if (child.exitCode !== null) throw new Error("normal Bun entry exited before the crash fence");
  child.kill("SIGKILL");
  const exited = await Promise.race([
    child.exited.then(() => true),
    Bun.sleep(3_000).then(() => false),
  ]);
  if (!exited) throw new Error("normal Bun entry survived SIGKILL");
}

/** Drop the response body and its IDs after the real HTTP acceptance headers. */
async function postWithoutResponse(
  port: number,
  path: string,
  body: Json,
  token: string,
  key: string,
): Promise<void> {
  const response = await requestAt(port, path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": key,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (response.status !== 202) {
    const problem = (await response.json().catch(() => null)) as { code?: unknown } | null;
    const code = typeof problem?.code === "string" ? problem.code : "unknown";
    throw new Error(`native v2 abandoned response returned ${response.status}:${code}`);
  }
  await response.body?.cancel();
}

interface AcceptedCheckpoint {
  readonly operationId: string;
  readonly resourceUid: string;
  readonly stagedChunks: number;
}

/** One bounded, read-only SELECT at each poll; no test changes the ledger. */
async function waitForPartialCheckpoint(
  root: string,
  principal: string,
  key: string,
  fileBytes: number,
): Promise<AcceptedCheckpoint> {
  const database = new Database(join(root, "control.sqlite"), { readonly: true });
  try {
    const statement = database.query(
      `SELECT op.id, op.resource_uid, op.principal, op.status, op.dispatch_possible,
              op.lease_token, op.next_attempt_at_ms, progress.current_file_bytes,
              (SELECT count(*) FROM tf_v2_migration_set_chunks chunk
               WHERE chunk.resource_uid = op.resource_uid) AS staged_chunks
       FROM tf_v2_operations op
       LEFT JOIN tf_v2_artifact_progress progress ON progress.operation_id = op.id
       WHERE op.replay_key = ? LIMIT 1`,
    );
    const deadline = Date.now() + 20_000;
    let last: Json | null = null;
    while (Date.now() < deadline) {
      let row: Json | null;
      try {
        row = statement.get(key) as Json | null;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "SQLITE_BUSY") {
          await Bun.sleep(20);
          continue;
        }
        throw error;
      }
      last = row;
      if (row && row.principal !== principal) {
        throw new Error("native v2 request was accepted for an unexpected principal");
      }
      if (row?.status === "failed" || row?.status === "succeeded") {
        throw new Error("native v2 operation settled before a partial checkpoint was observed");
      }
      if (
        row?.status === "reconciling" &&
        row.dispatch_possible === 1 &&
        row.lease_token === null &&
        typeof row.next_attempt_at_ms === "number" &&
        row.next_attempt_at_ms > Date.now() &&
        row.current_file_bytes === fileBytes &&
        typeof row.staged_chunks === "number" &&
        row.staged_chunks > 0 &&
        row.staged_chunks < Math.ceil(fileBytes / 65_536)
      ) {
        return {
          operationId: String(row.id),
          resourceUid: String(row.resource_uid),
          stagedChunks: row.staged_chunks,
        };
      }
      await Bun.sleep(20);
    }
    throw new Error(
      `native v2 partial checkpoint was not observed before the deadline: ${JSON.stringify({
        found: last !== null,
        status: last?.status,
        dispatchPossible: last?.dispatch_possible,
        leaseActive: last !== null && last.lease_token !== null,
        nextAttemptDue:
          typeof last?.next_attempt_at_ms === "number" && last.next_attempt_at_ms <= Date.now(),
        currentFileBytes: last?.current_file_bytes,
        stagedChunks: last?.staged_chunks,
      })}`,
    );
  } finally {
    database.close();
  }
}

async function settled(port: number, token: string, operationId: string): Promise<Json> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const operation = await jsonAt(port, "GET", `${V2}/operations/${operationId}`, 200, undefined, {
      authorization: `Bearer ${token}`,
    });
    if (operation.status === "succeeded") return operation;
    if (operation.status === "failed") throw new Error("native v2 operation failed");
    await Bun.sleep(250);
  }
  throw new Error("native v2 operation settlement deadline exceeded");
}

test.skipIf(OPT_IN === undefined || OPT_IN.trim() === "")(
  "normal Bun entry manages v2 artifact Forms over loopback behind HTTPS authority",
  async () => {
    if (OPT_IN !== "1") {
      throw new Error("TAKOSERVER_V2_ENTRY_NATIVE must be exactly 1");
    }
    const root = await mkdtemp(join(tmpdir(), "takoserver-v2-entry-native-"));
    const port = await choosePort();
    let bootstrap: Child | null = null;
    let serving: Child | null = null;
    let cleanupFailed = false;
    try {
      // The first real entry creates the owner through control HTTP. Once its
      // opaque organization ID exists, the operator can grant held bytes to it.
      bootstrap = await startHost(root, port, fixtureConfig());
      const privateJwk = await readFile(join(root, "operator-key.jwk"), "utf8");
      const assertion = await signOperatorAssertion({
        privateJwk,
        claims: {
          purpose: "sign-in",
          aud: PUBLIC_ORIGIN,
          provider: "google",
          subject: "v2-native-owner",
          email: "v2-native-owner@localhost",
          displayName: "V2 Native Owner",
        },
        nowSeconds: Math.floor(Date.now() / 1_000),
        lifetimeSeconds: 60,
      });
      const session = await jsonAt(port, "POST", "/v1/sessions", 200, {
        provider: "google",
        method: "operator-assertion",
        assertion,
        sessionTtlSeconds: 60,
      });
      const sessionToken = String(session.sessionToken);
      const created = await jsonAt(
        port,
        "POST",
        "/v1/organizations",
        201,
        { name: "V2 native migration owner" },
        { authorization: `Bearer ${sessionToken}` },
      );
      const organizationId = String((created.organization as Json).id);
      const key = await jsonAt(
        port,
        "POST",
        `/v1/organizations/${organizationId}/api-keys`,
        201,
        { name: "v2 native writer", scopes: ["resources:write"], expiresInSeconds: 600 },
        { authorization: `Bearer ${sessionToken}` },
      );
      const secret = String(key.secret);
      await stopHost(bootstrap);
      bootstrap = null;

      const fileBytes = new TextEncoder().encode("CREATE TABLE must_not_execute (id INTEGER);\n");
      const fileSha256 = (await bytesDigest(fileBytes)).slice(7);
      const bundleFileBytes = new TextEncoder().encode(
        "export default { fetch() { return new Response('not executed'); } };\n",
      );
      const bundleFileSha256 = (await bytesDigest(bundleFileBytes)).slice(7);
      const manifestBytes = new TextEncoder().encode(
        JSON.stringify({
          files: [
            { path: "0001.sql", url: FILE_URL, sha256: fileSha256, mediaType: "application/sql" },
          ],
        }),
      );
      const manifestSha256 = (await bytesDigest(manifestBytes)).slice(7);
      const bundleManifestBytes = new TextEncoder().encode(
        JSON.stringify({
          entrypoint: "worker.js",
          files: [
            {
              path: "worker.js",
              url: BUNDLE_FILE_URL,
              sha256: bundleFileSha256,
              mediaType: "application/javascript+module",
            },
          ],
        }),
      );
      const bundleManifestSha256 = (await bytesDigest(bundleManifestBytes)).slice(7);
      const assetFileBytes = new TextEncoder().encode("body { color: #124; }\n");
      const assetFileSha256 = (await bytesDigest(assetFileBytes)).slice(7);
      const assetManifestBytes = new TextEncoder().encode(
        JSON.stringify({
          files: [
            {
              path: "public/site.css",
              url: ASSET_FILE_URL,
              sha256: assetFileSha256,
              mediaType: "text/css",
            },
          ],
        }),
      );
      const assetManifestSha256 = (await bytesDigest(assetManifestBytes)).slice(7);
      const objects = createFileObjectStore({ root });
      expect(
        await objects.create(MANIFEST_KEY, manifestBytes, { contentType: "application/json" }),
      ).not.toBeNull();
      expect(
        await objects.create(FILE_KEY, fileBytes, { contentType: "application/sql" }),
      ).not.toBeNull();
      expect(
        await objects.create(BUNDLE_MANIFEST_KEY, bundleManifestBytes, {
          contentType: "application/json",
        }),
      ).not.toBeNull();
      expect(
        await objects.create(BUNDLE_FILE_KEY, bundleFileBytes, {
          contentType: "application/javascript+module",
        }),
      ).not.toBeNull();
      expect(
        await objects.create(ASSET_MANIFEST_KEY, assetManifestBytes, {
          contentType: "application/json",
        }),
      ).not.toBeNull();
      expect(
        await objects.create(ASSET_FILE_KEY, assetFileBytes, { contentType: "text/css" }),
      ).not.toBeNull();
      const grants = [{ principal: `org:${organizationId}`, space: organizationId }];
      const configured = fixtureConfig(
        [
          { url: MANIFEST_URL, sha256: manifestSha256, objectKey: MANIFEST_KEY, grants },
          { url: FILE_URL, sha256: fileSha256, objectKey: FILE_KEY, grants },
        ],
        [
          {
            url: BUNDLE_MANIFEST_URL,
            sha256: bundleManifestSha256,
            objectKey: BUNDLE_MANIFEST_KEY,
            grants,
          },
          {
            url: BUNDLE_FILE_URL,
            sha256: bundleFileSha256,
            objectKey: BUNDLE_FILE_KEY,
            grants,
          },
        ],
        [
          {
            url: ASSET_MANIFEST_URL,
            sha256: assetManifestSha256,
            objectKey: ASSET_MANIFEST_KEY,
            grants,
          },
          {
            url: ASSET_FILE_URL,
            sha256: assetFileSha256,
            objectKey: ASSET_FILE_KEY,
            grants,
          },
        ],
      );
      serving = await startHost(root, port, configured);
      expect((await requestAt(port, "/.well-known/takoform/v1")).status).toBe(404);
      expect((await requestAt(port, "/.well-known/takoform/v2")).status).toBe(200);
      const auth = { authorization: `Bearer ${secret}` };
      expect(
        await jsonAt(
          port,
          "GET",
          `${V2}/support?form=${encodeURIComponent(SQLITE_MIGRATION_SET_FORM_URL)}`,
          200,
          undefined,
          auth,
        ),
      ).toMatchObject({ supported: true });
      expect(
        await jsonAt(
          port,
          "GET",
          `${V2}/support?form=${encodeURIComponent(STATIC_ASSET_BUNDLE_FORM_URL)}`,
          200,
          undefined,
          auth,
        ),
      ).toMatchObject({ supported: true });
      expect(
        await jsonAt(
          port,
          "GET",
          `${V2}/support?form=${encodeURIComponent(WORKER_BUNDLE_FORM_URL)}`,
          200,
          undefined,
          auth,
        ),
      ).toMatchObject({ supported: true });

      const spec = { artifact: { url: MANIFEST_URL, sha256: manifestSha256 } };
      const createBody = {
        form: SQLITE_MIGRATION_SET_FORM_URL,
        space: organizationId,
        name: "schema",
        spec,
      };
      const createHeaders = { ...auth, "idempotency-key": "native-entry-create-0001" };
      const create = await jsonAt(port, "POST", `${V2}/resources`, 202, createBody, createHeaders);
      const resourceUid = String(create.resourceUid);
      expect(await settled(port, secret, String(create.id))).toMatchObject({ effect: "complete" });
      const beforeRestart = await jsonAt(
        port,
        "GET",
        `${V2}/resources/${resourceUid}`,
        200,
        undefined,
        auth,
      );
      expect(beforeRestart).toMatchObject({
        uid: resourceUid,
        generation: 1,
        observedGeneration: 1,
        observed: { manifestSha256 },
      });

      const bundleSpec = {
        artifact: { url: BUNDLE_MANIFEST_URL, sha256: bundleManifestSha256 },
      };
      const bundleCreateBody = {
        form: WORKER_BUNDLE_FORM_URL,
        space: organizationId,
        name: "worker-bundle",
        spec: bundleSpec,
      };
      const bundleCreateHeaders = {
        ...auth,
        "idempotency-key": "native-entry-bundle-create-0001",
      };
      const bundleCreate = await jsonAt(
        port,
        "POST",
        `${V2}/resources`,
        202,
        bundleCreateBody,
        bundleCreateHeaders,
      );
      const bundleResourceUid = String(bundleCreate.resourceUid);
      expect(await settled(port, secret, String(bundleCreate.id))).toMatchObject({
        effect: "complete",
      });
      const bundleBeforeRestart = await jsonAt(
        port,
        "GET",
        `${V2}/resources/${bundleResourceUid}`,
        200,
        undefined,
        auth,
      );
      expect(bundleBeforeRestart).toMatchObject({
        uid: bundleResourceUid,
        generation: 1,
        observedGeneration: 1,
        observed: {
          manifestSha256: bundleManifestSha256,
          fileCount: 1,
          totalBytes: bundleFileBytes.byteLength,
          entrypoint: "worker.js",
        },
        output: {},
      });
      expectWorkerBundleCustody(
        root,
        bundleResourceUid,
        bundleManifestSha256,
        bundleFileBytes.byteLength,
        true,
      );

      const assetSpec = {
        artifact: { url: ASSET_MANIFEST_URL, sha256: assetManifestSha256 },
      };
      const assetCreateBody = {
        form: STATIC_ASSET_BUNDLE_FORM_URL,
        space: organizationId,
        name: "site-assets",
        spec: assetSpec,
      };
      const assetCreateHeaders = {
        ...auth,
        "idempotency-key": "native-entry-assets-create-0001",
      };
      const assetCreate = await jsonAt(
        port,
        "POST",
        `${V2}/resources`,
        202,
        assetCreateBody,
        assetCreateHeaders,
      );
      const assetResourceUid = String(assetCreate.resourceUid);
      expect(await settled(port, secret, String(assetCreate.id))).toMatchObject({
        effect: "complete",
      });
      const assetBeforeRestart = await jsonAt(
        port,
        "GET",
        `${V2}/resources/${assetResourceUid}`,
        200,
        undefined,
        auth,
      );
      expect(assetBeforeRestart).toMatchObject({
        uid: assetResourceUid,
        generation: 1,
        observedGeneration: 1,
        observed: {
          manifestSha256: assetManifestSha256,
          fileCount: 1,
          totalBytes: assetFileBytes.byteLength,
          files: [
            {
              path: "public/site.css",
              sha256: assetFileSha256,
              mediaType: "text/css",
              byteSize: assetFileBytes.byteLength,
            },
          ],
        },
        output: {},
      });
      expectStaticAssetBundleCustody(
        root,
        assetResourceUid,
        assetManifestSha256,
        assetFileBytes.byteLength,
        true,
      );

      // A normal entry restart retains Resource, Operation replay, and SQL
      // custody even though neither original held source object is available.
      const firstServingPid = serving.pid;
      await stopHost(serving);
      serving = null;
      expect(await objects.delete(MANIFEST_KEY)).toBe(true);
      expect(await objects.delete(FILE_KEY)).toBe(true);
      expect(await objects.delete(BUNDLE_MANIFEST_KEY)).toBe(true);
      expect(await objects.delete(BUNDLE_FILE_KEY)).toBe(true);
      expect(await objects.delete(ASSET_MANIFEST_KEY)).toBe(true);
      expect(await objects.delete(ASSET_FILE_KEY)).toBe(true);
      serving = await startHost(root, port, configured);
      expect(serving.pid).not.toBe(firstServingPid);
      expect(
        await jsonAt(port, "GET", `${V2}/resources/${resourceUid}`, 200, undefined, auth),
      ).toEqual(beforeRestart);
      expect(
        await jsonAt(port, "POST", `${V2}/resources`, 200, createBody, createHeaders),
      ).toMatchObject({
        id: create.id,
        resourceUid,
        generation: 1,
        status: "succeeded",
      });
      expect(
        await jsonAt(
          port,
          "GET",
          `${V2}/operations/${String(bundleCreate.id)}`,
          200,
          undefined,
          auth,
        ),
      ).toMatchObject({
        id: bundleCreate.id,
        resourceUid: bundleResourceUid,
        status: "succeeded",
        effect: "complete",
      });
      expect(
        await jsonAt(port, "GET", `${V2}/resources/${bundleResourceUid}`, 200, undefined, auth),
      ).toEqual(bundleBeforeRestart);
      expect(
        await jsonAt(port, "POST", `${V2}/resources`, 200, bundleCreateBody, bundleCreateHeaders),
      ).toMatchObject({
        id: bundleCreate.id,
        resourceUid: bundleResourceUid,
        generation: 1,
        status: "succeeded",
      });
      expectWorkerBundleCustody(
        root,
        bundleResourceUid,
        bundleManifestSha256,
        bundleFileBytes.byteLength,
        true,
      );
      expect(
        await jsonAt(port, "GET", `${V2}/resources/${assetResourceUid}`, 200, undefined, auth),
      ).toEqual(assetBeforeRestart);
      expect(
        await jsonAt(
          port,
          "GET",
          `${V2}/operations/${String(assetCreate.id)}`,
          200,
          undefined,
          auth,
        ),
      ).toMatchObject({
        id: assetCreate.id,
        resourceUid: assetResourceUid,
        status: "succeeded",
        effect: "complete",
      });
      expect(
        await jsonAt(port, "POST", `${V2}/resources`, 200, assetCreateBody, assetCreateHeaders),
      ).toMatchObject({
        id: assetCreate.id,
        resourceUid: assetResourceUid,
        generation: 1,
        status: "succeeded",
      });
      expectStaticAssetBundleCustody(
        root,
        assetResourceUid,
        assetManifestSha256,
        assetFileBytes.byteLength,
        true,
      );

      // Same-spec update and deletion continue from held SQL bytes.
      const update = await jsonAt(
        port,
        "PUT",
        `${V2}/resources/${resourceUid}`,
        202,
        { spec },
        {
          ...auth,
          "idempotency-key": "native-entry-update-0001",
          "takoform-expected-generation": "1",
        },
      );
      expect(await settled(port, secret, String(update.id))).toMatchObject({ effect: "complete" });
      const bundleUpdate = await jsonAt(
        port,
        "PUT",
        `${V2}/resources/${bundleResourceUid}`,
        202,
        { spec: bundleSpec },
        {
          ...auth,
          "idempotency-key": "native-entry-bundle-update-0001",
          "takoform-expected-generation": "1",
        },
      );
      expect(await settled(port, secret, String(bundleUpdate.id))).toMatchObject({
        effect: "complete",
      });
      const assetUpdate = await jsonAt(
        port,
        "PUT",
        `${V2}/resources/${assetResourceUid}`,
        202,
        { spec: assetSpec },
        {
          ...auth,
          "idempotency-key": "native-entry-assets-update-0001",
          "takoform-expected-generation": "1",
        },
      );
      expect(await settled(port, secret, String(assetUpdate.id))).toMatchObject({
        effect: "complete",
      });
      const deletion = await jsonAt(
        port,
        "DELETE",
        `${V2}/resources/${resourceUid}`,
        202,
        undefined,
        {
          ...auth,
          "idempotency-key": "native-entry-delete-0001",
          "takoform-expected-generation": "2",
        },
      );
      expect(await settled(port, secret, String(deletion.id))).toMatchObject({
        effect: "complete",
      });
      const bundleDeletion = await jsonAt(
        port,
        "DELETE",
        `${V2}/resources/${bundleResourceUid}`,
        202,
        undefined,
        {
          ...auth,
          "idempotency-key": "native-entry-bundle-delete-0001",
          "takoform-expected-generation": "2",
        },
      );
      expect(await settled(port, secret, String(bundleDeletion.id))).toMatchObject({
        effect: "complete",
      });
      const assetDeletion = await jsonAt(
        port,
        "DELETE",
        `${V2}/resources/${assetResourceUid}`,
        202,
        undefined,
        {
          ...auth,
          "idempotency-key": "native-entry-assets-delete-0001",
          "takoform-expected-generation": "2",
        },
      );
      expect(await settled(port, secret, String(assetDeletion.id))).toMatchObject({
        effect: "complete",
      });
      const gone = await requestAt(port, `${V2}/resources/${resourceUid}`, { headers: auth });
      expect(gone.status).toBe(410);
      await gone.arrayBuffer();
      const bundleGone = await requestAt(port, `${V2}/resources/${bundleResourceUid}`, {
        headers: auth,
      });
      expect(bundleGone.status).toBe(410);
      await bundleGone.arrayBuffer();
      const assetGone = await requestAt(port, `${V2}/resources/${assetResourceUid}`, {
        headers: auth,
      });
      expect(assetGone.status).toBe(410);
      await assetGone.arrayBuffer();
      expectWorkerBundleCustody(
        root,
        bundleResourceUid,
        bundleManifestSha256,
        bundleFileBytes.byteLength,
        false,
      );
      expectStaticAssetBundleCustody(
        root,
        assetResourceUid,
        assetManifestSha256,
        assetFileBytes.byteLength,
        false,
      );
    } finally {
      const stops = await Promise.allSettled([stopHost(serving), stopHost(bootstrap)]);
      cleanupFailed = stops.some((result) => result.status === "rejected");
      await rm(root, { recursive: true, force: true }).catch(() => {
        cleanupFailed = true;
      });
    }
    if (cleanupFailed) throw new Error("native v2 child cleanup failed");
  },
  180_000,
);

test.skipIf(OPT_IN !== "1")(
  "normal Bun entry admits a complete secret-free v2 Worker graph, serves HTTPS, and recovers after SIGKILL",
  async () => {
    const binary = process.env.TAKOSERVER_WORKERD_BINARY;
    const guard = process.env.TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY;
    if (!binary || !guard) throw new Error("exact native workerd and Workflow guard are required");
    const root = await mkdtemp(join(tmpdir(), "v2n-"));
    const chosen = new Set<number>([443]);
    const port = await chooseUnusedPort(chosen);
    const workerdPort = await chooseUnusedPort(chosen);
    const dataPlanePort = await chooseUnusedPort(chosen);
    const privatePorts = await Promise.all(
      Array.from({ length: 5 }, () => chooseUnusedPort(chosen)),
    );
    const privateRoot = join(root, "keys");
    await mkdir(privateRoot, { recursive: true, mode: 0o700 });
    await mkdir(join(root, "staging"), { recursive: true, mode: 0o700 });
    const names = ["sqlite", "kv", "objectBucket", "queue", "queueProducer"] as const;
    const keyPaths = Object.fromEntries(
      names.map((name) => [name, join(privateRoot, `${name}.key`)]),
    );
    for (const [index, name] of names.entries()) {
      const keyPath = keyPaths[name];
      if (!keyPath) throw new Error("native private-plane key path unavailable");
      await writeFile(keyPath, new Uint8Array(32).fill(0x31 + index), { mode: 0o600 });
    }
    const certificateFile = join(root, "cert.pem");
    const privateKeyFile = join(root, "tls.key");
    const openssl = Bun.spawn(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        privateKeyFile,
        "-out",
        certificateFile,
        "-days",
        "2",
        "-subj",
        `/CN=*.${WORKER_SUFFIX}`,
        "-addext",
        `subjectAltName=DNS:*.${WORKER_SUFFIX}`,
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    if ((await openssl.exited) !== 0) throw new Error("native Endpoint certificate unavailable");
    const privateBoot = JSON.stringify({
      sqlite: {
        privatePort: privatePorts[0],
        signingKeyFile: keyPaths.sqlite,
        stagingRoot: join(root, "staging"),
      },
      kv: { privatePort: privatePorts[1], signingKeyFile: keyPaths.kv },
      objectBucket: { privatePort: privatePorts[2], signingKeyFile: keyPaths.objectBucket },
      queue: { privatePort: privatePorts[3], signingKeyFile: keyPaths.queue },
      queueProducer: { privatePort: privatePorts[4], signingKeyFile: keyPaths.queueProducer },
    });
    const fullBoot = {
      TAKOSERVER_WORKERD_BINARY: binary,
      TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY: guard,
      TAKOSERVER_WORKERD_PORT: String(workerdPort),
      TAKOSERVER_DATA_PLANE_PORT: String(dataPlanePort),
      TAKOSERVER_V2_WORKER_RUNTIME_BOOT: JSON.stringify({
        actor: true,
        workflow: { maximumRegistrations: 64 },
      }),
      TAKOSERVER_V2_WORKER_PRIVATE_PLANES: privateBoot,
      TAKOSERVER_V2_WORKER_ENDPOINT_HTTPS: "1",
      TAKOSERVER_WORKER_ENDPOINT_SUFFIX: WORKER_SUFFIX,
      TAKOSERVER_WORKERD_TLS_CERT_FILE: certificateFile,
      TAKOSERVER_WORKERD_TLS_KEY_FILE: privateKeyFile,
      TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING: JSON.stringify({
        current: { id: "v2-entry-fixture", key: base64UrlEncode(new Uint8Array(32).fill(0x6f)) },
      }),
    };
    let bootstrap: Child | null = null;
    let serving: Child | null = null;
    let completed = false;
    try {
      bootstrap = await startHost(root, port, fixtureConfig());
      const assertion = await signOperatorAssertion({
        privateJwk: await readFile(join(root, "operator-key.jwk"), "utf8"),
        claims: {
          purpose: "sign-in",
          aud: PUBLIC_ORIGIN,
          provider: "google",
          subject: "v2-worker-entry-owner",
          email: "worker-entry-owner@localhost",
          displayName: "Worker Entry Owner",
        },
        nowSeconds: Math.floor(Date.now() / 1_000),
        lifetimeSeconds: 60,
      });
      const session = await jsonAt(port, "POST", "/v1/sessions", 200, {
        provider: "google",
        method: "operator-assertion",
        assertion,
        sessionTtlSeconds: 60,
      });
      const organization = await jsonAt(
        port,
        "POST",
        "/v1/organizations",
        201,
        { name: "Native v2 Worker entry" },
        { authorization: `Bearer ${String(session.sessionToken)}` },
      );
      const space = String((organization.organization as Json).id);
      const key = await jsonAt(
        port,
        "POST",
        `/v1/organizations/${space}/api-keys`,
        201,
        { name: "worker entry writer", scopes: ["resources:write"], expiresInSeconds: 3600 },
        { authorization: `Bearer ${String(session.sessionToken)}` },
      );
      const token = String(key.secret);
      const auth = { authorization: `Bearer ${token}` };
      await stopHost(bootstrap);
      bootstrap = null;

      const moduleBytes = new TextEncoder().encode(
        `export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/actor-write" || path === "/actor-read") {
      const actor = env.ACTOR.get(env.ACTOR.idFromName("room"));
      return actor.fetch(new Request("http://actor.invalid/" + (path === "/actor-write" ? "write" : "read")));
    }
    return new Response("normal-v2:" + path);
  }
};
export class CounterActor {
  constructor(context) { this.context = context; }
  async start() {
    await this.context.storage.execute("CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)");
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/write") {
      const result = await this.context.storage.execute("INSERT INTO counter VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET value = value + 1 RETURNING value");
      return Response.json({value: Number(result.rows[0].value)});
    }
    const result = await this.context.storage.query("SELECT value FROM counter WHERE id = 1");
    return Response.json({value: Number(result.rows[0]?.value ?? 0)});
  }
  async alarm() {}
  async socketMessage() {}
  async socketClose() {}
  async socketError() {}
}
`,
      );
      const moduleDigest = (await bytesDigest(moduleBytes)).slice(7);
      const manifestBytes = new TextEncoder().encode(
        JSON.stringify({
          entrypoint: "worker.js",
          files: [
            {
              path: "worker.js",
              url: BUNDLE_FILE_URL,
              sha256: moduleDigest,
              mediaType: "application/javascript+module",
            },
          ],
        }),
      );
      const manifestDigest = (await bytesDigest(manifestBytes)).slice(7);
      const assetBytes = new TextEncoder().encode("body { color: #124; }\n");
      const assetDigest = (await bytesDigest(assetBytes)).slice(7);
      const assetManifestBytes = new TextEncoder().encode(
        JSON.stringify({
          files: [
            {
              path: "public/site.css",
              url: ASSET_FILE_URL,
              sha256: assetDigest,
              mediaType: "text/css",
            },
          ],
        }),
      );
      const assetManifestDigest = (await bytesDigest(assetManifestBytes)).slice(7);
      const objects = createFileObjectStore({ root });
      for (const [objectKey, bytes, contentType] of [
        [BUNDLE_MANIFEST_KEY, manifestBytes, "application/json"],
        [BUNDLE_FILE_KEY, moduleBytes, "application/javascript+module"],
        [ASSET_MANIFEST_KEY, assetManifestBytes, "application/json"],
        [ASSET_FILE_KEY, assetBytes, "text/css"],
      ] as const) {
        expect(await objects.create(objectKey, bytes, { contentType })).not.toBeNull();
      }
      const grants = [{ principal: `org:${space}`, space }];
      const config = fixtureConfig(
        undefined,
        [
          {
            url: BUNDLE_MANIFEST_URL,
            sha256: manifestDigest,
            objectKey: BUNDLE_MANIFEST_KEY,
            grants,
          },
          { url: BUNDLE_FILE_URL, sha256: moduleDigest, objectKey: BUNDLE_FILE_KEY, grants },
        ],
        [
          {
            url: ASSET_MANIFEST_URL,
            sha256: assetManifestDigest,
            objectKey: ASSET_MANIFEST_KEY,
            grants,
          },
          { url: ASSET_FILE_URL, sha256: assetDigest, objectKey: ASSET_FILE_KEY, grants },
        ],
        WORKER_TARGET,
      );
      // One missing runtime capability cannot become a narrower public Form
      // profile. The same held bytes and private planes alone are insufficient.
      serving = await startHost(root, port, config, {
        ...fullBoot,
        TAKOSERVER_V2_WORKER_RUNTIME_BOOT: JSON.stringify({ actor: true }),
      });
      for (const form of COMPLETE_WORKER_FORM_URLS) {
        expect(
          await jsonAt(
            port,
            "GET",
            `${V2}/support?form=${encodeURIComponent(form)}`,
            200,
            undefined,
            auth,
          ),
        ).toMatchObject({ supported: false });
      }
      await stopHost(serving);
      serving = null;
      const noAssets = JSON.parse(config) as Json;
      delete noAssets.staticAssetBundle;
      serving = await startHost(root, port, JSON.stringify(noAssets), fullBoot);
      expect(
        await jsonAt(
          port,
          "GET",
          `${V2}/support?form=${encodeURIComponent(WORKER_VERSION_FORM_URL)}`,
          200,
          undefined,
          auth,
        ),
      ).toMatchObject({ supported: false });
      await stopHost(serving);
      serving = null;
      serving = await startHost(root, port, config, fullBoot);
      const support = async (form: string) =>
        await jsonAt(
          port,
          "GET",
          `${V2}/support?form=${encodeURIComponent(form)}`,
          200,
          undefined,
          auth,
        );
      for (const form of COMPLETE_WORKER_FORM_URLS) {
        expect(await support(form)).toMatchObject({ supported: true, privateInputs: false });
      }
      const create = async (form: string, name: string, spec: Json) => {
        const body = { form, space, name, spec };
        const headers = { ...auth, "idempotency-key": `normal-v2-${name}-create` };
        const accepted = await jsonAt(port, "POST", `${V2}/resources`, 202, body, headers);
        expect(await settled(port, token, String(accepted.id))).toMatchObject({
          effect: "complete",
        });
        return { body, headers, uid: String(accepted.resourceUid), id: String(accepted.id) };
      };
      const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
      const sqliteTarget = await create(SQLITE_DATABASE_FORM_URL, "sqlite-target", {});
      const kvTarget = await create(EDGE_KV_NAMESPACE_FORM_URL, "kv-target", {});
      const bucketTarget = await create(OBJECT_BUCKET_FORM_URL, "bucket-target", {});
      const queueTarget = await create(AT_LEAST_ONCE_QUEUE_FORM_URL, "queue-target", {
        messageRetentionSeconds: 3600,
      });
      const bundle = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
        artifact: { url: BUNDLE_MANIFEST_URL, sha256: manifestDigest },
      });
      const namespaceSpec = {
        worker: { resourceUid: worker.uid },
        className: "CounterActor",
      };
      const namespace = await create(ACTOR_NAMESPACE_FORM_URL, "namespace", namespaceSpec);
      const sensitive = await jsonAt(
        port,
        "POST",
        `${V2}/resources`,
        422,
        {
          form: WORKER_VERSION_FORM_URL,
          space,
          name: "sensitive-version",
          spec: {
            worker: { resourceUid: worker.uid },
            bundle: { resourceUid: bundle.uid },
            handlers: ["fetch"],
            requiredSensitiveVars: ["SECRET"],
          },
        },
        { ...auth, "idempotency-key": "normal-v2-sensitive-refused" },
      );
      expect(sensitive).toMatchObject({ code: "capability_required" });
      const emptyPrivateInput = await jsonAt(
        port,
        "POST",
        `${V2}/resources`,
        422,
        {
          form: WORKER_VERSION_FORM_URL,
          space,
          name: "empty-private-input-version",
          spec: {
            worker: { resourceUid: worker.uid },
            bundle: { resourceUid: bundle.uid },
            handlers: ["fetch"],
            requiredSensitiveVars: [],
          },
          privateInputs: {},
        },
        { ...auth, "idempotency-key": "normal-v2-private-input-refused" },
      );
      expect(emptyPrivateInput).toMatchObject({ code: "capability_required" });
      const version = await create(WORKER_VERSION_FORM_URL, "version", {
        worker: { resourceUid: worker.uid },
        bundle: { resourceUid: bundle.uid },
        handlers: ["fetch"],
        vars: {},
        requiredSensitiveVars: [],
        actorBindings: [{ name: "ACTOR", resource: { resourceUid: namespace.uid } }],
      });
      const deployment = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
        worker: { resourceUid: worker.uid },
        versions: [{ workerVersion: { resourceUid: version.uid }, weight: 10_000 }],
      });
      const endpoint = await create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
        worker: { resourceUid: worker.uid },
      });
      const endpointRead = await jsonAt(
        port,
        "GET",
        `${V2}/resources/${endpoint.uid}`,
        200,
        undefined,
        auth,
      );
      const hostname = String((endpointRead.output as Json).hostname);
      expect(await nativeHttps(hostname, "/before-crash")).toEqual({
        status: 200,
        body: "normal-v2:/before-crash",
      });
      expect(await nativeHttps(hostname, "/actor-write")).toEqual({
        status: 200,
        body: '{"value":1}',
      });

      const firstPid = serving.pid;
      await killHost(serving);
      serving = null;
      serving = await startHost(root, port, config, fullBoot);
      expect(serving.pid).not.toBe(firstPid);
      expect(
        await jsonAt(port, "POST", `${V2}/resources`, 200, worker.body, worker.headers),
      ).toMatchObject({ id: worker.id, status: "succeeded" });
      expect(await nativeHttps(hostname, "/after-crash")).toEqual({
        status: 200,
        body: "normal-v2:/after-crash",
      });
      expect(await nativeHttps(hostname, "/actor-read")).toEqual({
        status: 200,
        body: '{"value":1}',
      });
      expect(await nativeHttps(hostname, "/actor-write")).toEqual({
        status: 200,
        body: '{"value":2}',
      });
      const endpointUpdate = await jsonAt(
        port,
        "PUT",
        `${V2}/resources/${endpoint.uid}`,
        202,
        { spec: { worker: { resourceUid: worker.uid } } },
        {
          ...auth,
          "idempotency-key": "normal-v2-endpoint-update",
          "takoform-expected-generation": "1",
        },
      );
      expect(await settled(port, token, String(endpointUpdate.id))).toMatchObject({
        effect: "complete",
      });
      expect(await nativeHttps(hostname, "/actor-read")).toEqual({
        status: 200,
        body: '{"value":2}',
      });
      const namespaceUpdate = await jsonAt(
        port,
        "PUT",
        `${V2}/resources/${namespace.uid}`,
        202,
        { spec: namespaceSpec },
        {
          ...auth,
          "idempotency-key": "normal-v2-namespace-update",
          "takoform-expected-generation": "1",
        },
      );
      expect(await settled(port, token, String(namespaceUpdate.id))).toMatchObject({
        effect: "complete",
      });
      expect(await nativeHttps(hostname, "/actor-read")).toEqual({
        status: 200,
        body: '{"value":2}',
      });
      const update = await jsonAt(
        port,
        "PUT",
        `${V2}/resources/${worker.uid}`,
        202,
        { spec: {} },
        {
          ...auth,
          "idempotency-key": "normal-v2-worker-update",
          "takoform-expected-generation": "1",
        },
      );
      expect(await settled(port, token, String(update.id))).toMatchObject({ effect: "complete" });
      const remove = async (uid: string, generation: number, name: string) => {
        const accepted = await jsonAt(port, "DELETE", `${V2}/resources/${uid}`, 202, undefined, {
          ...auth,
          "idempotency-key": `normal-v2-${name}-delete`,
          "takoform-expected-generation": String(generation),
        });
        expect(await settled(port, token, String(accepted.id))).toMatchObject({
          effect: "complete",
        });
      };
      await remove(endpoint.uid, 2, "endpoint");
      const afterEndpointDelete = await jsonAt(
        port,
        "PUT",
        `${V2}/resources/${namespace.uid}`,
        202,
        { spec: namespaceSpec },
        {
          ...auth,
          "idempotency-key": "normal-v2-namespace-after-endpoint-delete",
          "takoform-expected-generation": "2",
        },
      );
      expect(await settled(port, token, String(afterEndpointDelete.id))).toMatchObject({
        effect: "complete",
      });
      await remove(deployment.uid, 1, "deployment");
      await remove(version.uid, 1, "version");
      await remove(namespace.uid, 3, "namespace");
      await remove(bundle.uid, 1, "bundle");
      await remove(queueTarget.uid, 1, "queue-target");
      await remove(bucketTarget.uid, 1, "bucket-target");
      await remove(kvTarget.uid, 1, "kv-target");
      await remove(sqliteTarget.uid, 1, "sqlite-target");
      await remove(worker.uid, 2, "worker");
      await stopHost(serving);
      serving = null;
      const occupiedControl = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: () => new Response(null, { status: 503 }),
      });
      try {
        await expect(startHost(root, port, config, fullBoot)).rejects.toThrow(
          "normal Bun entry exited during startup",
        );
        // The existing Endpoint boot bound 443 before the ordinary Bun listener
        // failed. No listener may survive its failed startup cleanup.
        const availableEndpoint = Bun.serve({
          hostname: "127.0.0.1",
          port: 443,
          fetch: () => new Response(null, { status: 503 }),
        });
        await availableEndpoint.stop(true);
      } finally {
        await occupiedControl.stop(true);
      }
      completed = true;
    } finally {
      await Promise.allSettled([stopHost(serving), stopHost(bootstrap)]);
      if (completed) await rm(root, { recursive: true, force: true });
    }
  },
  240_000,
);

test.skipIf(OPT_IN === undefined || OPT_IN.trim() === "")(
  "normal Bun entry resumes one accepted partial artifact Operation after SIGKILL and a discarded response body",
  async () => {
    if (OPT_IN !== "1") throw new Error("TAKOSERVER_V2_ENTRY_NATIVE must be exactly 1");
    const root = await mkdtemp(join(tmpdir(), "takoserver-v2-entry-crash-"));
    const port = await choosePort();
    let bootstrap: Child | null = null;
    let serving: Child | null = null;
    let cleanupFailed = false;
    try {
      bootstrap = await startHost(root, port, fixtureConfig());
      const assertion = await signOperatorAssertion({
        privateJwk: await readFile(join(root, "operator-key.jwk"), "utf8"),
        claims: {
          purpose: "sign-in",
          aud: PUBLIC_ORIGIN,
          provider: "google",
          subject: "v2-crash-owner",
          email: "v2-crash-owner@localhost",
          displayName: "V2 Crash Owner",
        },
        nowSeconds: Math.floor(Date.now() / 1_000),
        lifetimeSeconds: 60,
      });
      const session = await jsonAt(port, "POST", "/v1/sessions", 200, {
        provider: "google",
        method: "operator-assertion",
        assertion,
        sessionTtlSeconds: 60,
      });
      const sessionAuth = { authorization: `Bearer ${String(session.sessionToken)}` };
      const primary = await jsonAt(
        port,
        "POST",
        "/v1/organizations",
        201,
        { name: "V2 interrupted owner" },
        sessionAuth,
      );
      const foreign = await jsonAt(
        port,
        "POST",
        "/v1/organizations",
        201,
        { name: "V2 foreign custody sentinel" },
        sessionAuth,
      );
      const primarySpace = String((primary.organization as Json).id);
      const foreignSpace = String((foreign.organization as Json).id);
      const primaryKey = await jsonAt(
        port,
        "POST",
        `/v1/organizations/${primarySpace}/api-keys`,
        201,
        { name: "interrupted writer", scopes: ["resources:write"], expiresInSeconds: 600 },
        sessionAuth,
      );
      const foreignKey = await jsonAt(
        port,
        "POST",
        `/v1/organizations/${foreignSpace}/api-keys`,
        201,
        { name: "foreign sentinel writer", scopes: ["resources:write"], expiresInSeconds: 600 },
        sessionAuth,
      );
      const primaryToken = String(primaryKey.secret);
      const foreignToken = String(foreignKey.secret);
      await stopHost(bootstrap);
      bootstrap = null;

      // 5 MiB exceeds the four guarded 15-chunk writes allowed in one pass.
      // The first process must durably stage a prefix, then yield its lease.
      const fileBytes = new Uint8Array(5 * 1_024 * 1_024).fill(0x78);
      fileBytes[0] = 0x2d;
      fileBytes[1] = 0x2d;
      fileBytes[fileBytes.length - 1] = 0x0a;
      const fileSha256 = (await bytesDigest(fileBytes)).slice(7);
      const manifestBytes = new TextEncoder().encode(
        JSON.stringify({
          files: [
            { path: "0001.sql", url: FILE_URL, sha256: fileSha256, mediaType: "application/sql" },
          ],
        }),
      );
      const manifestSha256 = (await bytesDigest(manifestBytes)).slice(7);
      const sentinelBytes = new TextEncoder().encode(
        "export default {fetch() {return new Response('sentinel')}};\n",
      );
      const sentinelSha256 = (await bytesDigest(sentinelBytes)).slice(7);
      const sentinelManifest = new TextEncoder().encode(
        JSON.stringify({
          entrypoint: "worker.js",
          files: [
            {
              path: "worker.js",
              url: BUNDLE_FILE_URL,
              sha256: sentinelSha256,
              mediaType: "application/javascript+module",
            },
          ],
        }),
      );
      const sentinelManifestSha256 = (await bytesDigest(sentinelManifest)).slice(7);
      const objects = createFileObjectStore({ root });
      expect(await objects.create(MANIFEST_KEY, manifestBytes)).not.toBeNull();
      expect(await objects.create(FILE_KEY, fileBytes)).not.toBeNull();
      expect(await objects.create(BUNDLE_MANIFEST_KEY, sentinelManifest)).not.toBeNull();
      expect(await objects.create(BUNDLE_FILE_KEY, sentinelBytes)).not.toBeNull();
      const primaryGrants = [{ principal: `org:${primarySpace}`, space: primarySpace }];
      const foreignGrants = [{ principal: `org:${foreignSpace}`, space: foreignSpace }];
      const configured = fixtureConfig(
        [
          {
            url: MANIFEST_URL,
            sha256: manifestSha256,
            objectKey: MANIFEST_KEY,
            grants: primaryGrants,
          },
          { url: FILE_URL, sha256: fileSha256, objectKey: FILE_KEY, grants: primaryGrants },
        ],
        [
          {
            url: BUNDLE_MANIFEST_URL,
            sha256: sentinelManifestSha256,
            objectKey: BUNDLE_MANIFEST_KEY,
            grants: foreignGrants,
          },
          {
            url: BUNDLE_FILE_URL,
            sha256: sentinelSha256,
            objectKey: BUNDLE_FILE_KEY,
            grants: foreignGrants,
          },
        ],
      );
      serving = await startHost(root, port, configured);

      expect(
        await jsonAt(
          port,
          "GET",
          `${V2}/support?form=${encodeURIComponent(SQLITE_MIGRATION_SET_FORM_URL)}`,
          200,
          undefined,
          { authorization: `Bearer ${primaryToken}` },
        ),
      ).toMatchObject({ supported: true });

      const sentinelSpec = {
        artifact: { url: BUNDLE_MANIFEST_URL, sha256: sentinelManifestSha256 },
      };
      const sentinelCreate = await jsonAt(
        port,
        "POST",
        `${V2}/resources`,
        202,
        {
          form: WORKER_BUNDLE_FORM_URL,
          space: foreignSpace,
          name: "untouched",
          spec: sentinelSpec,
        },
        { authorization: `Bearer ${foreignToken}`, "idempotency-key": "foreign-sentinel-create" },
      );
      const sentinelUid = String(sentinelCreate.resourceUid);
      expect(await settled(port, foreignToken, String(sentinelCreate.id))).toMatchObject({
        effect: "complete",
      });
      const foreignBefore = await jsonAt(
        port,
        "GET",
        `${V2}/resources/${sentinelUid}`,
        200,
        undefined,
        { authorization: `Bearer ${foreignToken}` },
      );
      expectWorkerBundleCustody(
        root,
        sentinelUid,
        sentinelManifestSha256,
        sentinelBytes.byteLength,
        true,
      );
      const foreignCustodyBefore = await workerBundleCustodyBytes(root, sentinelUid);
      expect(foreignCustodyBefore).toEqual({
        manifestDigest: `sha256:${sentinelManifestSha256}`,
        chunkDigests: [{ fileIndex: 0, chunkIndex: 0, digest: `sha256:${sentinelSha256}` }],
      });

      const spec = { artifact: { url: MANIFEST_URL, sha256: manifestSha256 } };
      const body = {
        form: SQLITE_MIGRATION_SET_FORM_URL,
        space: primarySpace,
        name: "interrupted",
        spec,
      };
      const replayKey = "native-entry-crash-create-0001";
      await postWithoutResponse(port, `${V2}/resources`, body, primaryToken, replayKey);
      const checkpoint = await waitForPartialCheckpoint(
        root,
        `org:${primarySpace}`,
        replayKey,
        fileBytes.byteLength,
      );
      expect(checkpoint.stagedChunks).toBeGreaterThan(0);
      expect(checkpoint.stagedChunks).toBeLessThan(Math.ceil(fileBytes.byteLength / 65_536));
      const firstPid = serving.pid;
      await killHost(serving);
      serving = null;

      serving = await startHost(root, port, configured);
      expect(serving.pid).not.toBe(firstPid);
      const replay = await requestAt(port, `${V2}/resources`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${primaryToken}`,
          "idempotency-key": replayKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect([200, 202]).toContain(replay.status);
      const replayed = (await replay.json()) as Json;
      expect(replayed).toMatchObject({
        id: checkpoint.operationId,
        resourceUid: checkpoint.resourceUid,
        generation: 1,
      });
      expect(await settled(port, primaryToken, checkpoint.operationId)).toMatchObject({
        id: checkpoint.operationId,
        resourceUid: checkpoint.resourceUid,
        effect: "complete",
      });
      const complete = await jsonAt(
        port,
        "GET",
        `${V2}/resources/${checkpoint.resourceUid}`,
        200,
        undefined,
        { authorization: `Bearer ${primaryToken}` },
      );
      expect(complete).toMatchObject({
        uid: checkpoint.resourceUid,
        generation: 1,
        observedGeneration: 1,
        observed: { manifestSha256, totalBytes: fileBytes.byteLength },
      });
      const database = new Database(join(root, "control.sqlite"), { readonly: true });
      try {
        expect(
          database
            .query(
              "SELECT count(*) AS count FROM tf_v2_migration_set_chunks WHERE resource_uid = ?",
            )
            .get(checkpoint.resourceUid),
        ).toEqual({ count: Math.ceil(fileBytes.byteLength / 65_536) });
        expect(
          database
            .query("SELECT count(*) AS count FROM tf_v2_artifact_progress WHERE operation_id = ?")
            .get(checkpoint.operationId),
        ).toEqual({ count: 0 });
      } finally {
        database.close();
      }
      expect(
        (
          await requestAt(port, `${V2}/resources/${checkpoint.resourceUid}`, {
            headers: { authorization: `Bearer ${foreignToken}` },
          })
        ).status,
      ).toBe(404);
      expect(
        await jsonAt(port, "GET", `${V2}/resources/${sentinelUid}`, 200, undefined, {
          authorization: `Bearer ${foreignToken}`,
        }),
      ).toEqual(foreignBefore);
      expectWorkerBundleCustody(
        root,
        sentinelUid,
        sentinelManifestSha256,
        sentinelBytes.byteLength,
        true,
      );
      expect(await workerBundleCustodyBytes(root, sentinelUid)).toEqual(foreignCustodyBefore);

      // Once the interrupted create has finished, later same-spec work needs
      // only the held custody; the original source objects may disappear.
      expect(await objects.delete(MANIFEST_KEY)).toBe(true);
      expect(await objects.delete(FILE_KEY)).toBe(true);
      const auth = { authorization: `Bearer ${primaryToken}` };
      const update = await jsonAt(
        port,
        "PUT",
        `${V2}/resources/${checkpoint.resourceUid}`,
        202,
        { spec },
        {
          ...auth,
          "idempotency-key": "native-entry-crash-update",
          "takoform-expected-generation": "1",
        },
      );
      expect(await settled(port, primaryToken, String(update.id))).toMatchObject({
        effect: "complete",
      });
      const deletion = await jsonAt(
        port,
        "DELETE",
        `${V2}/resources/${checkpoint.resourceUid}`,
        202,
        undefined,
        {
          ...auth,
          "idempotency-key": "native-entry-crash-delete",
          "takoform-expected-generation": "2",
        },
      );
      expect(await settled(port, primaryToken, String(deletion.id))).toMatchObject({
        effect: "complete",
      });
      const gone = await requestAt(port, `${V2}/resources/${checkpoint.resourceUid}`, {
        headers: auth,
      });
      expect(gone.status).toBe(410);
      await gone.arrayBuffer();
      const afterDelete = new Database(join(root, "control.sqlite"), { readonly: true });
      try {
        expect(
          afterDelete
            .query(
              `SELECT
                 (SELECT count(*) FROM tf_v2_migration_set_owners WHERE resource_uid = ?) AS owners,
                 (SELECT count(*) FROM tf_v2_migration_set_chunks WHERE resource_uid = ?) AS chunks,
                 (SELECT count(*) FROM tf_v2_artifact_progress WHERE resource_uid = ?) AS progress`,
            )
            .get(checkpoint.resourceUid, checkpoint.resourceUid, checkpoint.resourceUid),
        ).toEqual({ owners: 0, chunks: 0, progress: 0 });
      } finally {
        afterDelete.close();
      }
      expect(
        await jsonAt(port, "GET", `${V2}/resources/${sentinelUid}`, 200, undefined, {
          authorization: `Bearer ${foreignToken}`,
        }),
      ).toEqual(foreignBefore);
      expectWorkerBundleCustody(
        root,
        sentinelUid,
        sentinelManifestSha256,
        sentinelBytes.byteLength,
        true,
      );
      expect(await workerBundleCustodyBytes(root, sentinelUid)).toEqual(foreignCustodyBefore);
    } finally {
      const stops = await Promise.allSettled([stopHost(serving), stopHost(bootstrap)]);
      cleanupFailed = stops.some((result) => result.status === "rejected");
      await rm(root, { recursive: true, force: true }).catch(() => {
        cleanupFailed = true;
      });
    }
    if (cleanupFailed) throw new Error("native v2 crash child cleanup failed");
  },
  180_000,
);
