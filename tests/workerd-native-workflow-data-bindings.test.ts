import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../src/db-schema.ts";
import {
  SELFHOST_WORKER_DATA_SERVICE_MODULE,
  selfhostDataServiceSource,
} from "../src/providers/selfhost-data-service.ts";
import { SELFHOST_WORKER_EDGE_QUEUE_BINDING_KIND } from "../src/providers/selfhost-events.ts";
import {
  selfhostWorkerPreludeModuleName,
  selfhostWorkerPreludeSource,
} from "../src/providers/selfhost-worker-prelude.ts";
import {
  SELFHOST_WORKER_DATA_TOKEN_BINDING,
  SELFHOST_WORKER_EDGE_KV_BINDING_KIND,
  SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND,
  SELFHOST_WORKER_EDGE_SQL_BINDING_KIND,
  SELFHOST_WORKER_ENTRYPOINT_MODULE,
  selfhostWorkerEntrypointSource,
} from "../src/providers/selfhost-worker-wrapper.ts";
import { serveSelfhostDataPlanes } from "../src/selfhost-data-planes.ts";
import { createWorkerdWorkflowExecutionHost } from "../src/selfhost-workflow-execution-host.ts";
import { createSelfhostWorkflowPreparation } from "../src/selfhost-workflow-preparation.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { createWorkerdRuntime, type WorkerdDeploymentPublication } from "../src/workerd-runtime.ts";
import { createWorkflowRuntime } from "../src/workflow-execution.ts";

const workerd = process.env.TAKOSERVER_WORKERD_BINARY;
const guardBinary = process.env.TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY;
const scope = { tenantId: "tenant", workflowResourceUid: "workflow" };

const SCRIPT = "workflow";
const VERSION = "version";
const WORKER_UID = "uid-ModuleWorker-workflow";
const DATA_SECRET = "workflow-native-data-secret-0000";
const DATA_TOKEN = `${SCRIPT}.${VERSION}.${DATA_SECRET}`;
const KV_NAMESPACE = "workflow-native-kv";
const SQL_DATABASE = "workflow-native-sql";
const QUEUE_ID = "workflow-native-queue";
const BUCKET_ID = `tsb-${"a".repeat(40)}`;

const applicationSource = `
export class Application {
  constructor(env) { this.env = env; }
  async run(event, step) {
    const envKeys = Object.keys(this.env).sort();
    if (event.params.phase === "write") {
      const written = await step.do("write-bindings", async () => {
        await this.env.KV.put("workflow-key", "kv-value", { metadata: { source: "workflow" } });
        const kv = await this.env.KV.getWithMetadata("workflow-key");
        const sqlWrite = await this.env.DB.execute(
          "INSERT OR REPLACE INTO workflow_records (id, body) VALUES (?, ?)",
          [1, "sql-value"],
        );
        const sqlRead = await this.env.DB.query(
          "SELECT id, body FROM workflow_records WHERE id = ?",
          [1],
        );
        const objectWrite = await this.env.MEDIA.put(
          "workflow.txt",
          "object-value",
          { contentType: "text/plain" },
        );
        const object = await this.env.MEDIA.get("workflow.txt", undefined);
        const queueMessageId = await this.env.QUEUE.send("queue-value");
        const queueMessageIds = await this.env.QUEUE.sendBatch([
          { body: "queue-batch-one" },
          { body: new TextEncoder().encode("queue-batch-two") },
        ]);
        return {
          kv: {
            value: new TextDecoder().decode(kv.value),
            metadata: kv.metadata,
          },
          sqlWrite,
          sqlRead,
          object: {
            size: objectWrite.size,
            contentType: object.contentType,
            body: await new Response(object.body).text(),
          },
          queue: { messageId: queueMessageId, messageIds: queueMessageIds },
        };
      });
      return { phase: event.params.phase, envKeys, written };
    }

    const persisted = await step.do("read-bindings", async () => {
      const kv = await this.env.KV.getWithMetadata("workflow-key");
      const sql = await this.env.DB.query(
        "SELECT id, body FROM workflow_records WHERE id = ?",
        [1],
      );
      const object = await this.env.MEDIA.get("workflow.txt", undefined);
      const queueMessageId = await this.env.QUEUE.send("queue-second-instance");
      return {
        kv: {
          value: new TextDecoder().decode(kv.value),
          metadata: kv.metadata,
        },
        sql,
        object: {
          size: object.size,
          contentType: object.contentType,
          body: await new Response(object.body).text(),
        },
        queueMessageId,
      };
    });
    return { phase: event.params.phase, envKeys, persisted };
  }
}

export default { fetch() { return new Response("ordinary workflow handler"); } };
`;

