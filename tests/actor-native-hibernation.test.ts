import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ACTOR_ABI_INTERFACE_REFS } from "../src/actor-abi-ref.ts";
import { createActorAddressing } from "../src/actor-addressing.ts";
import {
  SELFHOST_WORKER_PRELUDE_MODULE,
  selfhostWorkerPreludeSource,
} from "../src/providers/selfhost-worker-prelude.ts";
import { selfhostWorkerEntrypointSource } from "../src/providers/selfhost-worker-wrapper.ts";
import { openWorkerdActorNamespace } from "../src/selfhost-actor-native-process.ts";
import {
  selectClosedGraphWorkerd,
  WORKERD_CLOSED_GRAPH_ARTIFACT,
} from "../src/workerd-artifact.ts";
import { spawnWorkerdWithParentDeath } from "../src/workerd-linux-process.ts";
import type { WorkerdActiveActorGraph } from "../src/workerd-runtime.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("workerd-artifact");
const encoder = new TextEncoder();
const attachment = Uint8Array.from({ length: 16_384 }, (_, index) => index % 251);
const attachmentDigest = createHash("sha256").update(attachment).digest("hex");

// Typed boundary to the existing JS-only ws dependency. It exposes the native
// upgrade headers needed by the Host's existing one-shot reservation protocol.
interface NativeClient {
  readonly readyState: number;
  on(event: "open", callback: () => void): this;
  on(event: "upgrade", callback: (response: IncomingMessage) => void): this;
  on(event: "message", callback: (data: Buffer) => void): this;
  on(event: "error", callback: (error: Error) => void): this;
  on(event: "close", callback: (code: number) => void): this;
  on(
    event: "unexpected-response",
    callback: (request: ClientRequest, response: IncomingMessage) => void,
  ): this;
  send(value: string): void;
  close(): void;
  terminate(): void;
}
// Bun's built-in "ws" substitute omits finishRequest and rewrites the proxy
// target. Load the pinned package implementation for the actual Unix handshake.
const NativeClient = createRequire(import.meta.url)("../node_modules/ws/index.js") as new (
  url: string,
  options: {
    headers: Readonly<Record<string, string>>;
    finishRequest(request: ClientRequest): void;
  },
) => NativeClient;

let artifactRoot: string | undefined;
let artifact: Promise<string> | undefined;

function selectedBinary(): Promise<string> {
  artifact ??= (async () => {
    artifactRoot = await mkdtemp(join(tmpdir(), "actor-native-artifact-"));
    const selected = await selectClosedGraphWorkerd({ binary, privateRoot: artifactRoot });
    if (!selected.binary) throw new Error(selected.diagnostic ?? "pinned workerd unavailable");
    expect(
      createHash("sha256")
        .update(await readFile(selected.binary))
        .digest("hex"),
    ).toBe(WORKERD_CLOSED_GRAPH_ARTIFACT.sha256);
    console.info(
      "native artifact selection",
      JSON.stringify({
        input: binary,
        snapshot: selected.binary,
        descriptor: WORKERD_CLOSED_GRAPH_ARTIFACT,
        closedGraphCapability: true,
      }),
    );
    return selected.binary;
  })();
  return artifact;
}

afterAll(async () => {
  if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
});

