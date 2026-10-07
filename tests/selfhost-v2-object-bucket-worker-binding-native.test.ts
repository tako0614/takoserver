import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { createAccounts } from "../src/auth.ts";
import { bytesDigest } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createSelfhostV2KvStore } from "../src/providers/selfhost-v2-kv-store.ts";
import { createSelfhostV2ObjectBucketStore } from "../src/providers/selfhost-v2-object-bucket-store.ts";
import { createSelfhostV2SQLiteStore } from "../src/providers/selfhost-v2-sqlite-store.ts";
import {
  runSelfhostKvOperation,
  selfhostKvOperationErrorCode,
} from "../src/selfhost-data-planes.ts";
import { createSelfhostV2WorkerComposition } from "../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { EDGE_KV_NAMESPACE_FORM_URL } from "../src/takoform-v2/forms/edge-kv-namespace.ts";
import { createEdgeKVNamespaceForm } from "../src/takoform-v2/forms/edge-kv-namespace-backend.ts";
import { OBJECT_BUCKET_FORM_URL } from "../src/takoform-v2/forms/object-bucket.ts";
import { createObjectBucketForm } from "../src/takoform-v2/forms/object-bucket-backend.ts";
import { SQLITE_DATABASE_FORM_URL } from "../src/takoform-v2/forms/sqlite-database.ts";
import { createSQLiteDatabaseForm } from "../src/takoform-v2/forms/sqlite-database-backend.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { spawnWorkerdWithParentDeath } from "../src/workerd-linux-process.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const ORIGIN = "https://api.example.test";
const API = "/apis/forms.takoform.com/v2";
const TARGET = "selfhost-v2-worker-primary";
const MANIFEST_URL = "https://artifacts.example.test/object-worker/manifest.json";
const MODULE_URL = "https://artifacts.example.test/object-worker/index.mjs";

const binary = nativeEvidenceBinary("workerd-artifact") ?? null;