function publication(dataPlaneAddress: string): WorkerdDeploymentPublication {
  const prelude = selfhostWorkerPreludeModuleName("app.js");
  const wrapper = SELFHOST_WORKER_ENTRYPOINT_MODULE;
  return {
    generation: `${SCRIPT}.${VERSION}`,
    workerResourceUid: WORKER_UID,
    hostnames: [],
    versions: [
      {
        versionId: VERSION,
        workerVersionUid: "uid-WorkerVersion-workflow-version",
        weight: 10_000,
        site: {
          directory: SCRIPT,
          mainModule: "app.js",
          hostEntrypoint: wrapper,
          hostModules: [prelude],
          hostnames: [],
          generation: `${SCRIPT}.${VERSION}`,
          workerResourceUid: WORKER_UID,
          fetchHandler: true,
          dataPlane: {
            address: dataPlaneAddress,
            module: SELFHOST_WORKER_DATA_SERVICE_MODULE,
            vars: [
              {
                name: SELFHOST_WORKER_DATA_TOKEN_BINDING,
                value: DATA_TOKEN,
                kind: "text",
              },
            ],
          },
        },
        modules: new Map([["app.js", new TextEncoder().encode(applicationSource)]]),
        hostModules: new Map([
          [prelude, new TextEncoder().encode(selfhostWorkerPreludeSource())],
          [
            wrapper,
            new TextEncoder().encode(
              selfhostWorkerEntrypointSource({
                originalMainModule: "app.js",
                publication: `${SCRIPT}.${VERSION}`,
                probeHostname: "workflow.internal.invalid",
                declaredHandlers: ["fetch"],
                bindings: [
                  { kind: SELFHOST_WORKER_EDGE_KV_BINDING_KIND, publicName: "KV" },
                  { kind: SELFHOST_WORKER_EDGE_SQL_BINDING_KIND, publicName: "DB" },
                  { kind: SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND, publicName: "MEDIA" },
                  { kind: SELFHOST_WORKER_EDGE_QUEUE_BINDING_KIND, publicName: "QUEUE" },
                ],
              }),
            ),
          ],
          [
            SELFHOST_WORKER_DATA_SERVICE_MODULE,
            new TextEncoder().encode(selfhostDataServiceSource()),
          ],
        ]),
      },
    ],
  };
}

function waitUntil(at: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.min(2_147_483_647, Math.max(0, at - Date.now())));
    signal.addEventListener("abort", finish, { once: true });
  });
}