function actorGraph(): WorkerdActiveActorGraph {
  const generation = "actor-native-hibernation-attachment";
  const workerResourceUid = "actor-native-hibernation-worker";
  const mainModule = "main.mjs";
  const hostEntrypoint = "__actor-host.mjs";
  const application = `export class Actor {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    const tables = await this.ctx.storage.query("SELECT name FROM sqlite_master WHERE name LIKE 'actor_%'");
    if (tables.rows.length !== 0 || "kv" in this.ctx.storage) throw new Error("owner storage exposed to tenant");
    const bytes = Uint8Array.from({ length: 16384 }, (_, index) => index % 251);
    const { response, socket } = await this.ctx.sockets.accept(request, { attachment: bytes });
    await socket.send("ready");
    return response;
  }
  async alarm() {
    const sockets = await this.ctx.sockets.list();
    for (const socket of sockets) {
      const bytes = await socket.getAttachment();
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      await socket.send(JSON.stringify({ kind: "alarm", socketId: socket.id, length: bytes.length, digest: Array.from(digest, x => x.toString(16).padStart(2, "0")).join("") }));
    }
  }
  async socketMessage(socket, data) {
    if (data === "arm") { await this.ctx.alarm.set(Date.now() + 25); return; }
    const bytes = await socket.getAttachment();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    await socket.send(JSON.stringify({ socketId: socket.id, length: bytes.length, digest: Array.from(digest, x => x.toString(16).padStart(2, "0")).join("") }));
  }
  socketClose() {}
  socketError() {}
}`;
  return {
    generation,
    generationKey: createHash("sha256").update(generation).digest("hex"),
    workerResourceUid,
    versions: [
      {
        versionId: "version-one",
        workerVersionUid: "actor-native-hibernation-version",
        weight: 10_000,
        variantKey: "variant-one",
        site: {
          directory: "one",
          mainModule,
          hostEntrypoint,
          hostModules: [hostEntrypoint, SELFHOST_WORKER_PRELUDE_MODULE],
          hostnames: [],
          generation,
          workerResourceUid,
          fetchHandler: true,
        },
        modules: new Map([[mainModule, encoder.encode(application)]]),
        hostModules: new Map([
          [SELFHOST_WORKER_PRELUDE_MODULE, encoder.encode(selfhostWorkerPreludeSource())],
          [
            hostEntrypoint,
            encoder.encode(
              selfhostWorkerEntrypointSource({
                originalMainModule: mainModule,
                declaredHandlers: ["fetch"],
                bindings: [],
                publication: generation,
                probeHostname: "actor.invalid",
              }),
            ),
          ],
        ]),
      },
    ],
  };
}

