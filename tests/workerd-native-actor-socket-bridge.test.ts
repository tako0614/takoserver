import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SELFHOST_WORKER_PRELUDE_MODULE,
  selfhostWorkerPreludeSource,
} from "../src/providers/selfhost-worker-prelude.ts";
import { selfhostWorkerEntrypointSource } from "../src/providers/selfhost-worker-wrapper.ts";
import { openWorkerdActorNamespace } from "../src/selfhost-actor-native-process.ts";
import type { WorkerdActiveActorGraph } from "../src/workerd-runtime.ts";

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
    const {upgrade, socket} = await this.ctx.sockets.accept(request, {protocol:"chat", attachment:new Uint8Array([7])});
    await socket.send("provisional");
    const abandoned = new URL(request.url).pathname === "/poison" ?
      new NativeResponse("abandoned", {status:409}) : null;
    globalThis.Response = class SpoofedResponse {};
    Headers.prototype.get = () => "corrupt";
    if (abandoned) {
      Array.prototype[Symbol.iterator] = function*() {};
      return abandoned;
    }
    return upgrade;
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

function publicConfig(actorSocketPath: string, port: number): string {
  return `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services = [
  (name = "public", worker = (
   modules = [(name = "wrapper.mjs", esModule = embed "wrapper.mjs", role = hostPrivate),
    (name = "handoff.mjs", esModule = embed "handoff.mjs", role = hostPrivate),
    (name = "application.mjs", esModule = embed "application.mjs", role = application)],
   modulePolicy = (applicationMain = "application.mjs"),
   compatibilityDate = "2026-01-01", compatibilityFlags = ["experimental", "disallow_importable_env"],
   globalOutbound = "deny", bindings = [(name = "ACTOR", service = "actor")]
  )),
  (name = "actor", external = (address = ${JSON.stringify(`unix:${actorSocketPath}`)}, http = (style = proxy))),
  (name = "deny", network = (allow = []))
 ], sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "public")]
);`;
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
      const target = namespace.duplexTarget("actor-id", "variant-one");
      const helper = await Bun.build({
        entrypoints: [join(import.meta.dir, "../src/actor-upgrade-handoff.ts")],
        target: "browser",
        format: "esm",
        minify: false,
      });
      if (!helper.success || !helper.outputs[0]) throw new Error("Actor handoff build failed");
      await writeFile(join(publicRoot, "handoff.mjs"), await helper.outputs[0].text());
      await writeFile(
        join(publicRoot, "application.mjs"),
        `export default {async fetch(request, env) {
  if (new URL(request.url).pathname === "/health") return new Response("ok");
  if (new URL(request.url).searchParams.get("ticket") !== "authorized")
    return new Response("denied", {status:403});
  return env.ACTOR.fetch(request);
}};`,
      );
      await writeFile(
        join(publicRoot, "wrapper.mjs"),
        `import { createActorUpgradeHandoff } from "./handoff.mjs";
import application from "./application.mjs";
const NativeResponse = Response;
const targetHeaders = ${JSON.stringify(target.headers)};
export default {async fetch(request, env) {
  const handoff = createActorUpgradeHandoff(request, {
    async open(actorRequest, ingress) {
      if (ingress.method !== "GET" || ingress.version !== "13" || !ingress.key)
        throw new Error("invalid_client_handshake");
      const headers = new Headers(actorRequest.headers);
      for (const [name, value] of Object.entries(targetHeaders)) headers.set(name, value);
      const native = await env.ACTOR.fetch(new Request(actorRequest, {headers}));
      if (native.status !== 101 || !native.webSocket) throw new Error("actor_upgrade_unavailable");
      return {response:native, commit() {}, abandon() {
        try { native.webSocket.accept(); native.webSocket.close(1001, "abandoned"); } catch {}
      }};
    }
  });
  try { return await handoff.finish(await application.fetch(request, Object.freeze({ACTOR:handoff.actor}))); }
  catch { await handoff.abandon(); return new NativeResponse(null, {status:500}); }
}};`,
      );
      const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = reserved.port;
      reserved.stop(true);
      if (!port) throw new Error("ephemeral port unavailable");
      await writeFile(join(publicRoot, "config.capnp"), publicConfig(target.socketPath, port));
      publicProcess = Bun.spawn(
        [binary, "serve", "--experimental", join(publicRoot, "config.capnp")],
        {
          env: {},
          cwd: publicRoot,
          stdout: "ignore",
          stderr: "inherit",
        },
      );
      const origin = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          ready = (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(100) })).ok;
        } catch {
          /* startup */
        }
        if (ready) break;
        await Bun.sleep(25);
      }
      expect(ready).toBe(true);
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
          "actor-id",
          new Request("http://actor.invalid/probe"),
          "variant-two",
        );
        live = (await probe.json()).live as number;
        if (live === 0) break;
        await Bun.sleep(10);
      }
      expect(live).toBe(0);
    } finally {
      publicProcess?.kill(9);
      await publicProcess?.exited;
      await namespace?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
