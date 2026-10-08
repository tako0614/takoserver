import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccounts } from "../src/auth.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { SQLITE_DATABASE_FORM_URL } from "../src/takoform-v2/forms/sqlite-database.ts";
import { SQLITE_MIGRATION_APPLICATION_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-application.ts";
import { SQLITE_MIGRATION_SET_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-set.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("workerd-artifact") ?? null;
const API = "/apis/forms.takoform.com/v2";
const SUFFIX = "workers.native.test";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function startHost(
  root: string,
  workerdBinary: string,
  organizationId: string,
  hashes: readonly string[],
  privatePort: number,
  certPath: string,
  keyPath: string,
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/selfhost-v2-worker-sqlite-normal-ingress-server.ts"),
      root,
      workerdBinary,
      organizationId,
      ...hashes,
      String(privatePort),
      certPath,
      keyPath,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const stderr = new Response(child.stderr).text();
  const events: {
    stage: string;
    port?: number;
    httpsPort?: number;
    pid?: number;
    restored?: string[];
    code?: string;
  }[] = [];
  const reader = child.stdout.getReader();
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        events.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    }
  })();
  async function close() {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await reading;
    await stderr;
    reader.releaseLock();
  }
  try {
    for (let attempt = 0; attempt < 1_000; attempt++) {
      const listening = events.find((event) => event.stage === "listening");
      if (listening?.port && listening.httpsPort && listening.pid)
        return {
          port: listening.port,
          httpsPort: listening.httpsPort,
          pid: listening.pid,
          restored: listening.restored,
          close,
        };
      const failure = events.find((event) => event.stage === "startup_error");
      if (failure) throw new Error(`normal SQLite ingress Host refused: ${failure.code}`);
      if (child.exitCode !== null)
        throw new Error("normal SQLite ingress Host exited before listen");
      await Bun.sleep(10);
    }
    throw new Error("normal SQLite ingress Host did not listen");
  } catch (error) {
    await close();
    throw error;
  }
}