/** Add an isolated native test driver; preserve owner/application confinement. */
function installHibernationDriver(config: string, token: string, actorId: string): string {
  const configuration = readFileSync(config, "utf8");
  const owner = /\(name = "__actor_owner\.js", esModule = embed "([^"]+)"/u.exec(configuration);
  if (!owner?.[1]) throw new Error("test owner module unavailable");
  const path = join(dirname(config), owner[1]);
  const original = readFileSync(path, "utf8");
  if (
    !original.includes("export const ActorOwner = createActorNativeOwner(") ||
    !original.includes("export default {")
  )
    throw new Error("test owner module changed");
  const instrumented = original.replace(
    "export const ActorOwner = createActorNativeOwner(",
    "const CoreActorOwner = createFixtureCoreOwner(",
  );
  writeFileSync(
    path,
    `let fixtureObservationKey;
function createFixtureCoreOwner(...args) {
  // Capture only this namespace's existing ephemeral argument in memory.
  // No observation key/bearer is copied into generated source or receipts.
  fixtureObservationKey = crypto.subtle.importKey("raw", new TextEncoder().encode(args[7]), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return createActorNativeOwner(...args);
}
${instrumented}
const TEST_TOKEN = ${JSON.stringify(token)};
export class ActorOwner extends CoreActorOwner {
  constructor(state, env) { super(state, env); this.testBirth = crypto.randomUUID(); }
  async fetch(request, guard) {
    if (request.headers.get("x-takoserver-private-native-probe") === TEST_TOKEN) {
      if (new URL(request.url).pathname === "/__test_observe__") {
        const encodedId = encodeURIComponent(${JSON.stringify(actorId)});
        const signed = new Uint8Array(await crypto.subtle.sign("HMAC", await fixtureObservationKey, new TextEncoder().encode(encodedId)));
        const bearer = Array.from(signed, value => value.toString(16).padStart(2, "0")).join("");
        // Exercise actual Core auth/graph/socket/stamp fences, never Host's
        // production listener observation or a resource DELETE barrier.
        return super.fetch(new Request("http://actor.invalid/__actor_observe__", { method: "POST", headers: {
          "x-takoserver-private-actor-token": bearer,
          "x-takoserver-private-actor-id": encodedId,
          "x-takoserver-private-actor-observation": "snapshot-v1"
        } }), guard);
      }
      const sockets = this.state.getWebSockets();
      const metadata = sockets.map(socket => socket.deserializeAttachment());
      const payload = metadata[0] ? this.state.storage.kv.get("__takoserver_actor_socket_attachment_v1:" + metadata[0].socketId) : undefined;
      const payloadKeys = Array.from(this.state.storage.kv.list({ prefix: "__takoserver_actor_socket_attachment_v1:", limit: 33 }), ([key]) => key);
      return Promise.resolve(Response.json({ birth: this.testBirth, socketIds: metadata.map(value => value.socketId), attachmentFormat: metadata[0]?.attachmentFormat, payloadBytes: payload?.bytes?.byteLength, payloadKeys }));
    }
    return super.fetch(request, guard);
  }
}`,
  );
  const listener = /\(name = "actor", address = "unix:([^"]+)"/u.exec(configuration);
  if (!listener?.[1]) throw new Error("test owner listener unavailable");
  const driverSocket = join(dirname(listener[1]), "evict.sock");
  const driverModule = "__native_hibernation_driver.mjs";
  writeFileSync(
    join(dirname(config), driverModule),
    `import unsafe from "workerd:unsafe";
export default {
  async fetch(request, env) {
    if (request.headers.get("x-takoserver-private-native-probe") !== ${JSON.stringify(token)}) return new Response(null, { status: 403 });
    const stub = env.NAMESPACE.get(env.NAMESPACE.idFromName(${JSON.stringify(actorId)}));
    if (new URL(request.url).pathname === "/__test_evict__") {
      await unsafe.evict(stub, { webSockets: "hibernate" });
      return new Response(null, { status: 204 });
    }
    return stub.fetch(new Request(request.url, { headers: { "x-takoserver-private-native-probe": ${JSON.stringify(token)} } }));
  }
};`,
  );
  const services = " services = [";
  const sockets = " sockets = [";
  if (!configuration.includes(services) || !configuration.includes(sockets))
    throw new Error("test native configuration changed");
  const service = `(name = "native-hibernation-driver", worker = (
    modules = [(name = ${JSON.stringify(driverModule)}, esModule = embed ${JSON.stringify(driverModule)})],
    compatibilityDate = "2026-07-08", compatibilityFlags = ["unsafe_module"], globalOutbound = "deny",
    bindings = [(name = "NAMESPACE", durableObjectNamespace = (className = "ActorOwner", serviceName = "actor-owner"))]
  )),`;
  writeFileSync(
    config,
    configuration
      .replace(services, `${services}\n  ${service}`)
      .replace(
        sockets,
        `${sockets}(name = "native-hibernation-driver", address = ${JSON.stringify(`unix:${driverSocket}`)}, http = (), service = "native-hibernation-driver"), `,
      ),
  );
  console.info(
    "isolated native eviction driver",
    JSON.stringify({
      service: "native-hibernation-driver",
      unsafeModule: true,
      driverModulePolicy: false,
      ownerModulePolicyUnchanged: true,
      targetService: "actor-owner",
      targetClass: "ActorOwner",
      actorId,
    }),
  );
  return driverSocket;
}

