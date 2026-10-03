import { expect, test } from "bun:test";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { Server as HttpServer, request as httpRequest } from "node:http";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSelfhostActorForwardBrokers } from "../src/selfhost-actor-forward-brokers.ts";

test("forward context rejects an unknown Actor InterfaceRef before using bindings", async () => {
  const { createSelfhostActorForwardContext } = await import(
    "../src/selfhost-actor-forward-runtime.ts"
  );
  let tenantRead = false;
  expect(() =>
    createSelfhostActorForwardContext({
      rawEnv: new Proxy(
        {},
        {
          get() {
            tenantRead = true;
            throw new Error("tenant environment read");
          },
        },
      ),
      bindings: [
        {
          publicName: "ROOM",
          httpService: "HTTP",
          upgradeService: "UPGRADE",
          token: "a".repeat(64),
          runtimeClassRef: {
            apiVersion: "interfaces.takoform.com/v1alpha1",
            name: "worker.actor",
            version: "2.0.0",
            schemaDigest: `sha256:${"0".repeat(64)}`,
          },
        },
      ],
    }),
  ).toThrow("Actor runtime InterfaceRef is unavailable");
  expect(tenantRead).toBe(false);
});

test("forward binding captures its trusted InterfaceRef once before tenant execution", async () => {
  const { createSelfhostActorForwardContext } = await import(
    "../src/selfhost-actor-forward-runtime.ts"
  );
  let reads = 0;
  const context = createSelfhostActorForwardContext({
    rawEnv: {},
    bindings: [
      {
        publicName: "ROOM",
        httpService: "HTTP",
        upgradeService: "UPGRADE",
        token: "a".repeat(64),
        get runtimeClassRef() {
          reads += 1;
          if (reads > 1) throw new Error("InterfaceRef read twice");
          return {
            apiVersion: "interfaces.takoform.com/v1alpha1",
            name: "worker.actor",
            version: "2.0.0",
            schemaDigest: "sha256:b027b2129eb4e361d469f09d6d7fd7ab1abb2ee54e185da9169ec4c893487a51",
          };
        },
      },
    ],
  });
  expect(reads).toBe(1);
  expect(context.rawEnv.ROOM).toBeDefined();
});

