import { expect, test } from "bun:test";
import {
  filterUpstream101Headers,
  openSelfhostV2WorkerEndpointUpstreamWebSocket,
} from "../src/selfhost-v2-worker-endpoint-upstream-websocket.ts";

test("private upgrade head rejects reserved conflicts, hop framing, and private fields", () => {
  const ordinary = filterUpstream101Headers([
    "Connection",
    "Upgrade",
    "Upgrade",
    "websocket",
    "Sec-WebSocket-Accept",
    "native",
    "X-Actor-Marker",
    "yes",
    "Set-Cookie",
    "first=1",
    "Set-Cookie",
    "second=2",
  ]);
  expect(ordinary).toEqual([
    ["x-actor-marker", "yes"],
    ["set-cookie", "first=1"],
    ["set-cookie", "second=2"],
  ]);
  expect(() =>
    filterUpstream101Headers(["Upgrade", "websocket", "Upgrade", "websocket"]),
  ).toThrow();
  expect(() => filterUpstream101Headers(["Connection", "keep-alive"])).toThrow();
  expect(() => filterUpstream101Headers(["Transfer-Encoding", "chunked"])).toThrow();
  expect(() => filterUpstream101Headers(["X-Takoserver-Private-Key", "secret"])).toThrow();
  expect(() => filterUpstream101Headers(["X-Actor-Marker", "yes\r\nInjected: bad"])).toThrow();
});

test("private upstream WebSocket retains ordinary 101 headers without copying native framing", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, listener) {
      if (
        listener.upgrade(request, {
          headers: [
            ["x-actor-upgrade-marker", "native-header"],
            ["set-cookie", "first=1; Path=/"],
            ["set-cookie", "second=2; Path=/"],
          ],
        })
      )
        return undefined;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(socket) {
        socket.send("welcome");
      },
      message() {},
    },
  });
  try {
    const socket = await openSelfhostV2WorkerEndpointUpstreamWebSocket({
      url: `ws://127.0.0.1:${server.port}/actor-socket`,
      headers: new Headers({ host: "original.example.test" }),
      protocols: [],
      signal: new AbortController().signal,
    });
    try {
      expect(socket.readyState).toBe(WebSocket.OPEN);
      expect(socket.handshakeHeaders).toContainEqual(["x-actor-upgrade-marker", "native-header"]);
      expect(socket.handshakeHeaders).toContainEqual(["set-cookie", "first=1; Path=/"]);
      expect(socket.handshakeHeaders).toContainEqual(["set-cookie", "second=2; Path=/"]);
      expect(socket.handshakeHeaders.some(([name]) => name === "sec-websocket-accept")).toBe(false);
      expect(
        socket.handshakeHeaders.some(([name]) => name.startsWith("x-takoserver-private-")),
      ).toBe(false);
      const staged: string[] = [];
      socket.forwardMessages((value) => staged.push(String(value)));
      await Bun.sleep(10);
      expect(staged).toEqual(["welcome"]);
    } finally {
      socket.terminate();
    }
  } finally {
    server.stop(true);
  }
});

test("pre-aborted private upgrade does not dispatch to a native listener", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    openSelfhostV2WorkerEndpointUpstreamWebSocket({
      url: "ws://127.0.0.1:1/actor-socket",
      headers: new Headers(),
      protocols: [],
      signal: controller.signal,
    }),
  ).rejects.toThrow("invalid private WebSocket target");
});

test("unsafe upstream 101 fields abort before handing a socket to the listener", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, listener) {
      if (listener.upgrade(request, { headers: { "x-takoserver-private-key": "secret" } }))
        return undefined;
      return new Response(null, { status: 400 });
    },
    websocket: { message() {} },
  });
  try {
    await expect(
      openSelfhostV2WorkerEndpointUpstreamWebSocket({
        url: `ws://127.0.0.1:${server.port}/actor-socket`,
        headers: new Headers(),
        protocols: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  } finally {
    server.stop(true);
  }
});

test("abort during private handshake closes the unknown dispatch without retry", async () => {
  let entered = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      entered = true;
      await new Promise<void>(() => {});
      return new Response(null, { status: 500 });
    },
  });
  const controller = new AbortController();
  try {
    const pending = openSelfhostV2WorkerEndpointUpstreamWebSocket({
      url: `ws://127.0.0.1:${server.port}/actor-socket`,
      headers: new Headers(),
      protocols: [],
      signal: controller.signal,
    });
    for (let count = 0; !entered && count < 100; count++) await Bun.sleep(1);
    expect(entered).toBe(true);
    controller.abort();
    await expect(pending).rejects.toThrow("native upgrade aborted");
  } finally {
    server.stop(true);
  }
});

test("private client carries a 9 MiB frame and rejects an over-32 MiB frame", async () => {
  const large = new Uint8Array(9 * 1024 * 1024);
  const oversized = new Uint8Array(33_554_433);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, listener) {
      return listener.upgrade(request) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      open(socket) {
        socket.send(large);
      },
      message(socket, value) {
        if (value === "oversize") socket.send(oversized);
      },
    },
  });
  try {
    const socket = await openSelfhostV2WorkerEndpointUpstreamWebSocket({
      url: `ws://127.0.0.1:${server.port}/actor-socket`,
      headers: new Headers(),
      protocols: [],
      signal: new AbortController().signal,
    });
    try {
      const received = new Promise<number>((resolve) => {
        socket.forwardMessages((value) =>
          resolve(typeof value === "string" ? -1 : value.byteLength),
        );
      });
      expect(await received).toBe(large.byteLength);
      const closed = new Promise<void>((resolve) =>
        socket.addEventListener("close", () => resolve(), { once: true }),
      );
      socket.send("oversize");
      await closed;
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      socket.terminate();
    }
  } finally {
    server.stop(true);
  }
});

test("welcome and close are both staged when the Actor closes before public open", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, listener) {
      return listener.upgrade(request) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      open(socket) {
        socket.send("welcome");
        socket.close(4000, "done");
      },
      message() {},
    },
  });
  try {
    const socket = await openSelfhostV2WorkerEndpointUpstreamWebSocket({
      url: `ws://127.0.0.1:${server.port}/actor-socket`,
      headers: new Headers(),
      protocols: [],
      signal: new AbortController().signal,
    });
    try {
      for (let count = 0; !socket.getTerminalClose() && count < 100; count++) await Bun.sleep(1);
      expect(socket.getTerminalClose()?.code).toBe(4000);
      expect(socket.getTerminalClose()?.reason).toBe("done");
      const staged: string[] = [];
      socket.forwardMessages((value) => staged.push(String(value)));
      expect(staged).toEqual(["welcome"]);
    } finally {
      socket.terminate();
    }
  } finally {
    server.stop(true);
  }
});
