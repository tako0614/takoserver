import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { createAccounts } from "../src/auth.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createSelfhostV2SQLiteStore } from "../src/providers/selfhost-v2-sqlite-store.ts";
import { SELFHOST_DATA_PLANE_SQL_PATH } from "../src/providers/selfhost-worker-wrapper.ts";
import { createSelfhostV2WorkerComposition } from "../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { SQLITE_DATABASE_FORM_URL } from "../src/takoform-v2/forms/sqlite-database.ts";
import { createSQLiteDatabaseForm } from "../src/takoform-v2/forms/sqlite-database-backend.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { WorkerdWorkerRuntimeOwner } from "../src/workerd-worker-runtime-owner.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const API = "/apis/forms.takoform.com/v2";
const ORIGIN = "https://api.example.test";
const TARGET = "selfhost-v2-worker-primary";
const binary = nativeEvidenceBinary("workerd-artifact") ?? null;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("SQLite broker boot requires an existing key and stable port before owner restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfhost-v2-sqlite-boot-"));
  const database = new Database(join(root, "control.sqlite"));
  let composition: ReturnType<typeof createSelfhostV2WorkerComposition> | undefined;
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const store = createSelfhostV2SQLiteStore({
      root: join(root, "sqlite-custody"),
      sql,
      targetKey: TARGET,
    });
    const objects = createMemoryObjectStore();
    const clock = () => new Date();
    const config = {
      cursorSigningKey: new Uint8Array(32).fill(0x51),
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/authentication",
    };
    const options = {
      sql,
      objects,
      clock,
      config,
      rootDirectory: join(root, "v2-worker-owners"),
      targetKey: TARGET,
      workerdBinary: null,
    };
    expect(() =>
      createSelfhostV2WorkerComposition({
        ...options,
        sqliteBinding: { store, signingKey: new Uint8Array(32), privatePort: 0 },
      }),
    ).toThrow(TypeError);
    expect(() =>
      createSelfhostV2WorkerComposition({
        ...options,
        sqliteBinding: { store, signingKey: new Uint8Array(31), privatePort: 12345 },
      }),
    ).toThrow(TypeError);
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 503 }),
    });
    const privatePort = reservation.port;
    await reservation.stop(true);
    if (!privatePort) throw new Error("fixture private port unavailable");
    const supplied = { store, signingKey: new Uint8Array(32).fill(0x58), privatePort };
    composition = createSelfhostV2WorkerComposition({ ...options, sqliteBinding: supplied });
    supplied.privatePort = 1;
    supplied.signingKey.fill(0);
    expect(await composition.restoreOwners()).toEqual([]);
    const response = await fetch(`http://127.0.0.1:${privatePort}${SELFHOST_DATA_PLANE_SQL_PATH}`, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(401);
  } finally {
    await composition?.closePrivateBindingServices();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(binary === null)(
  "normal organization HTTP accepts a Version with one real SQLiteDatabase UID binding",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "selfhost-v2-worker-sqlite-"));
    const database = new Database(join(root, "control.sqlite"));
    try {
      migrateSqlite(database);
      const sql = createSqliteSql(database);
      const objects = createMemoryObjectStore();
      const clock = () => new Date();
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
      const signedIn = await accounts.signIn({ provider: "google", assertion: "sqlite-owner" });
      const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
      if (!actor) throw new Error("fixture organization owner unavailable");
      const organization = await accounts.createOrganization({ actor, name: "SQLite Worker Org" });
      const key = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "sqlite worker writer",
        scopes: ["resources:write"],
        expiresInSeconds: 3_600,
      });
      const moduleUrl = "https://artifacts.example.test/v2-sqlite/index.mjs";
      const manifestUrl = "https://artifacts.example.test/v2-sqlite/bundle.json";
      const code = new TextEncoder().encode(
        "export default { async fetch(request, env) { const url = new URL(request.url); if (url.pathname === '/write') { await env.DB.execute('INSERT INTO records (value) VALUES (?)', [url.searchParams.get('value')]); return new Response('written'); } const r = await env.DB.query('SELECT value FROM records ORDER BY id'); return Response.json(r.rows); } };\n",
      );
      const manifest = new TextEncoder().encode(
        JSON.stringify({
          entrypoint: "index.mjs",
          files: [
            {
              path: "index.mjs",
              url: moduleUrl,
              sha256: sha256(code),
              mediaType: "application/javascript+module",
            },
          ],
        }),
      );
      await objects.create("v2-sqlite/module", code);
      await objects.create("v2-sqlite/manifest", manifest);
      const config = {
        cursorSigningKey: new Uint8Array(32).fill(0x51),
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
        workerBundle: {
          targetKey: TARGET,
          heldArtifacts: [
            {
              url: manifestUrl,
              sha256: sha256(manifest),
              objectKey: "v2-sqlite/manifest",
              grants: [{ principal: `org:${organization.id}`, space: organization.id }],
            },
            {
              url: moduleUrl,
              sha256: sha256(code),
              objectKey: "v2-sqlite/module",
              grants: [{ principal: `org:${organization.id}`, space: organization.id }],
            },
          ],
        },
      };
      const store = createSelfhostV2SQLiteStore({
        root: join(root, "sqlite-custody"),
        sql,
        targetKey: TARGET,
      });
      const portReservation = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(null, { status: 503 }),
      });
      const sqlitePrivatePort = portReservation.port;
      await portReservation.stop(true);
      if (!sqlitePrivatePort) throw new Error("fixture private port unavailable");
      let composition: ReturnType<typeof createSelfhostV2WorkerComposition>;
      composition = createSelfhostV2WorkerComposition({
        sql,
        objects,
        clock,
        config,
        rootDirectory: join(root, "v2-worker-owners"),
        targetKey: TARGET,
        workerdBinary: binary,
        // Fixture-only deterministic key and selected port are held across a
        // restart in the subprocess journey; neither is a tenant input.
        sqliteBinding: {
          store,
          signingKey: new Uint8Array(32).fill(0x58),
          privatePort: sqlitePrivatePort,
        },
        endpoint: {
          assignHostname({ resourceUid }) {
            return `worker-${resourceUid.slice(0, 8)}.example.test`;
          },
          async observeTls(input) {
            const owner = await composition.ownerForWorkerUid(input.workerUid);
            const serving = await owner.observeServing({
              workerResourceUid: input.workerUid,
              targetKey: TARGET,
            });
            return {
              ...input,
              ready: serving.kind === "serving" && serving.hostnames.includes(input.hostname),
            };
          },
          async observeRouteAbsent(input) {
            const owner = await composition.ownerForWorkerUid(input.workerUid);
            const serving = await owner.observeServing({
              workerResourceUid: input.workerUid,
              targetKey: TARGET,
            });
            return {
              ...input,
              absent: serving.kind === "serving" && !serving.hostnames.includes(input.hostname),
            };
          },
        },
      });
      expect(await composition.restoreOwners()).toEqual([]);
      const app = buildApp({
        sql,
        objects,
        clock,
        identity,
        settlement: {
          async verify() {
            throw new Error("fixture settlement unavailable");
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
            ...composition.internalFormFactory(context),
            [SQLITE_DATABASE_FORM_URL]: createSQLiteDatabaseForm({ store }),
          };
        },
      });
      const request = (path: string, method: string, body: unknown, replayKey: string) =>
        app.fetch(
          new Request(`${ORIGIN}${API}${path}`, {
            method,
            headers: {
              authorization: `Bearer ${key.secret}`,
              "content-type": "application/json",
              "idempotency-key": replayKey,
            },
            body: JSON.stringify(body),
          }),
        );
      const created: { uid: string; name: string; generation: number }[] = [];
      let owner: WorkerdWorkerRuntimeOwner | undefined;
      const create = async (form: string, name: string, spec: unknown) => {
        const response = await request(
          "/resources",
          "POST",
          { form, space: organization.id, name, spec },
          `create-${name}-sqlite-worker`,
        );
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as { id: string; resourceUid: string };
        expect(await app.tickTakoformV2()).toMatchObject({
          id: accepted.id,
          status: "succeeded",
          effect: "complete",
        });
        created.push({ uid: accepted.resourceUid, name, generation: 1 });
        return accepted.resourceUid;
      };
      const removeLast = async () => {
        const resource = created.at(-1);
        if (!resource) return;
        const response = await app.fetch(
          new Request(`${ORIGIN}${API}/resources/${resource.uid}`, {
            method: "DELETE",
            headers: {
              authorization: `Bearer ${key.secret}`,
              "idempotency-key": `delete-${resource.name}-sqlite-worker`,
              "takoform-expected-generation": String(resource.generation),
            },
          }),
        );
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as { id: string };
        expect(await app.tickTakoformV2()).toMatchObject({
          id: accepted.id,
          status: "succeeded",
          effect: "complete",
        });
        created.pop();
      };
      try {
        const workerUid = await create(MODULE_WORKER_FORM_URL, "worker", {});
        owner = await composition.ownerForWorkerUid(workerUid);
        const bundleUid = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
          artifact: { url: manifestUrl, sha256: sha256(manifest) },
        });
        const databaseUid = await create(SQLITE_DATABASE_FORM_URL, "database", {});
        await store.withAuthorizedDatabase({
          resourceUid: databaseUid,
          // Test-only schema fixture. The Worker itself cannot issue DDL.
          stillAuthorized: async () => true,
          use(database) {
            database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
          },
        });
        const versionUid = await create(WORKER_VERSION_FORM_URL, "version", {
          worker: { resourceUid: workerUid },
          bundle: { resourceUid: bundleUid },
          handlers: ["fetch"],
          sqliteBindings: [{ name: "DB", resource: { resourceUid: databaseUid } }],
        });
        expect(versionUid).toBeTruthy();
        await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
          worker: { resourceUid: workerUid },
          versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
        });
        await create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
          worker: { resourceUid: workerUid },
        });
        const serving = await owner.observeServing({
          workerResourceUid: workerUid,
          targetKey: TARGET,
        });
        expect(serving.kind).toBe("serving");
        if (serving.kind !== "serving" || serving.hostnames.length !== 1)
          throw new Error("native Worker serving proof unavailable");
        const hostname = serving.hostnames[0];
        const write = await owner.fetch(
          new Request(`https://${hostname}/write?value=from-native-worker`),
        );
        expect(write.status).toBe(200);
        expect(await write.text()).toBe("written");
        const read = await owner.fetch(new Request(`https://${hostname}/`));
        expect(read.status).toBe(200);
        expect(await read.json()).toEqual([{ value: "from-native-worker" }]);
        await expect(composition.closePrivateBindingServices()).rejects.toThrow();
        const stillServed = await owner.fetch(new Request(`https://${hostname}/`));
        expect(stillServed.status).toBe(200);
        expect(await stillServed.json()).toEqual([{ value: "from-native-worker" }]);
        while (created.length > 0) await removeLast();
        await owner.close();
        owner = undefined;
      } finally {
        while (created.length > 0) {
          try {
            await removeLast();
          } catch {
            break;
          }
        }
        await owner?.close().catch(() => undefined);
        await composition.closePrivateBindingServices();
      }
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