test.skipIf(binary === undefined)(
  "pinned native WebSocket limits the complete serialized hibernation attachment",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "actor-attachment-platform-"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const selected = await selectedBinary();
      await mkdir(join(root, "state"), { mode: 0o700 });
      await writeFile(
        join(root, "probe.mjs"),
        `export class Probe {
  constructor(ctx) { this.ctx = ctx; }
  fetch() {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ attachment: "small" });
    let refused = false;
    let diagnostic;
    try {
      pair[1].serializeAttachment({ socketId: "socket", actorId: "actor", attachment: btoa(String.fromCharCode(...new Uint8Array(16384))) });
    } catch (error) { refused = true; diagnostic = { name: error.name, message: String(error.message) }; }
    pair[1].close(1000);
    const kv = this.ctx.storage.kv;
    const storage = { synchronousKv: !!kv && ["get", "put", "delete", "list"].every(name => typeof kv[name] === "function"), asynchronousKv: ["get", "put", "delete", "list"].every(name => typeof this.ctx.storage[name] === "function") };
    return Response.json({ refused, diagnostic, storage });
  }
  webSocketClose() {}
}
export default { fetch(request, env) {
  if (new URL(request.url).pathname === "/health") return new Response("ready");
  return env.PROBE.get(env.PROBE.idFromName("one")).fetch(request);
} };`,
      );
      const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = listener.port;
      listener.stop(true);
      await writeFile(
        join(root, "workerd.capnp"),
        `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "probe", worker = (
      modules = [(name = "probe.mjs", esModule = embed "probe.mjs")],
      compatibilityDate = "2026-08-11",
      bindings = [(name = "PROBE", durableObjectNamespace = "Probe")],
      durableObjectNamespaces = [(className = "Probe", uniqueKey = "actor-attachment-platform", enableSql = true)],
      durableObjectStorage = (localDisk = "state"), globalOutbound = "deny"
    )),
    (name = "state", disk = (path = ${JSON.stringify(join(root, "state"))}, writable = true)),
    (name = "deny", network = (allow = []))
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "probe")]
);`,
      );
      child = Bun.spawn([selected, "serve", join(root, "workerd.capnp")], {
        env: {},
        stdout: "ignore",
        stderr: "inherit",
      });
      let ready = false;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error("native attachment probe exited");
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(1_000),
          });
          ready = response.status === 200 && (await response.text()) === "ready";
          if (ready) break;
        } catch {
          await Bun.sleep(25);
        }
      }
      if (!ready) throw new Error("native attachment probe unavailable");
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(2_000),
      });
      expect(response.status).toBe(200);
      const observed: unknown = await response.json();
      expect(observed).toMatchObject({ refused: true });
      console.info("native attachment boundary", JSON.stringify(observed));
    } finally {
      child?.kill(9);
      await child?.exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);