test("mixed forward bindings retain separate 101 clone rules and abandon the unused reservation", () => {
  const runtime = new URL("../src/selfhost-actor-forward-runtime.ts", import.meta.url).href;
  const source = `
const NativeResponse = Response;
Object.defineProperty(NativeResponse.prototype, "webSocket", {
  configurable: true,
  get() { return this.__socket ?? null; },
});
const { createSelfhostActorForwardContext, installActorResponseRuntime } = await import(${JSON.stringify(runtime)});
installActorResponseRuntime();
const events = [];
const ref = {
  apiVersion: "interfaces.takoform.com/v1alpha1",
  name: "worker.actor",
  version: "2.0.0",
  schemaDigest: "sha256:b027b2129eb4e361d469f09d6d7fd7ab1abb2ee54e185da9169ec4c893487a51",
};
function service(name, reservation) {
  return {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/__broker/")) {
        events.push(name + ":" + path.split("/")[2]);
        return new NativeResponse(null, { status: 204 });
      }
      const response = new NativeResponse(null, {
        status: 101,
        headers: { "x-takoserver-private-broker-reservation": reservation },
      });
      Object.defineProperty(response, "__socket", { value: {} });
      return response;
    },
  };
}
const original = new Request("http://worker.invalid/socket", {
  headers: {
    upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  },
});
const context = createSelfhostActorForwardContext({
  original,
  rawEnv: {
    OLD_HTTP: service("old", "00000000-0000-4000-8000-000000000001"),
    OLD_UPGRADE: service("old", "00000000-0000-4000-8000-000000000001"),
    NEW_HTTP: service("new", "00000000-0000-4000-8000-000000000002"),
    NEW_UPGRADE: service("new", "00000000-0000-4000-8000-000000000002"),
  },
  bindings: [
    { publicName: "OLD", httpService: "OLD_HTTP", upgradeService: "OLD_UPGRADE", token: "a".repeat(64) },
    { publicName: "NEW", httpService: "NEW_HTTP", upgradeService: "NEW_UPGRADE", token: "b".repeat(64), runtimeClassRef: ref },
  ],
});
const oldId = context.rawEnv.OLD.idFromName("old");
const newId = context.rawEnv.NEW.idFromName("new");
const oldResponse = await context.rawEnv.OLD.get(oldId).fetch(new Request(original));
const newResponse = await context.rawEnv.NEW.get(newId).fetch(new Request(original));
let newCloneRefused = false;
try { newResponse.clone(); } catch (error) { newCloneRefused = error instanceof TypeError; }
if (!newCloneRefused || oldResponse.clone().status !== 101) throw new Error("mixed clone rule failed");
const completed = await context.finish(new Response(null, newResponse));
if (completed.status !== 101 || events.join(",") !== "old:abandon,new:commit")
  throw new Error("mixed reservation settlement failed: " + events.join(","));
process.stdout.write("mixed-binding-ok");
`;
  const child = Bun.spawnSync([process.execPath, "-e", source], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  expect(new TextDecoder().decode(child.stdout)).toBe("mixed-binding-ok");
});

test("Actor forward brokers bind exact Host scope and reject unauthenticated calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-forward-brokers-"));
  const calls: unknown[] = [];
  const token = "b".repeat(64);
  const options = {
    tenantId: "tenant-one",
    namespaceResourceUid: "uid-actor-namespace-one",
    token,
    httpSocketPath: join(root, "http.sock"),
    upgradeSocketPath: join(root, "upgrade.sock"),
    executionHost: {
      async fetch(scope: unknown, request: Request) {
        calls.push({ scope, path: new URL(request.url).pathname });
        return new Response("selected Actor HTTP");
      },
      async reserveDuplex() {
        throw new Error("unauthorized reservation reached Host");
      },
    },
  };
  try {
    const brokers = await openSelfhostActorForwardBrokers(options);
    try {
      expect(brokers.socketMapping).toEqual({
        tenantId: options.tenantId,
        namespaceResourceUid: options.namespaceResourceUid,
        token,
        httpSocketPath: options.httpSocketPath,
        upgradeSocketPath: options.upgradeSocketPath,
      });
      const id = "room/日本語";
      const denied = await fetch("http://actor.invalid/probe", {
        unix: brokers.socketMapping.httpSocketPath,
        headers: { "x-takoserver-private-broker-actor-id": encodeURIComponent(id) },
      });
      expect(denied.status).toBe(404);
      const response = await fetch("http://actor.invalid/probe", {
        unix: brokers.socketMapping.httpSocketPath,
        headers: {
          "x-takoserver-private-broker-token": token,
          "x-takoserver-private-broker-actor-id": encodeURIComponent(id),
        },
      });
      expect(await response.text()).toBe("selected Actor HTTP");
      expect(calls).toEqual([
        {
          scope: {
            tenantId: options.tenantId,
            namespaceResourceUid: options.namespaceResourceUid,
            id,
          },
          path: "/probe",
        },
      ]);
      const unauthenticatedUpgrade = await fetch("http://actor.invalid/socket", {
        unix: brokers.socketMapping.upgradeSocketPath,
        redirect: "manual",
      });
      expect(unauthenticatedUpgrade.status).toBe(404);
      expect(calls).toHaveLength(1);
    } finally {
      await brokers.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Actor HTTP broker preserves repeated Set-Cookie response fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-forward-cookies-"));
  const token = "c".repeat(64);
  const cookies = [
    "session=one; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/; HttpOnly",
    "csrf=two; Path=/; SameSite=Strict",
  ];
  try {
    const brokers = await openSelfhostActorForwardBrokers({
      tenantId: "tenant-one",
      namespaceResourceUid: "uid-actor-namespace-one",
      token,
      httpSocketPath: join(root, "http.sock"),
      upgradeSocketPath: join(root, "upgrade.sock"),
      executionHost: {
        async fetch() {
          const headers = new Headers([["x-actor-response", "kept"]]);
          for (const cookie of cookies) headers.append("set-cookie", cookie);
          return new Response("cookie-bearing response", { status: 201, headers });
        },
        async reserveDuplex() {
          throw new Error("unexpected duplex reservation");
        },
      },
    });
    try {
      const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
        const request = httpRequest(
          {
            socketPath: brokers.socketMapping.httpSocketPath,
            path: "http://actor.invalid/session",
            headers: {
              "x-takoserver-private-broker-token": token,
              "x-takoserver-private-broker-actor-id": encodeURIComponent("room-one"),
            },
          },
          resolve,
        );
        request.once("error", reject);
        request.end();
      });
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(Buffer.from(chunk));
      const responseCookies: string[] = [];
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        if (response.rawHeaders[index]?.toLowerCase() === "set-cookie") {
          responseCookies.push(response.rawHeaders[index + 1] ?? "");
        }
      }

      expect(response.statusCode).toBe(201);
      expect(response.headers["x-actor-response"]).toBe("kept");
      expect(responseCookies).toEqual(cookies);
      expect(Buffer.concat(chunks).toString()).toBe("cookie-bearing response");
    } finally {
      await brokers.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pair close waits for both transports when a provisional upgrade settlement fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-forward-close-"));
  const token = "d".repeat(64);
  const bearer = "e".repeat(64);
  const peers = new Set<Socket>();
  const upstreamPath = join(root, "upstream.sock");
  const upstream = createServer((socket) => {
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
    socket.once("data", () => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\nx-takoserver-private-actor-reservation: ${bearer}\r\n\r\n`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(upstreamPath, resolve);
  });
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const brokers = await openSelfhostActorForwardBrokers({
    tenantId: "tenant-one",
    namespaceResourceUid: "uid-actor-namespace-one",
    token,
    httpSocketPath: join(root, "http.sock"),
    upgradeSocketPath: join(root, "upgrade.sock"),
    executionHost: {
      async fetch() {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodyController = controller;
              controller.enqueue(Buffer.from("first chunk"));
            },
          }),
        );
      },
      async reserveDuplex() {
        return {
          target: { socketPath: upstreamPath, headers: {} },
          async commitTransport() {},
          async abandonTransport() {
            throw new Error("fixture provisional settlement failure");
          },
          abandon() {},
        };
      },
    },
  });
  const httpCloseStarted = Promise.withResolvers<void>();
  const allowHttpClose = Promise.withResolvers<void>();
  const originalServerClose = HttpServer.prototype.close;
  HttpServer.prototype.close = function (this: HttpServer, callback?: (error?: Error) => void) {
    if (this.address() !== brokers.socketMapping.httpSocketPath)
      return originalServerClose.call(this, callback);
    // Delay only this real Unix HTTP listener's close, leaving it bound until
    // the pair has observed the independent upgrade-settlement failure.
    httpCloseStarted.resolve();
    void allowHttpClose.promise.then(() => originalServerClose.call(this, callback));
    return this;
  } as typeof HttpServer.prototype.close;
  const exchange = (path: string, control = false): Promise<{ head: string; socket: Socket }> =>
    new Promise((resolve, reject) => {
      const socket = createConnection({ path: brokers.socketMapping.upgradeSocketPath });
      peers.add(socket);
      socket.once("close", () => peers.delete(socket));
      socket.once("error", reject);
      let head = "";
      const onData = (bytes: Buffer) => {
        head += bytes.toString("latin1");
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        socket.off("data", onData);
        resolve({ head: head.slice(0, end), socket });
      };
      socket.on("data", onData);
      socket.once("connect", () =>
        socket.write(
          `${control ? "POST" : "GET"} ${path} HTTP/1.1\r\nHost: actor.invalid\r\nx-takoserver-private-broker-token: ${token}\r\n${control ? "Content-Length: 0\r\n" : "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nx-takoserver-private-broker-actor-id: room\r\n"}\r\n`,
        ),
      );
    });
  try {
    const httpResponse = await new Promise<import("node:http").IncomingMessage>(
      (resolve, reject) => {
        const request = httpRequest(
          {
            socketPath: brokers.socketMapping.httpSocketPath,
            path: "/held",
            headers: {
              "x-takoserver-private-broker-token": token,
              "x-takoserver-private-broker-actor-id": "room",
            },
          },
          resolve,
        );
        request.once("error", reject);
        request.end();
      },
    );
    const firstChunk = once(httpResponse, "data");
    expect(Buffer.from((await firstChunk)[0]).toString()).toBe("first chunk");
    const upgrade = await exchange("/socket");
    expect(upgrade.head).toContain("HTTP/1.1 101 ");
    const reservation = /^x-takoserver-private-broker-reservation: ([a-f0-9-]{36})$/mu.exec(
      upgrade.head,
    )?.[1];
    expect(reservation).toBeDefined();
    const control = await exchange(`/__broker/abandon/${reservation}`, true);
    expect(control.head).toContain("HTTP/1.1 204 ");
    httpResponse.on("error", () => {});
    const httpClosed = new Promise<void>((resolve) => httpResponse.once("close", resolve));
    const closing = brokers.close().then(
      () => "resolved",
      () => "rejected",
    );
    await httpCloseStarted.promise;
    expect(existsSync(brokers.socketMapping.httpSocketPath)).toBe(true);
    expect(await Promise.race([closing, Bun.sleep(20).then(() => "pending")])).toBe("pending");
    allowHttpClose.resolve();
    expect(await closing).toBe("rejected");
    expect(existsSync(brokers.socketMapping.httpSocketPath)).toBe(false);
    await httpClosed;
    expect(httpResponse.destroyed).toBe(true);
    await expect(brokers.close()).rejects.toThrow();
  } finally {
    HttpServer.prototype.close = originalServerClose;
    allowHttpClose.resolve();
    try {
      bodyController?.close();
    } catch {
      // Hard-close cancels the response stream before fixture cleanup.
    }
    for (const peer of peers) peer.destroy();
    await brokers.close().catch(() => {});
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
