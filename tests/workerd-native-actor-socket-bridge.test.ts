import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActorAddressing } from "../src/actor-addressing.ts";
import {
  SELFHOST_WORKER_PRELUDE_MODULE,
  selfhostWorkerPreludeSource,
} from "../src/providers/selfhost-worker-prelude.ts";
import { selfhostWorkerEntrypointSource } from "../src/providers/selfhost-worker-wrapper.ts";
import { openSelfhostActorForwardBrokers } from "../src/selfhost-actor-forward-brokers.ts";
import { openWorkerdActorNamespace } from "../src/selfhost-actor-native-process.ts";
import { createWorkerdRuntime, type WorkerdActiveActorGraph } from "../src/workerd-runtime.ts";
import { compileWorkerdVersionGraph } from "../src/workerd-version-graph.ts";

// An explicit local candidate, never the accepted serving pin or release gate.
const binary = process.env.TAKOSERVER_ACTOR_QUALIFICATION_BINARY;
const expectedDigest = process.env.TAKOSERVER_ACTOR_QUALIFICATION_SHA256;
const encoder = new TextEncoder();

function graph(): WorkerdActiveActorGraph {
  const generation = "native-socket-bridge-candidate";
  const workerResourceUid = "resource-native-socket-bridge";
  return {
    generation,
    generationKey: createHash("sha256").update(generation).digest("hex"),
    workerResourceUid,
    versions: (["one", "two"] as const).map((version, index) => {
      const mainModule = "main.mjs";
      const hostEntrypoint = "__actor-host.mjs";
      const application = `const NativeResponse = Response;
export class Actor {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    if (new URL(request.url).pathname === "/probe")
      return NativeResponse.json({live:(await this.ctx.sockets.list()).length});
    if (new URL(request.url).pathname === "/echo")
      return new NativeResponse(request.body, {headers:{"content-type":"text/plain"}});
    const {response, socket} = await this.ctx.sockets.accept(request, {protocol:"chat", attachment:new Uint8Array([7])});
    await socket.send("provisional");
    const abandoned = new URL(request.url).pathname === "/poison" ?
      new NativeResponse("abandoned", {status:409}) : null;
    globalThis.Response = class SpoofedResponse {};
    Headers.prototype.get = () => "corrupt";
    if (abandoned) {
      Array.prototype[Symbol.iterator] = function*() {};
      return abandoned;
    }
    return response;
  }
  alarm() {}
  async socketMessage(socket, data) {
    const attachment = await socket.getAttachment();
    await socket.send(${JSON.stringify(version)} + ":" + attachment?.[0] + ":" + data);
  }
  socketClose() {}
}`;
      return {
        versionId: `version-${version}`,
        workerVersionUid: `worker-version-${version}`,
        weight: index === 0 ? 5_000 : 5_000,
        variantKey: `variant-${version}`,
        site: {
          directory: version,
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
      };
    }),
  };
}

test.skipIf(binary === undefined)(
  "native Actor owner commits opaque upgrade after facet retirement and reselects each socket callback",
  async () => {
    if (!binary || !expectedDigest || !/^[a-f0-9]{64}$/u.test(expectedDigest))
      throw new Error("explicit candidate binary and SHA256 required");
    expect(
      createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
    ).toBe(expectedDigest);
    const root = await mkdtemp(join(tmpdir(), "actor-native-socket-bridge-"));
    const publicRoot = join(root, "public");
    let namespace: Awaited<ReturnType<typeof openWorkerdActorNamespace>> | undefined;
    let brokers: Awaited<ReturnType<typeof openSelfhostActorForwardBrokers>> | undefined;
    let publicProcess: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await mkdir(publicRoot, { mode: 0o700 });
      await mkdir(join(root, "state"), { mode: 0o700 });
      const active = graph();
      const completed: string[] = [];
      let socketEvent = 0;
      let epoch = "";
      namespace = await openWorkerdActorNamespace(binary, {
        namespaceKey: createHash("sha256").update("actor-native-socket-bridge").digest("hex"),
        storagePath: join(root, "state"),
        className: "Actor",
        graph: active,
        signal: new AbortController().signal,
        admitAlarm: async () => null,
        completeAlarm() {},
        admitSocket: async () => {
          socketEvent += 1;
          return {
            variantKey: socketEvent === 1 ? "variant-two" : "variant-one",
            generationKey: active.generationKey,
            epoch,
            leaseId: `socket-event-${socketEvent}`,
          };
        },
        completeSocket(leaseId) {
          completed.push(leaseId);
        },
        ownerDeadlines: { handlerMs: 1_500, producerMs: 5_000 },
      });
      epoch = namespace.epoch;
      namespace.enableAlarmAdmission();
      const activeNamespace = namespace;
      const actorId = createActorAddressing().idFromName("room");
      const brokerToken = randomBytes(32).toString("hex");
      let admittedFetches = 0;
      brokers = await openSelfhostActorForwardBrokers({
        tenantId: "tenant-native",
        namespaceResourceUid: "uid-actor-native-namespace",
        token: brokerToken,
        httpSocketPath: join(root, "broker-http.sock"),
        upgradeSocketPath: join(root, "broker.sock"),
        executionHost: {
          fetch(scope, request) {
            expect(scope.tenantId).toBe("tenant-native");
            expect(scope.namespaceResourceUid).toBe("uid-actor-native-namespace");
            return activeNamespace.fetch(scope.id, request, "variant-two");
          },
          async reserveDuplex(scope) {
            expect(scope.tenantId).toBe("tenant-native");
            expect(scope.namespaceResourceUid).toBe("uid-actor-native-namespace");
            expect(scope.id).toBe(createActorAddressing().idFromName("room"));
            admittedFetches += 1;
            return {
              target: activeNamespace.duplexTarget(scope.id, "variant-one"),
              commitTransport: (bearer) => activeNamespace.settleDuplex(scope.id, bearer, "commit"),
              abandonTransport: (bearer) =>
                activeNamespace.settleDuplex(scope.id, bearer, "abandon"),
              abandon() {},
            };
          },
        },
      });
      expect(
        (
          await fetch("http://actor.invalid/probe", {
            unix: brokers.socketMapping.httpSocketPath,
            headers: {
              "x-takoserver-private-broker-token": brokerToken,
              "x-takoserver-private-broker-actor-id": encodeURIComponent(actorId),
            },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch("http://actor.invalid/socket", {
            unix: brokers.socketMapping.upgradeSocketPath,
            redirect: "manual",
          })
        ).status,
      ).toBe(404);
      expect(admittedFetches).toBe(0);
      const application = `export default {async fetch(request, env) {
  if (new URL(request.url).pathname === "/health") return new Response("ok");
  if (new URL(request.url).pathname === "/env") {
  let importedEnv = "blocked";
  try { importedEnv = (await import("cloudflare:workers")).env ?? "no-env"; } catch {}
  return Response.json({
    own:Reflect.ownKeys(env).sort(),
    nullPrototype:Object.getPrototypeOf(env) === null,
    appValue:env.APP_VALUE,
    brokerIn:"__TAKOSERVER_ACTOR_HTTP_00000" in env,
    brokerValue:env.__TAKOSERVER_ACTOR_HTTP_00000 === undefined,
    upgradeIn:"__TAKOSERVER_ACTOR_UPGRADE_00000" in env,
    readinessIn:"__TAKOSERVER_SELFHOST_RUNTIME_READINESS" in env,
    inherited:Object.getPrototypeOf(env)?.__TAKOSERVER_ACTOR_HTTP_00000 ?? null,
    importedEnv,
  });
  }
  if (new URL(request.url).searchParams.get("ticket") !== "authorized")
    return new Response("denied", {status:403});
  const room = env.ROOM.get(env.ROOM.idFromName("room"));
  if (new URL(request.url).pathname === "/id")
    return Response.json({id:env.ROOM.idFromName("room"), unique:env.ROOM.newUniqueId()});
  if (new URL(request.url).pathname === "/actor-http")
    return room.fetch(new Request("http://actor.invalid/probe"));
  if (new URL(request.url).pathname === "/actor-http-echo")
    return room.fetch(new Request("http://actor.invalid/echo", {method:"POST", body:request.body}));
  return room.fetch(request);
}};`;
      const compiled = compileWorkerdVersionGraph({
        directory: "public",
        mainModule: "application.mjs",
        modules: new Map([["application.mjs", encoder.encode(application)]]),
        moduleMediaTypes: { "application.mjs": "application/javascript+module" },
        environment: [{ name: "APP_VALUE", value: "visible", type: "plain_text" }],
        serviceBindings: [],
        actorForward: [
          {
            publicName: "ROOM",
            tenantId: "tenant-native",
            namespaceResourceUid: "uid-actor-native-namespace",
            token: brokerToken,
          },
        ],
        hostnames: [],
        generation: "forward-native",
        workerResourceUid: "uid-worker-native-public",
        declaredHandlers: ["fetch"],
        readiness: { publication: "forward-native", probeHostname: "actor.invalid" },
      });
      const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = reserved.port;
      reserved.stop(true);
      if (!port) throw new Error("ephemeral port unavailable");
      const origin = `http://127.0.0.1:${port}`;
      const onReload = async (configPath: string) => {
        publicProcess?.kill(9);
        await publicProcess?.exited;
        publicProcess = Bun.spawn([binary, "serve", "--experimental", configPath], {
          env: {},
          cwd: publicRoot,
          stdout: "ignore",
          stderr: "inherit",
        });
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(100) })).ok) return;
          } catch {
            /* startup */
          }
          await Bun.sleep(25);
        }
        throw new Error("candidate public workerd did not start");
      };
      const runtimeOptions = {
        root: publicRoot,
        port,
        isReady: () => true,
        onReload,
        actorForwardSockets: [brokers.socketMapping],
      };
      const runtime = createWorkerdRuntime(runtimeOptions);
      if (!runtime.publish) throw new Error("weighted runtime publication unavailable");
      await runtime.publish("public", {
        generation: "forward-native",
        workerResourceUid: "uid-worker-native-public",
        hostnames: ["127.0.0.1"],
        versions: [
          {
            versionId: "forward-native-v1",
            workerVersionUid: "uid-worker-native-public-v1",
            weight: 10_000,
            site: compiled.site,
            modules: compiled.modules,
            hostModules: compiled.hostModules,
          },
        ],
      });
      expect(await (await fetch(`${origin}/env`)).json()).toEqual({
        own: ["APP_VALUE", "ROOM"],
        nullPrototype: true,
        appValue: "visible",
        brokerIn: false,
        brokerValue: true,
        upgradeIn: false,
        readinessIn: false,
        inherited: null,
        importedEnv: "blocked",
      });
      expect((await fetch(`${origin}/socket`)).status).toBe(403);
      const messages: string[] = [];
      const ws = new WebSocket(
        `${origin.replace(/^http:/u, "ws:")}/socket?ticket=authorized`,
        "chat",
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Actor socket timed out")), 5_000);
        ws.onopen = () => ws.send("first");
        ws.onmessage = (event) => {
          messages.push(String(event.data));
          if (messages.length === 2) ws.send("second");
          if (messages.length === 3) {
            clearTimeout(timer);
            resolve();
          }
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error("Actor socket failed"));
        };
      });
      expect(messages).toEqual(["provisional", "two:7:first", "one:7:second"]);
      for (let attempt = 0; completed.length < 2 && attempt < 100; attempt += 1)
        await Bun.sleep(10);
      expect(completed).toEqual(["socket-event-1", "socket-event-2"]);
      ws.close();
      for (let attempt = 0; completed.length < 3 && attempt < 100; attempt += 1)
        await Bun.sleep(10);
      expect(completed).toEqual(["socket-event-1", "socket-event-2", "socket-event-3"]);

      publicProcess?.kill(9);
      await publicProcess?.exited;
      publicProcess = undefined;
      const restarted = createWorkerdRuntime(runtimeOptions);
      expect(await restarted.restore()).toEqual(["public"]);
      expect((await fetch(`${origin}/actor-http?ticket=authorized`)).status).toBe(200);
      const restoredSocket = new WebSocket(
        `${origin.replace(/^http:/u, "ws:")}/socket?ticket=authorized`,
        "chat",
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("restored Actor socket timed out")), 5_000);
        restoredSocket.onopen = () => restoredSocket.send("restored");
        restoredSocket.onmessage = (event) => {
          if (String(event.data) === "provisional") return;
          clearTimeout(timer);
          expect(String(event.data)).toBe("one:7:restored");
          resolve();
        };
        restoredSocket.onerror = () => {
          clearTimeout(timer);
          reject(new Error("restored Actor socket failed"));
        };
      });
      restoredSocket.close();
      for (let attempt = 0; completed.length < 5 && attempt < 100; attempt += 1)
        await Bun.sleep(10);
      expect(completed).toEqual([
        "socket-event-1",
        "socket-event-2",
        "socket-event-3",
        "socket-event-4",
        "socket-event-5",
      ]);

      const poisoned = new WebSocket(
        `${origin.replace(/^http:/u, "ws:")}/poison?ticket=authorized`,
        "chat",
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("poisoned upgrade did not settle")), 4_000);
        poisoned.onopen = () => {
          clearTimeout(timer);
          reject(new Error("poisoned upgrade unexpectedly committed"));
        };
        poisoned.onerror = () => {
          clearTimeout(timer);
          resolve();
        };
        poisoned.onclose = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      let live = -1;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const probe = await namespace.fetch(
          actorId,
          new Request("http://actor.invalid/probe"),
          "variant-two",
        );
        live = (await probe.json()).live as number;
        if (live === 0) break;
        await Bun.sleep(10);
      }
      expect(live).toBe(0);
      await Bun.sleep(100);
      expect(completed).toHaveLength(5);
      expect(admittedFetches).toBe(3);
      const addressing = (await (await fetch(`${origin}/id?ticket=authorized`)).json()) as {
        id: string;
        unique: string;
      };
      expect(addressing.id).toBe(actorId);
      expect(addressing.unique).toMatch(/^u1_[a-f0-9]{64}$/u);
      const ordinary = await fetch(`${origin}/actor-http?ticket=authorized`);
      expect(ordinary.status).toBe(200);
      expect(await ordinary.json()).toEqual({ live: 0 });
      const echoed = await fetch(`${origin}/actor-http-echo?ticket=authorized`, {
        method: "POST",
        body: "ordinary streaming actor body",
      });
      expect(echoed.status).toBe(200);
      expect(await echoed.text()).toBe("ordinary streaming actor body");
    } finally {
      publicProcess?.kill(9);
      await publicProcess?.exited;
      await namespace?.close();
      await brokers?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
