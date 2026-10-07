import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SELFHOST_V2_QUEUE_EVENT_CONTENT_TYPE,
  SELFHOST_V2_QUEUE_EVENT_PATH,
  SELFHOST_V2_QUEUE_EVENT_PROTOCOL,
  SELFHOST_WORKER_EVENT_HEADER,
  SELFHOST_WORKER_EVENT_TARGET_BINDING,
  SELFHOST_WORKER_EVENT_TOKEN_BINDING,
  selfhostEventServiceSource,
  selfhostV2QueueEvent,
} from "../src/providers/selfhost-events.ts";
import {
  createV2QueueSettlementAuthority,
  createV2QueueSettlementEndpoint,
  V2_QUEUE_SETTLEMENT_ORIGIN_BINDING,
  V2_QUEUE_SETTLEMENT_SERVICE_BINDING,
  V2_QUEUE_SETTLEMENT_TOKEN_BINDING,
  v2QueueSettlementServiceSource,
} from "../src/providers/selfhost-v2-queue-transport.ts";
import {
  selfhostWorkerPreludeModuleName,
  selfhostWorkerPreludeSource,
} from "../src/providers/selfhost-worker-prelude.ts";
import {
  SELFHOST_WORKER_ENTRYPOINT_MODULE,
  selfhostWorkerEntrypointSource,
} from "../src/providers/selfhost-worker-wrapper.ts";
import { WORKERD_CLOSED_GRAPH_ARTIFACT } from "../src/workerd-artifact.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("workerd-artifact");

function freePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  if (!port) throw new Error("ephemeral port unavailable");
  return port;
}

