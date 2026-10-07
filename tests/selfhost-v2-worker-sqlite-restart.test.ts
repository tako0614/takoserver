import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { type LinuxProcessIdentity, linuxProcessLiveness } from "../src/workerd-linux-process.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("workerd-artifact") ?? null;
const API = "/apis/forms.takoform.com/v2";

type Event = {
  stage: "listening" | "startup_error" | "tick_error";
  port?: number;
  pid?: number;
  restored?: string[];
  code?: string;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function startHost(
  root: string,
  workerdBinary: string,
  organizationId: string,
  hashes: readonly string[],
  privatePort: number,
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/selfhost-v2-worker-sqlite-server.ts"),
      root,
      workerdBinary,
      organizationId,
      ...hashes,
      String(privatePort),
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const errors = new Response(child.stderr).text();
  const events: Event[] = [];
  const reader = child.stdout.getReader();
  const reading = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        events.push(JSON.parse(buffer.slice(0, end)) as Event);
        buffer = buffer.slice(end + 1);
      }
    }
  })();
  async function close() {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await reading;
    await errors;
    reader.releaseLock();
  }
  try {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const listening = events.find((event) => event.stage === "listening");
      if (listening?.port && listening.pid)
        return { close, port: listening.port, pid: listening.pid, restored: listening.restored };
      const failure = events.find((event) => event.stage === "startup_error");
      if (failure) throw new Error(`SQLite Worker Host refused: ${failure.code}`);
      if (child.exitCode !== null) throw new Error("SQLite Worker Host exited before listening");
      await Bun.sleep(10);
    }
    throw new Error("SQLite Worker Host did not listen");
  } catch (error) {
    await close();
    throw error;
  }
}

async function request(
  port: number,
  key: string,
  path: string,
  method = "GET",
  body?: unknown,
  replayKey?: string,
  expectedGeneration?: number,
): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      host: "api.example.test",
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(replayKey ? { "idempotency-key": replayKey } : {}),
      ...(expectedGeneration === undefined
        ? {}
        : { "takoform-expected-generation": String(expectedGeneration) }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
}

async function settled(port: number, key: string, operationId: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const response = await request(port, key, `${API}/operations/${operationId}`);
    expect(response.status).toBe(200);
    const operation = (await response.json()) as { status: string; effect: string };
    if (operation.status === "succeeded") {
      expect(operation.effect).toBe("complete");
      return;
    }
    if (operation.status === "failed") throw new Error("SQLite Worker operation failed");
    await Bun.sleep(10);
  }
  throw new Error("SQLite Worker operation did not settle");
}