test.skipIf(binary === undefined)(
  "native Actor preserves the full 16 KiB attachment through same-socket owner reconstruction",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "actor-native-hibernation-"));
    let namespace: Awaited<ReturnType<typeof openWorkerdActorNamespace>> | undefined;
    let client: NativeClient | undefined;
    try {
      const selected = await selectedBinary();
      const graph = actorGraph();
      const actorId = createActorAddressing().idFromName("attachment-owner");
      const namespaceKey = createHash("sha256").update(crypto.randomUUID()).digest("hex");
      const probeToken = crypto.randomUUID();
      let driverSocket: string | undefined;
      const socketAdmissions: { id: string; attemptNonce: string; leaseId: string }[] = [];
      const socketCompletions: string[] = [];
      const alarmAdmissions: { id: string; attemptNonce: string; leaseId: string }[] = [];
      const alarmCompletions: string[] = [];
      let epoch = "";
      namespace = await openWorkerdActorNamespace(selected, {
        namespaceKey,
        storagePath: join(root, "state"),
        className: "Actor",
        runtimeClassRef: ACTOR_ABI_INTERFACE_REFS.v2,
        graph,
        signal: AbortSignal.timeout(20_000),
        admitAlarm: async (id, attemptNonce) => {
          const leaseId = crypto.randomUUID();
          alarmAdmissions.push({ id, attemptNonce, leaseId });
          return { variantKey: "variant-one", generationKey: graph.generationKey, epoch, leaseId };
        },
        completeAlarm(leaseId) {
          alarmCompletions.push(leaseId);
        },
        admitSocket: async (id, attemptNonce) => {
          const leaseId = crypto.randomUUID();
          socketAdmissions.push({ id, attemptNonce, leaseId });
          return { variantKey: "variant-one", generationKey: graph.generationKey, epoch, leaseId };
        },
        completeSocket(leaseId) {
          socketCompletions.push(leaseId);
        },
        processAdapter: {
          spawn(selected, config) {
            driverSocket = installHibernationDriver(config, probeToken, actorId);
            return spawnWorkerdWithParentDeath([selected, "serve", config, "--experimental"], {
              stdout: "ignore",
              stderr: "inherit",
            });
          },
          probeReadiness({ socketPath, token, signal }) {
            return fetch("http://actor.invalid/", {
              unix: socketPath,
              headers: { "x-takoserver-private-actor-token": token },
              signal,
            });
          },
        },
      });
      epoch = namespace.epoch;
      namespace.enableAlarmAdmission();
      console.info("native fixture namespace", JSON.stringify({ namespaceKey }));
      const owner = namespace;
      const target = owner.duplexTarget(actorId, "variant-one");
      const socket = new NativeClient(`ws+unix://${target.socketPath}:/`, {
        headers: target.headers,
        finishRequest(request) {
          // The Host-owned duplex listener uses HTTP proxy request targets.
          request.path = "http://actor.invalid/socket";
          request.end();
        },
      });
      client = socket;
      let closed = 0;
      const closeCodes: number[] = [];
      socket.on("close", (code) => {
        closed += 1;
        closeCodes.push(code);
      });
      const replies: string[] = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("native Actor attachment reply timed out")),
          5_000,
        );
        const fail = (error: Error) => {
          clearTimeout(timer);
          reject(error);
        };
        socket.on("error", fail);
        socket.on("unexpected-response", (_request, response) => {
          response.resume();
          fail(new Error(`native Actor upgrade returned ${response.statusCode}`));
        });
        socket.on("upgrade", (response) => {
          const bearer = response.headers["x-takoserver-private-actor-reservation"];
          if (typeof bearer !== "string")
            return fail(new Error("native Actor reservation missing"));
          void owner.settleDuplex(actorId, bearer, "commit").catch(fail);
        });
        socket.on("message", (data) => {
          replies.push(data.toString());
          if (replies.length === 1) socket.send("read attachment");
          else {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      expect(replies[0]).toBe("ready");
      const first = JSON.parse(replies[1] as string) as {
        socketId: string;
        length: number;
        digest: string;
      };
      expect(first).toEqual({
        socketId: expect.any(String),
        length: 16_384,
        digest: attachmentDigest,
      });
      const inspect = async (): Promise<{
        birth: string;
        socketIds: string[];
        attachmentFormat: string;
        payloadBytes: number;
        payloadKeys: string[];
      }> => {
        if (!driverSocket) throw new Error("test driver socket missing");
        const response = await fetch("http://actor.invalid/__test_birth__", {
          unix: driverSocket,
          headers: { "x-takoserver-private-native-probe": probeToken },
          signal: AbortSignal.timeout(2_000),
        });
        expect(response.status).toBe(200);
        return await response.json();
      };
      const settled = async (messages: number, alarms: number): Promise<void> => {
        if (!driverSocket) throw new Error("test driver socket missing");
        const until = Date.now() + 2_000;
        while (Date.now() < until) {
          const response = await fetch("http://actor.invalid/__test_observe__", {
            unix: driverSocket,
            headers: { "x-takoserver-private-native-probe": probeToken },
            signal: AbortSignal.timeout(500),
          });
          if (response.status !== 200)
            throw new Error(`Core native observation returned ${response.status}`);
          const observed = (await response.json()) as {
            activeActor: boolean;
            pendingAlarmCount: number;
            openSocketCount: number;
            actorId: string;
            epoch: string;
            generationKey: string;
          };
          expect(observed.actorId).toBe(actorId);
          expect(observed.epoch).toBe(epoch);
          expect(observed.generationKey).toBe(graph.generationKey);
          if (
            observed.activeActor === false &&
            observed.pendingAlarmCount === 0 &&
            observed.openSocketCount === 1 &&
            socketAdmissions.length === messages &&
            socketCompletions.length === messages &&
            alarmAdmissions.length === alarms &&
            alarmCompletions.length === alarms
          )
            return;
          await Bun.sleep(5);
        }
        throw new Error("native callback settlement not proven");
      };
      await settled(1, 0);
      const before = await inspect();
      expect(before).toMatchObject({
        socketIds: [first.socketId],
        attachmentFormat: "owner-kv-v1",
        payloadBytes: 16_384,
      });
      if (!driverSocket) throw new Error("test driver socket missing");
      const eviction = await fetch("http://actor.invalid/__test_evict__", {
        unix: driverSocket,
        headers: { "x-takoserver-private-native-probe": probeToken },
        signal: AbortSignal.timeout(2_000),
      });
      expect(eviction.status).toBe(204);
      const after = await inspect();
      expect(after.birth).not.toBe(before.birth);
      expect(after).toMatchObject({
        socketIds: [first.socketId],
        attachmentFormat: "owner-kv-v1",
        payloadBytes: 16_384,
      });
      const resumed = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("same socket resumption timed out")),
          5_000,
        );
        socket.on("message", (data) => {
          clearTimeout(timer);
          resolve(data.toString());
        });
        socket.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      socket.send("read attachment after eviction");
      expect(JSON.parse(await resumed)).toEqual(first);
      await settled(2, 0);
      const alarmReply = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("native alarm socket reply timed out")),
          5_000,
        );
        socket.on("message", (data) => {
          clearTimeout(timer);
          resolve(data.toString());
        });
        socket.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      socket.send("arm");
      expect(JSON.parse(await alarmReply)).toEqual({ kind: "alarm", ...first });
      await settled(3, 1);
      expect(new Set(socketAdmissions.map((entry) => entry.attemptNonce)).size).toBe(3);
      expect(new Set(socketAdmissions.map((entry) => entry.leaseId)).size).toBe(3);
      expect(socketAdmissions.every((entry) => entry.id === actorId)).toBe(true);
      expect(alarmAdmissions[0]?.id).toBe(actorId);
      expect(socketCompletions).toEqual(socketAdmissions.map((entry) => entry.leaseId));
      expect(alarmCompletions).toEqual(alarmAdmissions.map((entry) => entry.leaseId));
      expect(socket.readyState).toBe(1);
      expect(closed).toBe(0);
      console.info(
        "same socket reconstruction",
        JSON.stringify({
          beforeBirth: before.birth,
          afterBirth: after.birth,
          socketId: first.socketId,
          attachmentBytes: first.length,
          attachmentDigest,
          socketAdmissions: socketAdmissions.length,
          socketCompletions: socketCompletions.length,
          alarmAdmissions: alarmAdmissions.length,
          alarmCompletions: alarmCompletions.length,
        }),
      );
      const beforeCloseEviction = await fetch("http://actor.invalid/__test_evict__", {
        unix: driverSocket,
        headers: { "x-takoserver-private-native-probe": probeToken },
        signal: AbortSignal.timeout(2_000),
      });
      expect(beforeCloseEviction.status).toBe(204);
      socket.close();
      const closeDeadline = Date.now() + 3_000;
      let closeSettled = false;
      let finalState: Awaited<ReturnType<typeof inspect>> | undefined;
      while (Date.now() < closeDeadline) {
        const state = await inspect();
        finalState = state;
        if (
          closed === 1 &&
          socketAdmissions.length === 4 &&
          socketCompletions.length === 4 &&
          state.socketIds.length === 0 &&
          state.payloadKeys.length === 0
        ) {
          closeSettled = true;
          break;
        }
        await Bun.sleep(5);
      }
      console.info(
        "cold terminal final predicate",
        JSON.stringify({
          closeSettled,
          closed,
          readyState: socket.readyState,
          closeCodes,
          socketAdmissions: socketAdmissions.length,
          socketCompletions: socketCompletions.length,
          alarmAdmissions: alarmAdmissions.length,
          alarmCompletions: alarmCompletions.length,
          nativeSockets: finalState?.socketIds.length,
          rootPayloadKeys: finalState?.payloadKeys.length,
        }),
      );
      expect(closeSettled).toBe(true);
      expect(socketCompletions).toEqual(socketAdmissions.map((entry) => entry.leaseId));
    } finally {
      client?.terminate();
      await namespace?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
