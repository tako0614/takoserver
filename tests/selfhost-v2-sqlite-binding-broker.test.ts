import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSelfhostV2SqliteBindingBroker } from "../src/providers/selfhost-v2-sqlite-binding-broker.ts";
import { createSelfhostV2SQLiteStore } from "../src/providers/selfhost-v2-sqlite-store.ts";
import { v2SqliteWorkerProjection } from "../src/providers/selfhost-v2-sqlite-worker-projection.ts";
import {
  SELFHOST_DATA_PLANE_PROTOCOL,
  SELFHOST_DATA_PLANE_SQL_PATH,
} from "../src/providers/selfhost-worker-wrapper.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { SQLITE_DATABASE_FORM_URL } from "../src/takoform-v2/forms/sqlite-database.ts";
import { createSQLiteDatabaseForm } from "../src/takoform-v2/forms/sqlite-database-backend.ts";
import { createSQLiteWorkerBindingAuthority } from "../src/takoform-v2/forms/sqlite-worker-binding-authority.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";
import { compileWorkerdVersionGraph } from "../src/workerd-version-graph.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const TARGET = "sqlite-binding-target";
const BUNDLE_FORM = "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/";
const WORKERD = nativeEvidenceBinary("workerd-artifact");

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "v2-sqlite-binding-"));
  const control = new Database(join(root, "control.sqlite"));
  control.exec("PRAGMA foreign_keys = ON");
  for (const name of [
    "0070_takoform_v2.sql",
    "0071_v2_sqlite_migration_set_custody.sql",
    "0073_v2_reference_acceptance.sql",
    "0081_v2_private_inputs.sql",
  ]) {
    control.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const sql = createSqliteSql(control);
  const store = createSelfhostV2SQLiteStore({ root: join(root, "native"), sql, targetKey: TARGET });
  const engine = createTakoformV2Engine({
    sql,
    replayWindowSeconds: 120,
    leaseMilliseconds: 1_000,
    forms: { [SQLITE_DATABASE_FORM_URL]: createSQLiteDatabaseForm({ store }) },
    async authorize() {
      return true;
    },
  });
  const created = await engine.acceptCreate({
    principal: "alice",
    key: "sqlite-binding-create-0001",
    input: { form: SQLITE_DATABASE_FORM_URL, space: "default", name: "db", spec: {} },
  });
  expect((await engine.runNext())?.status).toBe("succeeded");
  const databaseUid = created.resourceUid;
  await store.withAuthorizedDatabase({
    resourceUid: databaseUid,
    stillAuthorized: async () => true,
    use(database) {
      database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    },
  });
  function settled(uid: string, form: string, name: string) {
    control
      .prepare(`INSERT INTO tf_v2_resources
      (uid, principal, form_url, space, name, backend_id, target_key, active_name,
       generation, observed_generation, phase, spec_json, observed_json, last_operation)
      VALUES (?, 'alice', ?, 'default', ?, 'worker-backend', ?, ?, 1, 1, 'idle', '{}',
        '{"ready":true}', ?)`)
      .run(uid, form, name, TARGET, name, `op-${uid}`);
    control
      .prepare(`INSERT INTO tf_v2_operations
      (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,status,effect,
       created_at,updated_at,retain_until,backend_id,target_key,backend_key,accepted_spec_json)
      VALUES (?,?,'alice',?,'fp','create',1,'succeeded','complete',
       '2026-10-07T00:00:00Z','2026-10-07T00:00:00Z','2026-10-08T00:00:00Z',
       'worker-backend',?,?,'{}')`)
      .run(`op-${uid}`, uid, `replay-${uid}`, TARGET, `key-${uid}`);
  }
  settled("worker-one", MODULE_WORKER_FORM_URL, "worker");
  settled("bundle-one", BUNDLE_FORM, "bundle");
  const spec = JSON.stringify({
    worker: { resourceUid: "worker-one" },
    bundle: { resourceUid: "bundle-one" },
    handlers: ["fetch"],
    sqliteBindings: [{ name: "DB", resource: { resourceUid: databaseUid } }],
  });
  control
    .prepare(`INSERT INTO tf_v2_resources
    (uid,principal,form_url,space,name,backend_id,target_key,active_name,generation,
     observed_generation,phase,spec_json,last_operation,busy_operation)
    VALUES ('version-one','alice',?,'default','version','worker-backend',?,'version',
      1,0,'pending',?,'op-version-one','op-version-one')`)
    .run(WORKER_VERSION_FORM_URL, TARGET, spec);
  control
    .prepare(`INSERT INTO tf_v2_operations
    (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,status,effect,
     created_at,updated_at,retain_until,backend_id,target_key,backend_key,accepted_spec_json)
    VALUES ('op-version-one','version-one','alice','replay-version','fp','create',1,
      'queued','none','2026-10-07T00:00:00Z','2026-10-07T00:00:00Z',
      '2026-10-08T00:00:00Z','worker-backend',?,'key-version',?)`)
    .run(TARGET, spec);
  control.exec(
    "INSERT INTO tf_v2_operation_reference_sets (operation_id, sealed) VALUES ('op-version-one', 0)",
  );
  const referenceTargets: [string, string][] = [
    ["worker-one", MODULE_WORKER_FORM_URL],
    ["bundle-one", BUNDLE_FORM],
    [databaseUid, SQLITE_DATABASE_FORM_URL],
  ];
  for (const [uid, form] of referenceTargets) {
    control
      .prepare(`INSERT INTO tf_v2_operation_references
      (operation_id,target_uid,form_url,readiness) VALUES ('op-version-one',?,?,'observed')`)
      .run(uid, form);
  }
  control.exec(
    "UPDATE tf_v2_operation_reference_sets SET sealed=1 WHERE operation_id='op-version-one'",
  );
  control.exec("UPDATE tf_v2_operations SET status='running' WHERE id='op-version-one'");
  control.exec(
    "UPDATE tf_v2_operations SET status='reconciling', effect='unknown' WHERE id='op-version-one'",
  );
  control.exec(`UPDATE tf_v2_operations SET status='succeeded', effect='complete',
    result_observed_json='{"ready":true}' WHERE id='op-version-one'`);
  const grant = {
    principal: "alice",
    space: "default",
    targetKey: TARGET,
    workerUid: "worker-one",
    workerVersionUid: "version-one",
    nativeVersionId: "v2-native-one",
    incarnationId: "incarnation-one",
    servingSourceOperationId: "source-operation-one",
    bindings: [{ name: "DB", resourceUid: databaseUid }],
  };
  let nativeCurrent = true;
  let graphCurrent = true;
  const authority = createSQLiteWorkerBindingAuthority({ sql, targetKey: TARGET });
  const broker = createSelfhostV2SqliteBindingBroker({
    store,
    signingKey: new Uint8Array(32).fill(7),
    resolveCurrentBinding: authority.resolveCurrentBinding,
    async observeVersionTarget(input) {
      return nativeCurrent
        ? { kind: "confirmed" as const, ...input, status: "active" as const }
        : { kind: "unknown" as const };
    },
    async graphStillCurrent() {
      return graphCurrent;
    },
  });
  const token = broker.issueGrant(grant);
  async function call(op: string, statement?: unknown, binding = "DB") {
    const request = new Request(`http://localhost${SELFHOST_DATA_PLANE_SQL_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ protocol: SELFHOST_DATA_PLANE_PROTOCOL, binding, op, statement }),
    });
    const response = await broker.handle(request);
    return response ? await response.json() : null;
  }
  return {
    root,
    control,
    sql,
    store,
    engine,
    databaseUid,
    broker,
    grant,
    token,
    call,
    stopNative() {
      nativeCurrent = false;
    },
    stopGraph() {
      graphCurrent = false;
    },
    close() {
      control.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a SQLite binding broker requires private signing authority", () => {
  expect(() => createSelfhostV2SqliteBindingBroker({} as never)).toThrow(TypeError);
});

test("a signed Version binding reaches only its current UID database and survives same-spec PUT", async () => {
  const host = await fixture();
  try {
    expect(
      await host.call("execute", {
        sql: "INSERT INTO records (id, body) VALUES (?, ?)",
        params: [1, "kept"],
      }),
    ).toEqual({
      ok: true,
      value: { rows: [], rowsWritten: 1 },
    });
    expect(
      await host.call("query", { sql: "SELECT body FROM records WHERE id = ?", params: [1] }),
    ).toEqual({
      ok: true,
      value: { rows: [{ body: "kept" }], rowsWritten: 0 },
    });
    expect(await host.call("query", { sql: "SELECT body FROM records" }, "OTHER")).toEqual({
      ok: false,
      error: { code: "backend_unavailable" },
    });
    const update = await host.engine.acceptUpdate({
      principal: "alice",
      key: "sqlite-binding-update-0001",
      uid: host.databaseUid,
      expectedGeneration: 1,
      spec: {},
    });
    expect(await host.call("query", { sql: "SELECT body FROM records" })).toEqual({
      ok: false,
      error: { code: "backend_unavailable" },
    });
    expect((await host.engine.runNext())?.status).toBe("succeeded");
    expect(update.generation).toBe(2);
    expect(await host.call("query", { sql: "SELECT body FROM records" })).toEqual({
      ok: true,
      value: { rows: [{ body: "kept" }], rowsWritten: 0 },
    });
    host.stopNative();
    expect(await host.call("query", { sql: "SELECT body FROM records" })).toEqual({
      ok: false,
      error: { code: "backend_unavailable" },
    });
  } finally {
    host.close();
  }
});

test("forged, foreign, unselected, and non-current grants cannot open the UID file", async () => {
  const host = await fixture();
  try {
    const route = `http://localhost${SELFHOST_DATA_PLANE_SQL_PATH}`;
    const body = JSON.stringify({
      protocol: SELFHOST_DATA_PLANE_PROTOCOL,
      binding: "DB",
      op: "query",
      statement: { sql: "SELECT body FROM records" },
    });
    async function request(token: string) {
      const response = await host.broker.handle(
        new Request(route, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body,
        }),
      );
      return response ? { status: response.status, value: await response.json() } : null;
    }
    const forged = `${host.token.slice(0, -1)}${host.token.endsWith("A") ? "B" : "A"}`;
    expect(await request(forged)).toEqual({
      status: 401,
      value: { ok: false, error: { code: "backend_unavailable" } },
    });
    const foreign = host.broker.issueGrant({
      ...host.grant,
      principal: "mallory",
    });
    expect(await request(foreign)).toEqual({
      status: 200,
      value: { ok: false, error: { code: "backend_unavailable" } },
    });
    const substituted = host.broker.issueGrant({
      ...host.grant,
      bindings: [{ name: "DB", resourceUid: "another-resource" }],
    });
    expect(await request(substituted)).toEqual({
      status: 200,
      value: { ok: false, error: { code: "backend_unavailable" } },
    });
    host.stopGraph();
    expect(await request(host.token)).toEqual({
      status: 200,
      value: { ok: false, error: { code: "backend_unavailable" } },
    });
  } finally {
    host.close();
  }
});