test.skipIf(binary === null)(
  "pinned Workerd serves v2 KV, SQLite, and ObjectBucket through test-local Host composition",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "selfhost-v2-object-binding-native-"));
    const database = new Database(join(root, "control.sqlite"));
    let composition: ReturnType<typeof createSelfhostV2WorkerComposition> | undefined;
    let primaryError: unknown;
    try {
      migrateSqlite(database);
      const sql = createSqliteSql(database);
      const objects = createMemoryObjectStore();
      const clock = () => new Date();
      const fileModule = new TextEncoder().encode(`
const encoder = new TextEncoder();
async function read(bucket, key) {
  const result = await bucket.get(key, {});
  return result === null ? "missing" : await new Response(result.body).text();
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/single") {
      try {
        const value = encoder.encode("streamed-value");
        await env.MEDIA.put("single.txt", value.buffer, { contentLength: value.byteLength, contentType: "text/plain" });
        await env.CACHE.put("fixture", "kv-value");
        const kvBytes = await env.CACHE.get("fixture");
        await env.DB.execute("INSERT INTO fixture (value) VALUES (?)", ["sql-value"]);
        const rows = await env.DB.query("SELECT 1 AS value");
        const stored = await env.DB.query("SELECT value FROM fixture");
        return Response.json({
          object: await read(env.MEDIA, "single.txt"),
          kv: kvBytes === null ? null : new TextDecoder().decode(kvBytes),
          sql: rows.rows[0]?.value,
          sqlStored: stored.rows[0]?.value,
        });
      } catch (error) {
        return new Response(String(error), { status: 500 });
      }
    }
    if (path === "/multipart") {
      const upload = await env.MEDIA.createMultipartUpload("multipart.txt", { contentType: "text/plain" });
      const value = encoder.encode("multipart-value");
      const part = await env.MEDIA.uploadPart("multipart.txt", upload.uploadId, 1, value.buffer, { contentLength: value.byteLength });
      await env.MEDIA.completeMultipartUpload("multipart.txt", upload.uploadId, [{ partNumber: 1, etag: part.etag }]);
      return new Response(await read(env.MEDIA, "multipart.txt"));
    }
    return new Response("not found", { status: 404 });
  },
};
`);
      const manifest = new TextEncoder().encode(
        JSON.stringify({
          entrypoint: "index.mjs",
          files: [
            {
              path: "index.mjs",
              url: MODULE_URL,
              sha256: (await bytesDigest(fileModule)).slice(7),
              mediaType: "application/javascript+module",
            },
          ],
        }),
      );
      const manifestSha = (await bytesDigest(manifest)).slice(7);
      const moduleSha = (await bytesDigest(fileModule)).slice(7);
      await objects.create("object-worker/manifest", manifest);
      await objects.create("object-worker/module", fileModule);

      const selected = await selectClosedGraphWorkerd({
        binary: binary ?? undefined,
        privateRoot: join(root, "selected-workerd"),
      });
      if (!selected.binary) throw new Error(selected.diagnostic ?? "pinned Workerd unavailable");

      const identity = {
        async verify({ assertion }: { assertion: string }) {
          return {
            providerSubject: assertion,
            email: `${assertion}@example.test`,
            displayName: assertion,
          };
        },
      };
      const accounts = createAccounts({ sql, identity, clock });
      const signedIn = await accounts.signIn({ provider: "google", assertion: "object-worker" });
      const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
      if (!actor) throw new Error("fixture owner did not authenticate");
      const organization = await accounts.createOrganization({ actor, name: "Object Worker Org" });
      const apiKey = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "Object Worker test key",
        scopes: ["resources:write"],
        expiresInSeconds: 3_600,
      });

      const workerBundleConfig = {
        targetKey: TARGET,
        heldArtifacts: [
          {
            url: MANIFEST_URL,
            sha256: manifestSha,
            objectKey: "object-worker/manifest",
            grants: [{ principal: `org:${organization.id}`, space: organization.id }],
          },
          {
            url: MODULE_URL,
            sha256: moduleSha,
            objectKey: "object-worker/module",
            grants: [{ principal: `org:${organization.id}`, space: organization.id }],
          },
        ],
      };
      const config = {
        cursorSigningKey: new Uint8Array(32).fill(0x52),
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
        workerBundle: workerBundleConfig,
      };
      const objectStore = createSelfhostV2ObjectBucketStore({
        sql,
        root: join(root, "object-buckets"),
        clock,
      });
      const sqliteStore = createSelfhostV2SQLiteStore({
        sql,
        root: join(root, "sqlite-databases"),
        targetKey: TARGET,
        now: clock,
      });
      const kvStore = createSelfhostV2KvStore({
        sql,
        root: join(root, "kv-namespaces"),
        clock,
        runOperation: runSelfhostKvOperation,
        operationErrorCode: selfhostKvOperationErrorCode,
      });
      const reservePrivatePort = async () => {
        const reservation = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: () => new Response(null, { status: 503 }),
        });
        const port = Number(reservation.port);
        await reservation.stop(true);
        if (!port) throw new Error("private binding port unavailable");
        return port;
      };
      const sqlitePrivatePort = await reservePrivatePort();
      const kvPrivatePort = await reservePrivatePort();
      const portReservation = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(null, { status: 503 }),
      });
      const objectPrivatePort = Number(portReservation.port);
      await portReservation.stop(true);
      if (!objectPrivatePort) throw new Error("ObjectBucket private port unavailable");

      composition = createSelfhostV2WorkerComposition({
        sql,
        objects,
        clock,
        config,
        rootDirectory: join(root, "worker-owners"),
        targetKey: TARGET,
        workerdBinary: selected.binary,
        spawn: (command) =>
          spawnWorkerdWithParentDeath(command, { stdout: "ignore", stderr: "inherit" }),
        v2ObjectBucketBinding: {
          store: objectStore,
          signingKey: new Uint8Array(32).fill(0x63),
          privatePort: objectPrivatePort,
        },
        sqliteBinding: {
          store: sqliteStore,
          signingKey: new Uint8Array(32).fill(0x64),
          privatePort: sqlitePrivatePort,
        },
        v2KvBinding: {
          store: kvStore,
          signingKey: new Uint8Array(32).fill(0x65),
          privatePort: kvPrivatePort,
        },
        endpoint: {
          assignHostname({ resourceUid }) {
            return `worker-${resourceUid.slice(0, 8)}.example.test`;
          },
          async observeTls(input) {
            const owner = await composition?.ownerForWorkerUid(input.workerUid);
            const serving = await owner?.observeServing({
              workerResourceUid: input.workerUid,
              targetKey: TARGET,
            });
            return {
              ...input,
              ready: serving?.kind === "serving" && serving.hostnames.includes(input.hostname),
            };
          },
          async observeRouteAbsent(input) {
            const owner = await composition?.ownerForWorkerUid(input.workerUid);
            const serving = await owner?.observeServing({
              workerResourceUid: input.workerUid,
              targetKey: TARGET,
            });
            return {
              ...input,
              absent: serving?.kind === "serving" && !serving.hostnames.includes(input.hostname),
            };
          },
        },
      });
      const activeComposition = composition;
      expect(await activeComposition.restoreOwners()).toEqual([]);
      const app = buildApp({
        sql,
        objects,
        clock,
        identity,
        settlement: {
          async verify() {
            throw new Error("not configured");
          },
        },
        publicOrigin: ORIGIN,
        forms: [],
        hostForms: [],
        driver: new InMemoryTakoformResourceDriver(),
        offerings: [],
        v2: config,
        v2FormFactory(context) {
          return {
            ...activeComposition.internalFormFactory(context),
            [SQLITE_DATABASE_FORM_URL]: createSQLiteDatabaseForm({ store: sqliteStore }),
            [EDGE_KV_NAMESPACE_FORM_URL]: createEdgeKVNamespaceForm({
              store: kvStore,
              targetKey: TARGET,
            }),
            [OBJECT_BUCKET_FORM_URL]: createObjectBucketForm({
              store: objectStore,
              targetKey: TARGET,
            }),
          };
        },
      });

      const request = (
        path: string,
        method = "GET",
        body?: unknown,
        idempotencyKey?: string,
        generation?: number,
      ) =>
        app.fetch(
          new Request(`${ORIGIN}${API}${path}`, {
            method,
            headers: {
              authorization: `Bearer ${apiKey.secret}`,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
              ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
              ...(generation === undefined
                ? {}
                : { "takoform-expected-generation": String(generation) }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      const create = async (form: string, name: string, spec: Record<string, unknown>) => {
        const response = await request(
          "/resources",
          "POST",
          { form, space: organization.id, name, spec },
          `create-${name}-object-worker`,
        );
        if (response.status !== 202) {
          throw new Error(`create ${name} failed (${response.status}): ${await response.text()}`);
        }
        const accepted = (await response.json()) as { id: string; resourceUid: string };
        expect(await app.tickTakoformV2()).toMatchObject({
          id: accepted.id,
          status: "succeeded",
          effect: "complete",
        });
        return accepted;
      };
      const remove = async (uid: string, name: string, generation = 1) => {
        const response = await request(
          `/resources/${uid}`,
          "DELETE",
          undefined,
          `delete-${name}-object-worker`,
          generation,
        );
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as { id: string; resourceUid: string };
        expect(accepted.resourceUid).toBe(uid);
        expect(await app.tickTakoformV2()).toMatchObject({
          id: accepted.id,
          status: "succeeded",
          effect: "complete",
        });
        expect((await request(`/resources/${uid}`)).status).toBe(410);
      };

      const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
      const bucket = await create(OBJECT_BUCKET_FORM_URL, "bucket", {});
      const databaseResource = await create(SQLITE_DATABASE_FORM_URL, "database", {});
      await sqliteStore.withAuthorizedDatabase({
        resourceUid: databaseResource.resourceUid,
        stillAuthorized: async () => true,
        use(database) {
          database.exec("CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
        },
      });
      const namespace = await create(EDGE_KV_NAMESPACE_FORM_URL, "namespace", {});
      const bundle = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
        artifact: { url: MANIFEST_URL, sha256: manifestSha },
      });
      const versionSpec = {
        worker: { resourceUid: worker.resourceUid },
        bundle: { resourceUid: bundle.resourceUid },
        handlers: ["fetch"],
        sqliteBindings: [{ name: "DB", resource: { resourceUid: databaseResource.resourceUid } }],
        kvBindings: [{ name: "CACHE", resource: { resourceUid: namespace.resourceUid } }],
        bucketBindings: [{ name: "MEDIA", resource: { resourceUid: bucket.resourceUid } }],
      };
      const version = await create(WORKER_VERSION_FORM_URL, "version", versionSpec);
      const deployment = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      });
      const endpoint = await create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
        worker: { resourceUid: worker.resourceUid },
      });

      const owner = await activeComposition.ownerForWorkerUid(worker.resourceUid);
      const single = await owner.fetch(
        new Request(`https://worker-${endpoint.resourceUid.slice(0, 8)}.example.test/single`),
      );
      expect(single.status).toBe(200);
      expect(await single.json()).toEqual({
        object: "streamed-value",
        kv: "kv-value",
        sql: 1,
        sqlStored: "sql-value",
      });
      const multipart = await owner.fetch(
        new Request(`https://worker-${endpoint.resourceUid.slice(0, 8)}.example.test/multipart`),
      );
      expect(multipart.status).toBe(200);
      expect(await multipart.text()).toBe("multipart-value");

      const update = await request(
        `/resources/${version.resourceUid}`,
        "PUT",
        { spec: versionSpec },
        "same-spec-version-update-object-worker",
        1,
      );
      expect(update.status).toBe(202);
      const acceptedUpdate = (await update.json()) as { id: string };
      expect(await app.tickTakoformV2()).toMatchObject({
        id: acceptedUpdate.id,
        status: "succeeded",
        effect: "complete",
      });
      const afterUpdate = await owner.fetch(
        new Request(`https://worker-${endpoint.resourceUid.slice(0, 8)}.example.test/single`),
      );
      expect(afterUpdate.status).toBe(200);
      expect(await afterUpdate.json()).toEqual({
        object: "streamed-value",
        kv: "kv-value",
        sql: 1,
        sqlStored: "sql-value",
      });

      await remove(endpoint.resourceUid, "endpoint");
      await remove(deployment.resourceUid, "deployment");
      await remove(version.resourceUid, "version", 2);
      await remove(bucket.resourceUid, "bucket");
      await remove(namespace.resourceUid, "namespace");
      await remove(databaseResource.resourceUid, "database");
      await remove(bundle.resourceUid, "bundle");
      await remove(worker.resourceUid, "worker");
    } catch (error) {
      primaryError = error;
    }
    let suspended = false;
    let cleanupError: unknown;
    try {
      await composition?.suspendOwnersRetainingCustody();
      suspended = true;
      await composition?.closePrivateBindingServices();
    } catch (error) {
      cleanupError = error;
    }
    if (suspended) {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
    if (primaryError !== undefined && cleanupError !== undefined) {
      throw new AggregateError([primaryError, cleanupError], "journey and owner cleanup failed");
    }
    if (primaryError !== undefined) throw primaryError;
    if (cleanupError !== undefined) {
      throw cleanupError;
    }
  },
);