test.skipIf(binary === null)(
  "normal Host reopens the same SQLite-bound Version after SIGKILL and preserves native SQL rows",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "selfhost-v2-worker-sqlite-restart-"));
    let first: Awaited<ReturnType<typeof startHost>> | undefined;
    let second: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
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
      const organization = await accounts.createOrganization({ actor, name: "SQLite Worker Org" });
      const key = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: "sqlite worker writer",
        scopes: ["resources:write"],
        expiresInSeconds: 3_600,
      });
      database.close();

      const objects = createFileObjectStore({ root: join(root, "objects") });
      const code = new TextEncoder().encode(
        "export default { async fetch(request, env) { const url = new URL(request.url); if (url.pathname === '/write') { await env.DB.execute('INSERT INTO records (value) VALUES (?)', [url.searchParams.get('value')]); return new Response('written'); } if (url.pathname === '/wait') { await env.DB.execute(\"INSERT INTO records (value) VALUES ('wait-started')\"); for (let n = 0; n < 20; n++) { const old = await env.DB.query(\"SELECT value FROM records WHERE value = 'wait-started'\"); if (old.rows.length !== 1) throw new Error('old row unavailable'); await new Promise(resolve => setTimeout(resolve, 80)); } return new Response('old-version-finished'); } const result = await env.DB.query('SELECT value FROM records ORDER BY id'); return Response.json(result.rows); } };\n",
      );
      const bundle = new TextEncoder().encode(
        JSON.stringify({
          entrypoint: "index.mjs",
          files: [
            {
              path: "index.mjs",
              url: "https://artifacts.example.test/v2-sqlite/index.mjs",
              sha256: sha256(code),
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
              sha256: sha256(migration),
              mediaType: "application/sql",
            },
          ],
        }),
      );
      await objects.create("v2-sqlite/module", code);
      await objects.create("v2-sqlite/manifest", bundle);
      await objects.create("v2-sqlite/migration-sql", migration);
      await objects.create("v2-sqlite/migration-manifest", migrationManifest);
      const hashes = [sha256(bundle), sha256(code), sha256(migrationManifest), sha256(migration)];
      const reservation = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(null, { status: 503 }),
      });
      const privatePort = reservation.port;
      await reservation.stop(true);
      if (!privatePort) throw new Error("fixture private port unavailable");
      first = await startHost(root, binary as string, organization.id, hashes, privatePort);
      expect(first.restored).toEqual([]);
      const initial = first;
      const create = async (form: string, name: string, spec: unknown, port = initial.port) => {
        const response = await request(
          port,
          key.secret,
          `${API}/resources`,
          "POST",
          { form, space: organization.id, name, spec },
          `create-${name}-sqlite-restart`,
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
      const migrationApplicationUid = await create(
        SQLITE_MIGRATION_APPLICATION_FORM_URL,
        "migration-application",
        {
          database: { resourceUid: databaseUid },
          migrationSet: { resourceUid: migrationSetUid },
        },
      );
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
      const beforeWrite = await request(
        initial.port,
        key.secret,
        `/__fixture/serve/${workerUid}/write?value=before-restart`,
      );
      expect(beforeWrite.status).toBe(200);
      expect(await beforeWrite.text()).toBe("written");
      const beforeRead = await request(initial.port, key.secret, `/__fixture/serve/${workerUid}/`);
      expect(beforeRead.status).toBe(200);
      expect(await beforeRead.json()).toEqual([{ value: "before-restart" }]);
      const deniedClose = await request(
        initial.port,
        key.secret,
        "/__fixture/close-private-bindings",
        "POST",
      );
      expect(deniedClose.status).toBe(409);
      const afterCloseAttempt = await request(
        initial.port,
        key.secret,
        `/__fixture/serve/${workerUid}/`,
      );
      expect(afterCloseAttempt.status).toBe(200);
      expect(await afterCloseAttempt.json()).toEqual([{ value: "before-restart" }]);
      const ownerKey = createHash("sha256").update(workerUid).digest("hex");
      const state = JSON.parse(
        await readFile(join(root, "v2-worker-owners", ownerKey, "runtime-owner.json"), "utf8"),
      ) as {
        activeOperationId: string | null;
        incarnations: {
          operationId: string;
          processIdentity: LinuxProcessIdentity | null;
          identity: unknown;
        }[];
      };
      const priorChildren = state.incarnations.flatMap((record) =>
        record.processIdentity ? [record.processIdentity] : [],
      );
      expect(priorChildren.length).toBeGreaterThan(0);
      const firstPid = initial.pid;
      await first.close();
      first = undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          (await Promise.all(priorChildren.map(linuxProcessLiveness))).every(
            (result) => result === "stale",
          )
        )
          break;
        await Bun.sleep(10);
      }
      expect(await Promise.all(priorChildren.map(linuxProcessLiveness))).toEqual(
        priorChildren.map(() => "stale"),
      );
      const recoveredHost = await startHost(
        root,
        binary as string,
        organization.id,
        hashes,
        privatePort,
      );
      second = recoveredHost;
      expect(recoveredHost.pid).not.toBe(firstPid);
      expect(recoveredHost.restored).toEqual([workerUid]);
      const recoveredState = JSON.parse(
        await readFile(join(root, "v2-worker-owners", ownerKey, "runtime-owner.json"), "utf8"),
      ) as {
        activeOperationId: string | null;
        incarnations: {
          operationId: string;
          processIdentity: LinuxProcessIdentity | null;
          identity: unknown;
        }[];
      };
      expect(recoveredState.activeOperationId).toBe(state.activeOperationId);
      const priorActive = state.incarnations.find(
        (record) => record.operationId === state.activeOperationId,
      );
      const recoveredActive = recoveredState.incarnations.find(
        (record) => record.operationId === recoveredState.activeOperationId,
      );
      expect(state.activeOperationId).not.toBeNull();
      expect(priorActive).toBeDefined();
      expect(recoveredActive).toBeDefined();
      expect(recoveredActive?.identity).toEqual(priorActive?.identity);
      expect(recoveredActive?.processIdentity?.pid).not.toBe(priorActive?.processIdentity?.pid);
      const afterRead = await request(
        recoveredHost.port,
        key.secret,
        `/__fixture/serve/${workerUid}/`,
      );
      expect(afterRead.status).toBe(200);
      expect(await afterRead.json()).toEqual([{ value: "before-restart" }]);
      const databaseUpdate = await request(
        recoveredHost.port,
        key.secret,
        `${API}/resources/${databaseUid}`,
        "PUT",
        { spec: {} },
        "same-database-sqlite-restart",
        1,
      );
      expect(databaseUpdate.status).toBe(202);
      const updateOperation = (await databaseUpdate.json()) as { id: string };
      await settled(recoveredHost.port, key.secret, updateOperation.id);
      const afterWrite = await request(
        recoveredHost.port,
        key.secret,
        `/__fixture/serve/${workerUid}/write?value=after-update`,
      );
      expect(afterWrite.status).toBe(200);
      expect(await afterWrite.text()).toBe("written");
      const finalRead = await request(
        recoveredHost.port,
        key.secret,
        `/__fixture/serve/${workerUid}/`,
      );
      expect(finalRead.status).toBe(200);
      expect(await finalRead.json()).toEqual([
        { value: "before-restart" },
        { value: "after-update" },
      ]);
      const versionTwoUid = await create(
        WORKER_VERSION_FORM_URL,
        "version-two",
        {
          worker: { resourceUid: workerUid },
          bundle: { resourceUid: bundleUid },
          handlers: ["fetch"],
          sqliteBindings: [{ name: "DB", resource: { resourceUid: databaseUid } }],
        },
        recoveredHost.port,
      );
      // The raw file is read only as a test barrier. Every Worker SQL operation
      // before, during, and after publication still traverses the private broker.
      const databasePath = join(
        root,
        "sqlite-custody",
        "resources",
        databaseUid,
        "database.sqlite",
      );
      const controlDatabase = new Database(databasePath, { readonly: true });
      let oldSettled = false;
      const oldInvocation = request(
        recoveredHost.port,
        key.secret,
        `/__fixture/serve/${workerUid}/wait`,
      )
        .catch(() => new Response(null, { status: 599 }))
        .then((response) => {
          oldSettled = true;
          return response;
        });
      try {
        let started = false;
        for (let attempt = 0; attempt < 250; attempt += 1) {
          if (controlDatabase.query("SELECT 1 FROM records WHERE value = 'wait-started'").get()) {
            started = true;
            break;
          }
          await Bun.sleep(10);
        }
        expect(started).toBe(true);
        await Bun.sleep(100);
        expect(oldSettled).toBe(false);
        const deploymentUpdate = await request(
          recoveredHost.port,
          key.secret,
          `${API}/resources/${deploymentUid}`,
          "PUT",
          {
            spec: {
              worker: { resourceUid: workerUid },
              versions: [{ workerVersion: { resourceUid: versionTwoUid }, weight: 10_000 }],
            },
          },
          "replace-version-sqlite-restart",
          1,
        );
        expect(deploymentUpdate.status).toBe(202);
        await settled(
          recoveredHost.port,
          key.secret,
          ((await deploymentUpdate.json()) as { id: string }).id,
        );
        const switchedState = JSON.parse(
          await readFile(join(root, "v2-worker-owners", ownerKey, "runtime-owner.json"), "utf8"),
        ) as {
          activeOperationId: string | null;
          incarnations: {
            operationId: string;
            status: string;
            identity: { versions: { workerVersionUid: string }[] } | null;
          }[];
        };
        expect(
          switchedState.incarnations.find(
            (record) => record.operationId === recoveredState.activeOperationId,
          )?.status,
        ).toBe("draining");
        expect(
          switchedState.incarnations
            .find((record) => record.operationId === switchedState.activeOperationId)
            ?.identity?.versions.map((version) => version.workerVersionUid),
        ).toEqual([versionTwoUid]);
        expect(oldSettled).toBe(false);
        const oldResult = await oldInvocation;
        expect(oldResult.status).toBe(200);
        expect(await oldResult.text()).toBe("old-version-finished");
        const successorRead = await request(
          recoveredHost.port,
          key.secret,
          `/__fixture/serve/${workerUid}/`,
        );
        expect(successorRead.status).toBe(200);
        expect(await successorRead.json()).toEqual([
          { value: "before-restart" },
          { value: "after-update" },
          { value: "wait-started" },
        ]);
      } finally {
        controlDatabase.close();
      }
      const remove = async (uid: string, name: string, generation: number) => {
        const response = await request(
          recoveredHost.port,
          key.secret,
          `${API}/resources/${uid}`,
          "DELETE",
          undefined,
          `delete-${name}-sqlite-restart`,
          generation,
        );
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as { id: string };
        await settled(recoveredHost.port, key.secret, accepted.id);
      };
      await remove(endpointUid, "endpoint", 1);
      await remove(deploymentUid, "deployment", 2);
      await remove(versionTwoUid, "version-two", 1);
      await remove(versionUid, "version", 1);
      await remove(migrationApplicationUid, "migration-application", 1);
      await remove(migrationSetUid, "migration-set", 1);
      await remove(databaseUid, "database", 2);
      await remove(bundleUid, "bundle", 1);
      await remove(workerUid, "worker", 1);
    } finally {
      await second?.close();
      await first?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
