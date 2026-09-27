import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Two real, separate workerd processes. This is a candidate transport probe,
// not an Actor contract implementation or a serving-artifact qualification.
const binary = process.env.TAKOSERVER_ACTOR_QUALIFICATION_BINARY;
const expectedDigest = process.env.TAKOSERVER_ACTOR_QUALIFICATION_SHA256;

const CHILD = `export class ActorChild {
  fetch() { return new Response(null, {status: 204}); }
}
export default {fetch() {return new Response(null, {status: 404});}};`;

const OWNER = `export class ActorOwner {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const child = this.ctx.facets.get("actor", () => ({class:this.env.CLASS, id:"actor-id"}));
    const decision = await child.fetch(request);
    if (decision.status !== 204) return new Response(null, {status:503});
    this.ctx.facets.abort("actor", "retired-before-socket-head");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, {status:101, webSocket:pair[0]});
  }
  webSocketMessage(socket, data) { socket.send("owner:" + data); }
}
export default {fetch(request, env) {
  return env.NAMESPACE.get(env.NAMESPACE.idFromName("actor-id")).fetch(request);
}};`;

const APPLICATION = `let escaped;
export default {async fetch(request, env) {
  const path = new URL(request.url).pathname;
  if (path === "/health") return new Response("ok");
  if (path === "/fake") return Object.freeze(Object.create(null));
  if (path === "/replay") return escaped;
  const upgrade = await env.ACTOR.fetch(request);
  if (path === "/inspect") {
    let hostImport = "blocked";
    try { await import("./wrapper.mjs"); hostImport = "allowed"; } catch {}
    return Response.json({
    keys:Object.keys(upgrade), nativeSocket:!!upgrade.webSocket,
    response:upgrade instanceof Response,
    token:Object.getOwnPropertyNames(upgrade).some(name => /token|reservation/i.test(name)),
    envKeys:Object.keys(env), hostImport
  });
  }
  if (path === "/hold") { escaped = upgrade; return new Response("held"); }
  globalThis.Response = class ReplacedResponse {};
  Headers.prototype.get = () => "corrupt";
  return upgrade;
}};`;

const WRAPPER = `import application from "./application.mjs";
const NativeResponse = Response;
const NativeHeadersGet = Headers.prototype.get;
export default {async fetch(request, env) {
  const slots = new WeakMap();
  let live = true;
  const projected = Object.freeze({ACTOR:Object.freeze({
    async fetch(input) {
      if (!live) throw new Error("invocation_closed");
      const native = await env.ACTOR.fetch(input);
      if (native.status !== 101 || !native.webSocket) throw new Error("broker_unavailable");
      const opaque = Object.freeze(Object.create(null));
      slots.set(opaque, native);
      return opaque;
    }
  })});
  let result;
  try { result = await application.fetch(request, projected); }
  catch { live = false; return new NativeResponse(null, {status:500}); }
  live = false;
  if (slots.has(result)) {
    const native = slots.get(result);
    slots.delete(result);
    if (request.signal.aborted) return new NativeResponse(null, {status:499});
    return native;
  }
  if (!(result instanceof NativeResponse)) return new NativeResponse(null, {status:422});
  return result;
}};`;

function actorConfig(root: string, socket: string): string {
  return `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services = [
  (name = "owner", worker = (
   modules = [(name = "owner.mjs", esModule = embed "owner.mjs")],
   compatibilityDate = "2026-01-01", compatibilityFlags = ["experimental"], globalOutbound = "deny",
   bindings = [(name = "NAMESPACE", durableObjectNamespace = "ActorOwner"),
    (name = "CLASS", durableObjectClass = (name = "child", entrypoint = "ActorChild"))],
   durableObjectNamespaces = [(className = "ActorOwner", uniqueKey = "opaque-actor-owner", enableSql = true)],
   durableObjectStorage = (localDisk = "state")
  )),
  (name = "child", worker = (
   modules = [(name = "child.mjs", esModule = embed "child.mjs")],
   compatibilityDate = "2026-01-01", compatibilityFlags = ["experimental"], globalOutbound = "deny"
  )),
  (name = "state", disk = (path = ${JSON.stringify(join(root, "state"))}, writable = true)),
  (name = "deny", network = (allow = []))
 ], sockets = [(name = "actor", address = ${JSON.stringify(`unix:${socket}`)}, http = (style = proxy), service = "owner")]
);`;
}