test.skipIf(binary === undefined)(
  "pinned workerd v2 Queue handler awaits private settlement and SQL survives a fresh handle",
  async () => {
    if (!binary) throw new Error("pinned workerd is not configured");
    expect(
      createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
    ).toBe(WORKERD_CLOSED_GRAPH_ARTIFACT.sha256);
    const root = await mkdtemp(join(tmpdir(), "takoserver-v2-queue-native-"));
    await chmod(root, 0o700);
    const dbPath = join(root, "receipt.sqlite");
    const db = new Database(dbPath, { create: true });
    db.run(
      "CREATE TABLE receipt (batch_id TEXT NOT NULL, message_id TEXT NOT NULL, lease_token TEXT NOT NULL, settlement_token TEXT, outcome TEXT, PRIMARY KEY (batch_id, message_id))",
    );
    db.run("INSERT INTO receipt (batch_id, message_id, lease_token) VALUES (?, ?, ?)", [
      "batch-native-1",
      "message-native-1",
      "lease-native-1",
    ]);
    const key = randomBytes(32);
    const grant = {
      batchId: "batch-native-1",
      messageId: "message-native-1",
      workerUid: "worker-native-1",
      versionId: "version-native-1",
      incarnationId: "owner-native-1",
      servingSourceOperationId: "owner-native-1",
      consumerUid: "consumer-native-1",
      queueUid: "queue-native-1",
      generation: 1,
      leaseToken: "lease-native-1",
      expiresAtMillis: Date.now() + 30_000,
    };
    const authority = createV2QueueSettlementAuthority({
      key,
      now: Date.now,
      scope: {
        native: {
          async observeQueueTarget(scope) {
            return { kind: "confirmed", ...scope, status: "active" };
          },
        },
        core: {
          async verifyV2QueueSettlementScope(scope) {
            const row = db
              .query("SELECT lease_token FROM receipt WHERE batch_id = ? AND message_id = ?")
              .get(scope.batchId, scope.messageId) as { lease_token: string } | null;
            return row?.lease_token === scope.leaseToken
              ? { kind: "confirmed_live", ...scope }
              : { kind: "unknown" };
          },
        },
      },
    });
    const endpoint = createV2QueueSettlementEndpoint({
      auth: authority,
      custody: {
        async settleRegisteredBatchMessage(input) {
          const row = db
            .query(
              "SELECT lease_token, settlement_token, outcome FROM receipt WHERE batch_id = ? AND message_id = ?",
            )
            .get(input.batchId, input.messageId) as {
            lease_token: string;
            settlement_token: string | null;
            outcome: string | null;
          } | null;
          if (!row || row.lease_token !== input.expected.leaseToken) return "unknown_message";
          if (row.settlement_token !== null) {
            return row.settlement_token === input.settlementToken &&
              row.outcome === input.decision.outcome
              ? "settled"
              : "already_settled";
          }
          db.run(
            "UPDATE receipt SET settlement_token = ?, outcome = ? WHERE batch_id = ? AND message_id = ?",
            [input.settlementToken, input.decision.outcome, input.batchId, input.messageId],
          );
          return "settled";
        },
      },
    });
    let settlementRequests = 0;
    let refuseSettlement = false;
    const privateServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        settlementRequests += 1;
        return refuseSettlement
          ? Response.json({ ok: true, value: null }, { status: 503 })
          : endpoint(request);
      },
    });
    const gatePort = freePort();
    const publicPort = freePort();
    const gateToken = randomBytes(32).toString("hex");
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const app = "app.mjs";
      const prelude = selfhostWorkerPreludeModuleName(app);
      await writeFile(
        join(root, app),
        `String.prototype.charCodeAt = () => 0;
JSON.stringify = () => '{"ok":true,"value":null}';
Map.prototype.get = () => undefined;
Response.prototype.text = async () => '{"ok":true,"value":null}';
Uint8Array.prototype.set = () => {};
globalThis.fetch = async () => Response.json({ok:true,value:null});
export default {
  async fetch() { return new Response("public"); },
  async queue(batch) {
    if (!(batch.messages[0].body instanceof Uint8Array) ||
        new TextDecoder().decode(batch.messages[0].body) !== "body-native") throw new Error("not bytes");
    await batch.acknowledge(batch.messages[0].id);
  },
};`,
        { mode: 0o600 },
      );
      await writeFile(join(root, prelude), selfhostWorkerPreludeSource(), { mode: 0o600 });
      await writeFile(
        join(root, SELFHOST_WORKER_ENTRYPOINT_MODULE),
        selfhostWorkerEntrypointSource({
          originalMainModule: app,
          publication: "native.v1",
          probeHostname: "worker.internal.invalid",
          declaredHandlers: ["fetch", "queue"],
          bindings: [],
          events: true,
          v2Queue: true,
        }),
        { mode: 0o600 },
      );
      await writeFile(join(root, "gate.mjs"), selfhostEventServiceSource(), { mode: 0o600 });
      await writeFile(join(root, "settlement.mjs"), v2QueueSettlementServiceSource(), {
        mode: 0o600,
      });
      const config = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services = [
  (name = "tenant", worker = (
    modules = [
      (name = ${JSON.stringify(SELFHOST_WORKER_ENTRYPOINT_MODULE)}, esModule = embed ${JSON.stringify(SELFHOST_WORKER_ENTRYPOINT_MODULE)}, role = hostPrivate),
      (name = ${JSON.stringify(prelude)}, esModule = embed ${JSON.stringify(prelude)}, role = hostPrivate),
      (name = ${JSON.stringify(app)}, esModule = embed ${JSON.stringify(app)}, role = application)
    ],
    bindings = [(name = ${JSON.stringify(V2_QUEUE_SETTLEMENT_SERVICE_BINDING)}, service = "settlement")],
    modulePolicy = (applicationMain = ${JSON.stringify(app)}),
    compatibilityDate = "2026-01-01", compatibilityFlags = ["disallow_importable_env"], globalOutbound = "deny"
  )),
  (name = "gate", worker = (
    modules = [(name = "gate.mjs", esModule = embed "gate.mjs")],
    bindings = [
      (name = ${JSON.stringify(SELFHOST_WORKER_EVENT_TARGET_BINDING)}, service = (name = "tenant", entrypoint = "takoserverSelfhostEvents")),
      (name = ${JSON.stringify(SELFHOST_WORKER_EVENT_TOKEN_BINDING)}, text = ${JSON.stringify(gateToken)})
    ], compatibilityDate = "2026-01-01"
  )),
  (name = "settlement", worker = (
    modules = [(name = "settlement.mjs", esModule = embed "settlement.mjs")],
    bindings = [
      (name = ${JSON.stringify(V2_QUEUE_SETTLEMENT_ORIGIN_BINDING)}, service = "origin"),
      (name = ${JSON.stringify(V2_QUEUE_SETTLEMENT_TOKEN_BINDING)}, text = ${JSON.stringify(authority.bindingToken(grant))})
    ], compatibilityDate = "2026-01-01", globalOutbound = "deny"
  )),
  (name = "origin", external = (address = ${JSON.stringify(`127.0.0.1:${privateServer.port}`)}, http = ())),
  (name = "deny", network = (allow = []))
 ],
 sockets = [
  (name = "events", address = "127.0.0.1:${gatePort}", http = (), service = "gate"),
  (name = "public", address = "127.0.0.1:${publicPort}", http = (), service = "tenant")
 ]
);`;
      const configPath = join(root, "config.capnp");
      await writeFile(configPath, config, { mode: 0o600 });
      child = Bun.spawn([binary, "serve", "--experimental", configPath], {
        cwd: root,
        env: {},
        stdout: "ignore",
        stderr: "pipe",
      });
      const event = selfhostV2QueueEvent({
        batchId: grant.batchId,
        script: "worker-native",
        publication: "native.v1",
        workerUid: grant.workerUid,
        consumerUid: grant.consumerUid,
        queueUid: grant.queueUid,
        queue: "native_queue",
        messages: [
          {
            messageId: grant.messageId,
            timestampMillis: Date.now(),
            attempts: 1,
            body: { encoding: "base64", data: Buffer.from("body-native").toString("base64") },
            leaseToken: grant.leaseToken,
            invocationCapability: authority.mint(grant),
          },
        ],
      });
      let answer: Response | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          answer = await fetch(`http://127.0.0.1:${gatePort}${SELFHOST_V2_QUEUE_EVENT_PATH}`, {
            method: "POST",
            headers: {
              "content-type": SELFHOST_V2_QUEUE_EVENT_CONTENT_TYPE,
              [SELFHOST_WORKER_EVENT_HEADER]: SELFHOST_V2_QUEUE_EVENT_PROTOCOL,
              "x-takoserver-selfhost-event-token": gateToken,
            },
            body: JSON.stringify(event),
            signal: AbortSignal.timeout(1_000),
          });
          break;
        } catch {
          await Bun.sleep(25);
        }
      }
      if (!answer) {
        child.kill(9);
        const diagnostic =
          child.stderr && typeof child.stderr !== "number"
            ? await new Response(child.stderr).text()
            : "";
        throw new Error(
          diagnostic
            .replaceAll(gateToken, "<redacted>")
            .replaceAll(authority.bindingToken(grant), "<redacted>")
            .slice(0, 2_000),
        );
      }
      if (answer.status !== 200) {
        const publicAnswer = await fetch(`http://127.0.0.1:${publicPort}/`).catch(() => null);
        child.kill(9);
        const diagnostic =
          child.stderr && typeof child.stderr !== "number"
            ? await new Response(child.stderr).text()
            : "";
        throw new Error(
          `native queue status ${answer.status}, public ${publicAnswer?.status}, private requests ${settlementRequests}: ${diagnostic
            .replaceAll(gateToken, "<redacted>")
            .replaceAll(authority.bindingToken(grant), "<redacted>")
            .slice(0, 2_000)}`,
        );
      }
      expect(answer?.status).toBe(200);
      expect(await answer?.json()).toEqual({
        protocol: SELFHOST_V2_QUEUE_EVENT_PROTOCOL,
        kind: "queue",
        outcome: "resolved",
        completion: "handler_and_wait_until",
      });
      const publicAnswer = await fetch(
        `http://127.0.0.1:${publicPort}${SELFHOST_V2_QUEUE_EVENT_PATH}`,
        {
          method: "POST",
          body: JSON.stringify(event),
        },
      );
      expect(publicAnswer.status).toBe(200);
      expect(await publicAnswer.text()).toBe("public");
      expect(settlementRequests).toBe(1);
      expect(
        (
          await fetch(`http://127.0.0.1:${gatePort}${SELFHOST_V2_QUEUE_EVENT_PATH}`, {
            method: "POST",
            headers: {
              "content-type": SELFHOST_V2_QUEUE_EVENT_CONTENT_TYPE,
              [SELFHOST_WORKER_EVENT_HEADER]: SELFHOST_V2_QUEUE_EVENT_PROTOCOL,
            },
            body: JSON.stringify(event),
          })
        ).status,
      ).toBe(404);
      db.run("INSERT INTO receipt (batch_id, message_id, lease_token) VALUES (?, ?, ?)", [
        "batch-native-2",
        "message-native-2",
        "lease-native-2",
      ]);
      const rejectedGrant = {
        ...grant,
        batchId: "batch-native-2",
        messageId: "message-native-2",
        leaseToken: "lease-native-2",
      };
      const rejectedEvent = selfhostV2QueueEvent({
        batchId: rejectedGrant.batchId,
        script: "worker-native",
        publication: "native.v1",
        workerUid: rejectedGrant.workerUid,
        consumerUid: rejectedGrant.consumerUid,
        queueUid: rejectedGrant.queueUid,
        queue: "native_queue",
        messages: [
          {
            messageId: rejectedGrant.messageId,
            timestampMillis: Date.now(),
            attempts: 1,
            body: { encoding: "base64", data: Buffer.from("body-native").toString("base64") },
            leaseToken: rejectedGrant.leaseToken,
            invocationCapability: authority.mint(rejectedGrant),
          },
        ],
      });
      refuseSettlement = true;
      const unavailable = await fetch(
        `http://127.0.0.1:${gatePort}${SELFHOST_V2_QUEUE_EVENT_PATH}`,
        {
          method: "POST",
          headers: {
            "content-type": SELFHOST_V2_QUEUE_EVENT_CONTENT_TYPE,
            [SELFHOST_WORKER_EVENT_HEADER]: SELFHOST_V2_QUEUE_EVENT_PROTOCOL,
            "x-takoserver-selfhost-event-token": gateToken,
          },
          body: JSON.stringify(rejectedEvent),
        },
      );
      expect(unavailable.status).toBe(500);
      expect(settlementRequests).toBeGreaterThan(1);
      expect(
        db
          .query("SELECT settlement_token FROM receipt WHERE batch_id = ? AND message_id = ?")
          .get(rejectedGrant.batchId, rejectedGrant.messageId),
      ).toEqual({ settlement_token: null });
      db.close();
      const reopened = new Database(dbPath);
      try {
        expect(
          reopened
            .query("SELECT outcome FROM receipt WHERE batch_id = ? AND message_id = ?")
            .get(grant.batchId, grant.messageId),
        ).toEqual({ outcome: "ack" });
      } finally {
        reopened.close();
      }
    } finally {
      child?.kill(9);
      await child?.exited;
      privateServer.stop(true);
      try {
        db.close();
      } catch {
        /* already closed */
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  10_000,
);