test.skipIf(workerd === undefined || guardBinary === undefined)(
  "a native Workflow class reaches all four self-host data bindings and persists state",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "takoserver-native-workflow-data-bindings-"));
    await chmod(root, 0o700);
    const dataControlDatabase = new Database(":memory:");
    const workflowDatabase = new Database(":memory:");
    let plane: ReturnType<typeof serveSelfhostDataPlanes> | undefined;
    let host: ReturnType<typeof createWorkerdWorkflowExecutionHost> | undefined;
    try {
      for (const migration of MIGRATIONS) {
        dataControlDatabase.exec(migration.sql);
      }
      for (const name of [
        "0050_workflow_instances.sql",
        "0051_workflow_execution.sql",
        "0052_workflow_termination_intent.sql",
      ]) {
        const migration = MIGRATIONS.find((entry) => entry.name === name);
        if (!migration) throw new Error(`missing workflow migration ${name}`);
        workflowDatabase.exec(migration.sql);
      }

      const dataRoot = join(root, "selfhost");
      const databaseRoot = join(root, "databases");
      await mkdir(databaseRoot, { recursive: true, mode: 0o700 });
      await chmod(databaseRoot, 0o700);
      const sqlitePath = join(databaseRoot, `${SQL_DATABASE}.sqlite`);
      const tenantDatabase = new Database(sqlitePath, { create: true });
      tenantDatabase.exec(
        "CREATE TABLE workflow_records (id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
      );
      tenantDatabase.close();

      let nextMessageId = 0;
      const served = serveSelfhostDataPlanes({
        sql: createSqliteSql(dataControlDatabase),
        grant: async (script, versionId) =>
          script === SCRIPT && versionId === VERSION
            ? {
                secret: DATA_SECRET,
                kv: { KV: KV_NAMESPACE },
                sql: { DB: SQL_DATABASE },
                queue: {
                  QUEUE: {
                    queueId: QUEUE_ID,
                    messageRetentionSeconds: 345_600,
                    deliveryDelaySeconds: 0,
                  },
                },
                objects: { MEDIA: BUCKET_ID },
              }
            : null,
        databasePath: (name) => join(databaseRoot, `${name}.sqlite`),
        objectRoot: join(dataRoot, "objects"),
        messageId: () => `queue-message-${String(++nextMessageId).padStart(2, "0")}`,
      });
      plane = served;

      const artifact = await selectClosedGraphWorkerd({
        binary: workerd,
        privateRoot: join(root, "artifact"),
      });
      if (!artifact.binary) throw new Error(artifact.diagnostic ?? "no pinned runtime");
      const runtime = createWorkerdRuntime({ root, isReady: () => true });
      if (!runtime.publish) throw new Error("weighted publication is unavailable");
      await runtime.publish(SCRIPT, publication(served.address));

      const prepare = createSelfhostWorkflowPreparation({
        runtimeRoot: root,
        dataPlaneAddress: () => served.address,
        resolveTarget: async () => ({
          ...scope,
          script: SCRIPT,
          workerResourceUid: WORKER_UID,
          className: "Application",
        }),
      });
      host = createWorkerdWorkflowExecutionHost({
        guardBinary: guardBinary as string,
        workerdBinary: artifact.binary,
        maximumRegistrations: 2,
        prepare,
      });
      const workflow = createWorkflowRuntime({
        sql: createSqliteSql(workflowDatabase),
        clock: () => new Date(),
        randomId: (() => {
          let nextId = 0;
          return () => `workflow-id-${++nextId}`;
        })(),
        host,
        leaseMs: 10_000,
        waitUntil,
      });

      await workflow.instances.create(scope, { id: "writer", params: { phase: "write" } });
      await workflow.instances.create(scope, { id: "reader", params: { phase: "read" } });

      const writer = await workflow.runOne(scope, "writer");
      expect(writer).toEqual({
        kind: "complete",
        output: {
          phase: "write",
          envKeys: ["DB", "KV", "MEDIA", "QUEUE"],
          written: {
            kv: { value: "kv-value", metadata: { source: "workflow" } },
            sqlWrite: { rows: [], rowsWritten: 1 },
            sqlRead: { rows: [{ id: 1, body: "sql-value" }], rowsWritten: 0 },
            object: { size: 12, contentType: "text/plain", body: "object-value" },
            queue: {
              messageId: "queue-message-01",
              messageIds: ["queue-message-02", "queue-message-03"],
            },
          },
        },
      });
      if (writer.kind !== "complete") {
        throw new Error(`writer workflow did not complete: ${writer.kind}`);
      }
      const writerStatus = await workflow.instances.status(scope, "writer");
      expect(writerStatus.status).toBe("complete");
      expect(writerStatus.output).toEqual(writer.output);

      const reader = await workflow.runOne(scope, "reader");
      expect(reader).toEqual({
        kind: "complete",
        output: {
          phase: "read",
          envKeys: ["DB", "KV", "MEDIA", "QUEUE"],
          persisted: {
            kv: { value: "kv-value", metadata: { source: "workflow" } },
            sql: { rows: [{ id: 1, body: "sql-value" }], rowsWritten: 0 },
            object: { size: 12, contentType: "text/plain", body: "object-value" },
            queueMessageId: "queue-message-04",
          },
        },
      });
      if (reader.kind !== "complete") {
        throw new Error(`reader workflow did not complete: ${reader.kind}`);
      }
      const readerStatus = await workflow.instances.status(scope, "reader");
      expect(readerStatus.status).toBe("complete");
      expect(readerStatus.output).toEqual(reader.output);

      for (const output of [writer.output, reader.output]) {
        const serialized = JSON.stringify(output);
        expect(serialized).not.toContain(DATA_SECRET);
        expect(serialized).not.toContain("__TAKOSERVER");
      }
    } finally {
      try {
        await host?.close();
      } finally {
        try {
          plane?.maintenance.deleteDatabase(SQL_DATABASE);
        } finally {
          try {
            plane?.stop(true);
          } finally {
            try {
              dataControlDatabase.close();
            } finally {
              try {
                workflowDatabase.close();
              } finally {
                await rm(root, { recursive: true, force: true });
              }
            }
          }
        }
      }
    }
  },
  30_000,
);