test("a changed private owner receipt refuses SQL even with a signed, current Core grant", async () => {
  const host = await fixture();
  try {
    const receipt = join(host.root, "native", "resources", host.databaseUid, "owner.json");
    writeFileSync(
      receipt,
      JSON.stringify({
        version: 1,
        resourceUid: "foreign-uid",
        targetKey: TARGET,
        createOperationId: "foreign-operation",
      }),
    );
    expect(await host.call("query", { sql: "SELECT body FROM records" })).toEqual({
      ok: false,
      error: { code: "backend_unavailable" },
    });
  } finally {
    host.close();
  }
});

test.skipIf(WORKERD === undefined)(
  "real workerd invokes the V2 SQLite facade against its UID file",
  async () => {
    const host = await fixture();
    const plane = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        return host.broker
          .handle(request)
          .then((response) => response ?? new Response(null, { status: 404 }));
      },
    });
    const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = Number(reserved.port);
    reserved.stop(true);
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const artifact = await selectClosedGraphWorkerd({
        binary: WORKERD,
        privateRoot: join(host.root, "artifact"),
      });
      if (!artifact.binary) throw new Error(artifact.diagnostic ?? "pinned workerd unavailable");
      const original = `export default { async fetch(request, env) {
      const keys = Object.keys(env).sort();
      if (new URL(request.url).pathname === "/write") {
        const result = await env.DB.execute("INSERT INTO records (id, body) VALUES (?, ?)", [7, "native"]);
        return Response.json({ keys, result, hasRaw: "close" in env.DB || "database" in env.DB });
      }
      if (new URL(request.url).pathname === "/invalid") {
        try { await env.DB.query(17); } catch (error) { return Response.json({ name: error.name }); }
      }
      if (new URL(request.url).pathname === "/ledger") {
        try { await env.DB.query("SELECT * FROM _takoform_sqlite_migrations"); }
        catch (error) { return Response.json({ name: error.name }); }
      }
      if (new URL(request.url).pathname === "/transaction") {
        const result = await env.DB.transaction([
          { sql: "INSERT INTO records (id, body) VALUES (?, ?)", params: [8, "committed"] },
          { sql: "SELECT body FROM records WHERE id = ?", params: [8] },
        ]);
        return Response.json(result);
      }
      if (new URL(request.url).pathname === "/rollback") {
        try {
          await env.DB.transaction([
            { sql: "INSERT INTO records (id, body) VALUES (?, ?)", params: [9, "rolled back"] },
            { sql: "INSERT INTO missing_table VALUES (1)" },
          ]);
        } catch (error) {
          const absent = await env.DB.query("SELECT body FROM records WHERE id = ?", [9]);
          return Response.json({ name: error.name, absent });
        }
      }
      return Response.json(await env.DB.query("SELECT body FROM records WHERE id = ?", [7]));
    } }`;
      const projection = v2SqliteWorkerProjection({
        originalMainModule: "app.js",
        adapterModule: "v2-adapter.js",
        intrinsicModule: "v2-intrinsics.js",
        sqliteBindingNames: ["DB"],
        declaredHandlers: ["fetch"],
      });
      const modules = new Map<string, Uint8Array>([
        ["app.js", new TextEncoder().encode(original)],
        ...projection,
      ]);
      const graph = compileWorkerdVersionGraph({
        directory: "v2-sqlite-native",
        mainModule: "v2-adapter.js",
        modules,
        moduleMediaTypes: {
          "app.js": "application/javascript+module",
          "v2-adapter.js": "application/javascript+module",
          "v2-intrinsics.js": "application/javascript+module",
        },
        hostnames: [],
        generation: "v2-sqlite-generation",
        workerResourceUid: "worker-one",
        declaredHandlers: ["fetch"],
        readiness: { publication: "v2-sqlite-generation", probeHostname: "binding.localhost" },
        environment: [],
        serviceBindings: [],
        dataPlane: {
          address: `127.0.0.1:${plane.port}`,
          token: host.token,
          bindings: [{ kind: "edge.sql@1.0.0", publicName: "DB" }],
        },
      });
      const runtime = createWorkerdRuntime({
        root: host.root,
        binary: artifact.binary,
        port,
        isReady: () => true,
      });
      if (!runtime.publish) throw new Error("workerd weighted publication unavailable");
      await runtime.publish("v2-sqlite-native", {
        generation: "v2-sqlite-generation",
        workerResourceUid: "worker-one",
        hostnames: ["binding.localhost"],
        versions: [
          { versionId: "v2-native-one", workerVersionUid: "version-one", weight: 10_000, ...graph },
        ],
      });
      child = Bun.spawn([artifact.binary, "serve", join(host.root, "workers", "workerd.capnp")], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const origin = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        try {
          await fetch(origin, {
            headers: { host: "binding.localhost" },
            signal: AbortSignal.timeout(250),
          });
          ready = true;
          break;
        } catch {
          await Bun.sleep(50);
        }
      }
      expect(ready).toBe(true);
      async function call(path: string) {
        const response = await fetch(`${origin}${path}`, {
          headers: { host: "binding.localhost" },
        });
        return { status: response.status, value: await response.json() };
      }
      expect(await call("/write")).toEqual({
        status: 200,
        value: { keys: ["DB"], result: { rows: [], rowsWritten: 1 }, hasRaw: false },
      });
      expect(await call("/read")).toEqual({
        status: 200,
        value: { rows: [{ body: "native" }], rowsWritten: 0 },
      });
      expect(await call("/invalid")).toEqual({ status: 200, value: { name: "TypeError" } });
      expect(await call("/ledger")).toEqual({ status: 200, value: { name: "sql_error" } });
      expect(await call("/transaction")).toEqual({
        status: 200,
        value: {
          results: [
            { rows: [], rowsWritten: 1 },
            { rows: [{ body: "committed" }], rowsWritten: 0 },
          ],
        },
      });
      expect(await call("/rollback")).toEqual({
        status: 200,
        value: { name: "sql_error", absent: { rows: [], rowsWritten: 0 } },
      });
    } finally {
      if (child) {
        child.kill();
        await child.exited;
      }
      plane.stop(true);
      host.close();
    }
  },
);