function api(
  port: number,
  secret: string,
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
  generation?: number,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      host: "api.example.test",
      authorization: `Bearer ${secret}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(key ? { "idempotency-key": key } : {}),
      ...(generation === undefined ? {} : { "takoform-expected-generation": String(generation) }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
}

async function settled(port: number, secret: string, id: string) {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const response = await api(port, secret, `${API}/operations/${id}`);
    expect(response.status).toBe(200);
    const operation = (await response.json()) as {
      status: string;
      effect: string;
      error?: unknown;
    };
    if (operation.status === "succeeded") {
      expect(operation.effect).toBe("complete");
      return;
    }
    if (operation.status === "failed") throw new Error(`Operation ${id} failed`);
    await Bun.sleep(10);
  }
  throw new Error(`Operation ${id} did not settle`);
}

function tenantGet(
  port: number,
  hostname: string,
  ca: string,
  path: string,
): Promise<{
  status: number;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port,
        servername: hostname,
        path,
        headers: { host: hostname },
        ca,
        rejectUnauthorized: true,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.setTimeout(10_000, () => request.destroy(new Error("tenant TLS request timed out")));
    request.once("error", reject);
    request.end();
  });
}

test.skipIf(binary === null)(
  "normal HTTPS Endpoint carries SQLite Binding across Host restart, update and deletion",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "v2-sqlite-normal-ingress-"));
    let first: Awaited<ReturnType<typeof startHost>> | undefined;
    let second: Awaited<ReturnType<typeof startHost>> | undefined;
    let failure: unknown;
    const cleanupErrors: unknown[] = [];
    try {
      await chmod(root, 0o700);
      const certPath = join(root, "certificate.pem");
      const keyPath = join(root, "private-key.pem");
      const openssl = Bun.spawn(
        [
          "openssl",
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyPath,
          "-out",
          certPath,
          "-days",
          "2",
          "-subj",
          `/CN=*.${SUFFIX}`,
          "-addext",
          `subjectAltName=DNS:*.${SUFFIX}`,
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      );
      if ((await openssl.exited) !== 0) throw new Error("normal SQLite ingress TLS fixture failed");
      await chmod(keyPath, 0o600);
      const ca = await readFile(certPath, "utf8");
      const database = new Database(join(root, "control.sqlite"));
      migrateSqlite(database);
      const sql = createSqliteSql(database);
      const accounts = createAccounts({
        sql,
        identity: {
          async verify({ assertion }: { assertion: string }) {
            return {
              providerSubject: assertion,
              email: `${assertion}@example.test`,
              displayName: assertion,
            };
          },
        },
      });
      const signedIn = await accounts.signIn({ provider: "google", assertion: "sqlite-owner" });
      const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
      if (!actor) throw new Error("fixture organization owner unavailable");
      const organization = await accounts.createOrganization({ actor, name: "SQLite Ingress Org" });
      const key = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "SQLite ingress writer",
        scopes: ["resources:write"],
        expiresInSeconds: 3_600,
      });
      database.close();
      const objects = createFileObjectStore({ root: join(root, "objects") });
      const code = new TextEncoder().encode(
        "export default { async fetch(request, env) { const url = new URL(request.url); if (url.pathname === '/write') { await env.DB.execute('INSERT INTO records (value) VALUES (?)', [url.searchParams.get('value')]); return new Response('written'); } const result = await env.DB.query('SELECT value FROM records ORDER BY id'); return Response.json(result.rows); } };\n",
      );
      const bundle = new TextEncoder().encode(
        JSON.stringify({
          entrypoint: "index.mjs",
          files: [
            {
              path: "index.mjs",
              url: "https://artifacts.example.test/v2-sqlite/index.mjs",
              sha256: digest(code),
              mediaType: "application/javascript+module",
            },
          ],
        }),
      );
      const migration = new TextEncoder().encode(
        "CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);\n",
      );
      const migrationManifest = new TextEncoder().encode(
        JSON.stringify({
          files: [
            {
              path: "migrations/0001.sql",
              url: "https://artifacts.example.test/v2-sqlite/0001.sql",
              sha256: digest(migration),
              mediaType: "application/sql",
            },
          ],
        }),
      );
      await objects.create("v2-sqlite/module", code);
      await objects.create("v2-sqlite/manifest", bundle);
      await objects.create("v2-sqlite/migration-sql", migration);
      await objects.create("v2-sqlite/migration-manifest", migrationManifest);
      const hashes = [digest(bundle), digest(code), digest(migrationManifest), digest(migration)];
      const reservation = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(null, { status: 503 }),
      });
      const privatePort = reservation.port;
      await reservation.stop(true);
      if (!privatePort) throw new Error("fixture private port unavailable");
      first = await startHost(
        root,
        binary as string,
        organization.id,
        hashes,
        privatePort,
        certPath,
        keyPath,
      );
      expect(first.restored).toEqual([]);
      const create = async (form: string, name: string, spec: unknown, port = first?.port) => {
        if (!port) throw new Error("Host API port unavailable");
        const response = await api(
          port,
          key.secret,
          `${API}/resources`,
          "POST",
          { form, space: organization.id, name, spec },
          `create-${name}-normal-sqlite`,
        );
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as { id: string; resourceUid: string };
        await settled(port, key.secret, accepted.id);
        return accepted.resourceUid;
      };
      const workerUid = await create(MODULE_WORKER_FORM_URL, "worker", {});
      const bundleUid = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
        artifact: {
          url: "https://artifacts.example.test/v2-sqlite/bundle.json",
          sha256: hashes[0],
        },
      });
      const databaseUid = await create(SQLITE_DATABASE_FORM_URL, "database", {});
      const migrationSetUid = await create(SQLITE_MIGRATION_SET_FORM_URL, "migration-set", {
        artifact: {
          url: "https://artifacts.example.test/v2-sqlite/migrations.json",
          sha256: hashes[2],
        },
      });
      const applicationUid = await create(SQLITE_MIGRATION_APPLICATION_FORM_URL, "application", {
        database: { resourceUid: databaseUid },
        migrationSet: { resourceUid: migrationSetUid },
      });
      const applicationRead = await api(
        first.port,
        key.secret,
        `${API}/resources/${applicationUid}`,
      );
      expect(applicationRead.status).toBe(200);
      expect(
        ((await applicationRead.json()) as { observed: { ready: boolean } }).observed.ready,
      ).toBe(true);
      const versionUid = await create(WORKER_VERSION_FORM_URL, "version", {
        worker: { resourceUid: workerUid },
        bundle: { resourceUid: bundleUid },
        handlers: ["fetch"],
        sqliteBindings: [{ name: "DB", resource: { resourceUid: databaseUid } }],
      });
      const deploymentUid = await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
        worker: { resourceUid: workerUid },
        versions: [{ workerVersion: { resourceUid: versionUid }, weight: 10_000 }],
      });
      const endpointUid = await create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
        worker: { resourceUid: workerUid },
      });
      const endpointResponse = await api(first.port, key.secret, `${API}/resources/${endpointUid}`);
      expect(endpointResponse.status).toBe(200);
      const endpoint = (await endpointResponse.json()) as {
        output: { hostname: string; url: string };
        observed: { tlsReady: boolean; activeDeploymentRouteReady: boolean };
      };
      expect(endpoint.observed).toEqual({ tlsReady: true, activeDeploymentRouteReady: true });
      expect(endpoint.output.url).toBe(`https://${endpoint.output.hostname}/`);
      expect(await tenantGet(first.httpsPort, `v2-${"f".repeat(32)}.${SUFFIX}`, ca, "/")).toEqual({
        status: 404,
        body: "",
      });
      expect(
        await tenantGet(
          first.httpsPort,
          endpoint.output.hostname,
          ca,
          "/write?value=before-restart",
        ),
      ).toEqual({ status: 200, body: "written" });
      expect(await tenantGet(first.httpsPort, endpoint.output.hostname, ca, "/")).toEqual({
        status: 200,
        body: '[{"value":"before-restart"}]',
      });
      const ownerKey = digest(new TextEncoder().encode(workerUid));
      const ownerStatePath = join(root, "v2-worker-owners", ownerKey, "runtime-owner.json");
      const priorState = JSON.parse(await readFile(ownerStatePath, "utf8")) as {
        activeOperationId: string | null;
        incarnations: { operationId: string; processIdentity: { pid: number } | null }[];
      };
      const priorChildPid = priorState.incarnations.find(
        (record) => record.operationId === priorState.activeOperationId,
      )?.processIdentity?.pid;
      expect(priorChildPid).toBeGreaterThan(0);
      const oldPid = first.pid;
      await first.close();
      first = undefined;
      second = await startHost(
        root,
        binary as string,
        organization.id,
        hashes,
        privatePort,
        certPath,
        keyPath,
      );
      expect(second.pid).not.toBe(oldPid);
      expect(second.restored).toEqual([workerUid]);
      const recoveredState = JSON.parse(await readFile(ownerStatePath, "utf8")) as {
        activeOperationId: string | null;
        incarnations: { operationId: string; processIdentity: { pid: number } | null }[];
      };
      expect(recoveredState.activeOperationId).toBe(priorState.activeOperationId);
      expect(
        recoveredState.incarnations.find(
          (record) => record.operationId === recoveredState.activeOperationId,
        )?.processIdentity?.pid,
      ).not.toBe(priorChildPid);
      expect(await tenantGet(second.httpsPort, endpoint.output.hostname, ca, "/")).toEqual({
        status: 200,
        body: '[{"value":"before-restart"}]',
      });
      const update = await api(
        second.port,
        key.secret,
        `${API}/resources/${databaseUid}`,
        "PUT",
        { spec: {} },
        "update-database-normal-sqlite",
        1,
      );
      expect(update.status).toBe(202);
      await settled(second.port, key.secret, String(((await update.json()) as { id: string }).id));
      expect(
        await tenantGet(
          second.httpsPort,
          endpoint.output.hostname,
          ca,
          "/write?value=after-update",
        ),
      ).toEqual({ status: 200, body: "written" });
      expect(await tenantGet(second.httpsPort, endpoint.output.hostname, ca, "/")).toEqual({
        status: 200,
        body: '[{"value":"before-restart"},{"value":"after-update"}]',
      });
      const blocked = await api(
        second.port,
        key.secret,
        `${API}/resources/${databaseUid}`,
        "DELETE",
        undefined,
        "blocked-database-normal-sqlite",
        2,
      );
      expect(blocked.status).toBe(409);
      await blocked.arrayBuffer();
      const remove = async (uid: string, name: string, generation: number) => {
        if (!second) throw new Error("recovered Host unavailable");
        const response = await api(
          second.port,
          key.secret,
          `${API}/resources/${uid}`,
          "DELETE",
          undefined,
          `delete-${name}-normal-sqlite`,
          generation,
        );
        expect(response.status).toBe(202);
        await settled(
          second.port,
          key.secret,
          String(((await response.json()) as { id: string }).id),
        );
      };
      await remove(endpointUid, "endpoint", 1);
      expect((await tenantGet(second.httpsPort, endpoint.output.hostname, ca, "/")).status).toBe(
        503,
      );
      await remove(deploymentUid, "deployment", 1);
      await remove(versionUid, "version", 1);
      await remove(applicationUid, "application", 1);
      await remove(migrationSetUid, "migration-set", 1);
      await remove(databaseUid, "database", 2);
      await expect(
        stat(join(root, "sqlite-custody", "resources", databaseUid, "database.sqlite")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await remove(bundleUid, "bundle", 1);
      await remove(workerUid, "worker", 1);
    } catch (error) {
      failure = error;
    } finally {
      for (const host of [second, first]) {
        if (!host) continue;
        try {
          await host.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (failure && cleanupErrors.length === 0) throw failure;
    if (cleanupErrors.length) {
      throw new AggregateError(
        [...(failure ? [failure] : []), ...cleanupErrors],
        "normal SQLite ingress journey or cleanup failed",
      );
    }
  },
  30_000,
);
