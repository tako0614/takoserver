import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../src/db-schema.ts";
import { bytesDigest } from "../src/json.ts";
import { createSelfhostV2QueueProducerBroker } from "../src/providers/selfhost-v2-queue-producer-broker.ts";
import { createQueueCustody } from "../src/queue-custody.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { AT_LEAST_ONCE_QUEUE_FORM_URL } from "../src/takoform-v2/forms/at-least-once-queue.ts";
import { createQueueWorkerBindingAuthority } from "../src/takoform-v2/forms/queue-worker-binding-authority.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { V2_QUEUE_BACKEND_ID } from "../src/takoform-v2/worker-queue-backend.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";
import { compileWorkerdVersionGraph } from "../src/workerd-version-graph.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const WORKERD = nativeEvidenceBinary("workerd-artifact");
const TARGET = "queue-producer-native";
const QUEUE = "native-queue";
const WORKER = "native-worker";
const VERSION = "native-version";
const VERSION_OPERATION = "native-version-operation";
const BUNDLE = "native-bundle";
const BUNDLE_FORM = "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/";

function settled(
  db: Database,
  uid: string,
  form: string,
  spec: string,
  observed: string,
  backend: string,
) {
  const operation = `op-${uid}`;
  db.prepare(`INSERT INTO tf_v2_resources
    (uid,principal,form_url,space,name,backend_id,target_key,active_name,generation,
     observed_generation,phase,spec_json,observed_json,output_json,last_operation)
    VALUES (?,'org:native',?,'prod',?,?,?, ?,1,1,'idle',?,?,'{}',?)`).run(
    uid,
    form,
    uid,
    backend,
    TARGET,
    uid,
    spec,
    observed,
    operation,
  );
  db.prepare(`INSERT INTO tf_v2_operations
    (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,status,effect,
     created_at,updated_at,retain_until,backend_id,target_key,backend_key,accepted_spec_json)
    VALUES (?,?,'org:native',?,'fp','create',1,'succeeded','complete',
      '2026-10-07T00:00:00Z','2026-10-07T00:00:00Z','2026-10-08T00:00:00Z',?,?,?,?)`).run(
    operation,
    uid,
    `replay-${uid}`,
    backend,
    TARGET,
    `key-${uid}`,
    spec,
  );
}

function acceptedVersion(db: Database, spec: string) {
  db.prepare(`INSERT INTO tf_v2_resources
    (uid,principal,form_url,space,name,backend_id,target_key,active_name,generation,
     observed_generation,phase,spec_json,observed_json,output_json,last_operation,busy_operation)
    VALUES (?,'org:native',?,'prod',?,'worker-backend',?,?,1,0,'pending',?,'{}','{}',?,?)`).run(
    VERSION,
    WORKER_VERSION_FORM_URL,
    VERSION,
    TARGET,
    VERSION,
    spec,
    VERSION_OPERATION,
    VERSION_OPERATION,
  );
  db.prepare(`INSERT INTO tf_v2_operations
    (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,status,effect,
     created_at,updated_at,retain_until,backend_id,target_key,backend_key,accepted_spec_json)
    VALUES (?,?,'org:native','replay-native-version','fp','create',1,'queued','none',
      '2026-10-07T00:00:00Z','2026-10-07T00:00:00Z','2026-10-08T00:00:00Z',
      'worker-backend',?,'key-native-version',?)`).run(VERSION_OPERATION, VERSION, TARGET, spec);
  db.prepare("INSERT INTO tf_v2_operation_reference_sets (operation_id,sealed) VALUES (?,0)").run(
    VERSION_OPERATION,
  );
  for (const [uid, form] of [
    [WORKER, MODULE_WORKER_FORM_URL],
    [BUNDLE, BUNDLE_FORM],
    [QUEUE, AT_LEAST_ONCE_QUEUE_FORM_URL],
  ] as const) {
    db.prepare(`INSERT INTO tf_v2_operation_references
      (operation_id,target_uid,form_url,readiness) VALUES (?,?,?,'observed')`).run(
      VERSION_OPERATION,
      uid,
      form,
    );
  }
  db.prepare("UPDATE tf_v2_operation_reference_sets SET sealed=1 WHERE operation_id=?").run(
    VERSION_OPERATION,
  );
  db.prepare("UPDATE tf_v2_operations SET status='running' WHERE id=?").run(VERSION_OPERATION);
  db.prepare("UPDATE tf_v2_operations SET status='reconciling',effect='unknown' WHERE id=?").run(
    VERSION_OPERATION,
  );
  db.prepare("UPDATE tf_v2_operations SET status='succeeded',effect='complete' WHERE id=?").run(
    VERSION_OPERATION,
  );
  db.prepare(`UPDATE tf_v2_resources SET phase='idle',busy_operation=NULL,
    observed_generation=1,observed_json='{"ready":true,"resolvedBindings":true,"bundleVerified":true}'
    WHERE uid=?`).run(VERSION);
}