function publicConfig(socket: string, port: number): string {
  return `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services = [
  (name = "public", worker = (
   modules = [(name = "wrapper.mjs", esModule = embed "wrapper.mjs", role = hostPrivate),
    (name = "application.mjs", esModule = embed "application.mjs", role = application)],
   modulePolicy = (applicationMain = "application.mjs"),
   compatibilityDate = "2026-01-01", compatibilityFlags = ["experimental", "disallow_importable_env"],
   globalOutbound = "deny", bindings = [(name = "ACTOR", service = "actor")]
  )),
  (name = "actor", external = (address = ${JSON.stringify(`unix:${socket}`)}, http = (style = proxy))),
  (name = "deny", network = (allow = []))
 ], sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "public")]
);`;
}

test.skipIf(binary === undefined)(
  "opaque Actor outcome crosses a retired facet and two workerd processes without exposing native socket",
  async () => {
    if (!binary || !expectedDigest || !/^[a-f0-9]{64}$/u.test(expectedDigest))
      throw new Error("explicit candidate binary and SHA256 required");
    const root = await mkdtemp(join(tmpdir(), "actor-opaque-handoff-"));
    const actorRoot = join(root, "actor");
    const publicRoot = join(root, "public");
    const socket = join(root, "actor.sock");
    const processes: ReturnType<typeof Bun.spawn>[] = [];
    try {
      const snapshot = join(root, "workerd");
      await copyFile(binary, snapshot);
      expect(
        createHash("sha256")
          .update(await readFile(snapshot))
          .digest("hex"),
      ).toBe(expectedDigest);
      await chmod(snapshot, 0o700);
      await mkdir(join(actorRoot, "state"), { recursive: true, mode: 0o700 });
      await mkdir(publicRoot, { mode: 0o700 });
      await writeFile(join(actorRoot, "owner.mjs"), OWNER);
      await writeFile(join(actorRoot, "child.mjs"), CHILD);
      await writeFile(join(publicRoot, "wrapper.mjs"), WRAPPER);
      await writeFile(join(publicRoot, "application.mjs"), APPLICATION);
      const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = reserved.port;
      reserved.stop(true);
      if (!port) throw new Error("ephemeral port unavailable");
      await writeFile(join(actorRoot, "config.capnp"), actorConfig(actorRoot, socket));
      await writeFile(join(publicRoot, "config.capnp"), publicConfig(socket, port));
      processes.push(
        Bun.spawn([snapshot, "serve", "--experimental", join(actorRoot, "config.capnp")], {
          env: {},
          cwd: actorRoot,
          stdout: "ignore",
          stderr: "inherit",
        }),
      );
      processes.push(
        Bun.spawn([snapshot, "serve", "--experimental", join(publicRoot, "config.capnp")], {
          env: {},
          cwd: publicRoot,
          stdout: "ignore",
          stderr: "inherit",
        }),
      );
      const origin = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try {
          ready =
            (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(100) })).status === 200;
        } catch {
          /* startup */
        }
        if (ready) break;
        await Bun.sleep(25);
      }
      expect(ready).toBe(true);
      const inspected = await (
        await fetch(`${origin}/inspect`, { headers: { upgrade: "websocket" } })
      ).json();
      expect(inspected).toEqual({
        keys: [],
        nativeSocket: false,
        response: false,
        token: false,
        envKeys: ["ACTOR"],
        hostImport: "blocked",
      });
      expect((await fetch(`${origin}/fake`)).status).toBe(422);
      expect((await fetch(`${origin}/hold`, { headers: { upgrade: "websocket" } })).status).toBe(
        200,
      );
      expect((await fetch(`${origin}/replay`)).status).toBe(422);
      const ws = new WebSocket(`${origin.replace(/^http:/u, "ws:")}/valid`);
      const echoed = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("socket response timeout")), 3000);
        ws.onopen = () => ws.send("hello");
        ws.onmessage = (event) => {
          clearTimeout(timer);
          resolve(String(event.data));
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error("socket failed"));
        };
      });
      expect(echoed).toBe("owner:hello");
      ws.close();
    } finally {
      for (const process of processes) process.kill(9);
      await Promise.all(processes.map((process) => process.exited.catch(() => undefined)));
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