test.skipIf(WORKERD === undefined)(
  "pinned workerd projects Queue producer send and atomic sendBatch through accepted Core graph",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "v2-queue-producer-native-"));
    const db = new Database(join(root, "control.sqlite"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let plane: ReturnType<typeof Bun.serve> | undefined;
    try {
      for (const migration of MIGRATIONS) db.exec(migration.sql);
      const sql = createSqliteSql(db);
      const queueSpec = JSON.stringify({ messageRetentionSeconds: 3600 });
      settled(
        db,
        QUEUE,
        AT_LEAST_ONCE_QUEUE_FORM_URL,
        queueSpec,
        '{"queueExists":true}',
        V2_QUEUE_BACKEND_ID,
      );
      settled(db, WORKER, MODULE_WORKER_FORM_URL, "{}", '{"ready":true}', "worker-backend");
      settled(db, BUNDLE, BUNDLE_FORM, "{}", "{}", "worker-backend");
      acceptedVersion(
        db,
        JSON.stringify({
          worker: { resourceUid: WORKER },
          bundle: { resourceUid: BUNDLE },
          handlers: ["fetch"],
          queueProducerBindings: [{ name: "TASKS", resource: { resourceUid: QUEUE } }],
        }),
      );
      const nativeVersionId = `v2-${(
        await bytesDigest(new TextEncoder().encode(`${VERSION}\u00001`))
      ).slice("sha256:".length)}`;
      const claim = {
        principal: "org:native",
        space: "prod",
        targetKey: TARGET,
        workerUid: WORKER,
        workerVersionUid: VERSION,
        workerVersionOperationId: VERSION_OPERATION,
        nativeVersionId,
        incarnationId: "native-incarnation",
        servingSourceOperationId: "source-operation",
        bindings: [{ name: "TASKS", resourceUid: QUEUE }],
      };
      let nativeCurrent = true;
      const broker = createSelfhostV2QueueProducerBroker({
        custody: createQueueCustody({ sql }),
        targetKey: TARGET,
        signingKey: new Uint8Array(32).fill(62),
        resolveCurrentBinding: createQueueWorkerBindingAuthority({ sql, targetKey: TARGET })
          .resolveCurrentBinding,
        async observeVersionTarget(input) {
          return nativeCurrent
            ? { kind: "confirmed" as const, ...input, status: "active" as const }
            : { kind: "unknown" as const };
        },
      });
      const token = broker.issueGrant(claim);
      plane = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          return broker
            .handle(request)
            .then((response) => response ?? new Response(null, { status: 404 }));
        },
      });
      const artifact = await selectClosedGraphWorkerd({
        binary: WORKERD as string,
        privateRoot: join(root, "artifact"),
      });
      if (!artifact.binary) throw new Error(artifact.diagnostic ?? "workerd unavailable");
      const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = Number(probe.port);
      probe.stop(true);
      const graph = compileWorkerdVersionGraph({
        directory: "producer-native",
        mainModule: "app.js",
        modules: new Map([
          [
            "app.js",
            new TextEncoder().encode(`export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/send") {
        const first = await env.TASKS.send("hello");
        const batch = await env.TASKS.sendBatch([
          { body: new Uint8Array([1, 2]) },
          { body: "later", delaySeconds: 3 },
        ]);
        return Response.json({ first, batch, keys: Object.keys(env),
          extra: typeof env.TASKS.receive, privateVisible: Object.keys(env).some((name) => name.includes("PRIVATE")) });
      }
      if (path !== "/stale") return new Response("not found", { status: 404 });
      await env.TASKS.send("late");
      return Response.json({ accepted: true });
    } catch (error) { return Response.json({ error: error.name }); }
  }
}`),
          ],
        ]),
        moduleMediaTypes: { "app.js": "application/javascript+module" },
        hostnames: [],
        generation: "takoserver-v2-operation:11111111-1111-4111-8111-111111111111",
        workerResourceUid: WORKER,
        declaredHandlers: ["fetch"],
        readiness: { publication: nativeVersionId, probeHostname: "queue-producer.localhost" },
        environment: [],
        serviceBindings: [],
        v2QueueProducerBinding: {
          address: `127.0.0.1:${plane.port}`,
          token,
          bindings: [{ publicName: "TASKS" }],
        },
      });
      const runtime = createWorkerdRuntime({
        root,
        binary: artifact.binary,
        port,
        isReady: () => true,
      });
      if (!runtime.publish) throw new Error("weighted publication unavailable");
      await runtime.publish("producer-native", {
        generation: "takoserver-v2-operation:11111111-1111-4111-8111-111111111111",
        workerResourceUid: WORKER,
        hostnames: ["producer.localhost"],
        versions: [
          { versionId: nativeVersionId, workerVersionUid: VERSION, weight: 10_000, ...graph },
        ],
      });
      child = Bun.spawn([artifact.binary, "serve", join(root, "workers", "workerd.capnp")], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const origin = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          await fetch(origin, {
            headers: { host: "producer.localhost" },
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
          headers: { host: "producer.localhost" },
        });
        return (await response.json()) as Record<string, unknown>;
      }
      const answer = await call("/send");
      expect(answer.keys).toEqual(["TASKS"]);
      expect(answer.extra).toBe("undefined");
      expect(answer.privateVisible).toBe(false);
      expect(typeof answer.first).toBe("string");
      expect((answer.batch as unknown[]).length).toBe(2);
      expect(await sql.query("SELECT count(*) AS count FROM selfhost_queue_messages")).toEqual([
        { count: 3 },
      ]);
      nativeCurrent = false;
      expect(await call("/stale")).toEqual({ error: "backend_unavailable" });
      expect(await sql.query("SELECT count(*) AS count FROM selfhost_queue_messages")).toEqual([
        { count: 3 },
      ]);
    } finally {
      if (child) {
        child.kill();
        await child.exited;
      }
      plane?.stop(true);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
