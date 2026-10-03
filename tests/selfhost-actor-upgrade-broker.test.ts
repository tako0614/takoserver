import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SelfhostActorDuplexLease } from "../src/selfhost-actor-upgrade-broker.ts";
import { openSelfhostActorUpgradeBroker } from "../src/selfhost-actor-upgrade-broker.ts";

const token = "a".repeat(64);
const bearer = "b".repeat(64);
const handshake = [
  "Upgrade: websocket",
  "Connection: Upgrade",
  "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
  `x-takoserver-private-actor-reservation: ${bearer}`,
];

function openBrokerExchange(
  socketPath: string,
  peers: Set<Socket>,
  path: string,
  extra: readonly string[] = [],
): Promise<{ head: string; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const client = createConnection({ path: socketPath });
    peers.add(client);
    client.once("close", () => peers.delete(client));
    let buffer = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error, value?: { head: string; socket: Socket }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.off("data", onData);
      client.off("error", onError);
      if (error) reject(error);
      else if (value) resolve(value);
    };
    const onError = (error: Error) => finish(error);
    const onData = (bytes: Buffer) => {
      buffer += bytes.toString("latin1");
      const end = buffer.indexOf("\r\n\r\n");
      if (end >= 0) finish(undefined, { head: buffer.slice(0, end), socket: client });
    };
    timer = setTimeout(() => {
      client.destroy();
      finish(new Error("broker head timeout"));
    }, 2_000);
    client.once("error", onError);
    client.on("data", onData);
    client.once("connect", () => {
      const control = path.startsWith("/__broker/");
      const lines = [
        `${control ? "POST" : "GET"} ${path} HTTP/1.1`,
        "Host: actor.invalid",
        `x-takoserver-private-broker-token: ${token}`,
        ...(control
          ? ["Content-Length: 0"]
          : [
              "Upgrade: websocket",
              "Connection: Upgrade",
              "Sec-WebSocket-Version: 13",
              "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
              "Sec-WebSocket-Protocol: chat",
              "x-takoserver-private-broker-actor-id: room",
            ]),
        ...extra,
      ];
      client.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
  });
}

async function withBroker(
  headers: readonly string[],
  run: (fixture: {
    exchange(path: string, extra?: readonly string[]): Promise<string>;
    openExchange(
      path: string,
      extra?: readonly string[],
    ): Promise<{ head: string; socket: Socket }>;
    committed: string[];
    abandoned: string[];
    reservations(): number;
    retire(): Promise<void>;
  }) => Promise<void>,
  options: {
    echoUpstream?: boolean;
    expectedCloseFailure?: boolean;
    reserve?: (
      upstreamPath: string,
      committed: string[],
      abandoned: string[],
    ) => Promise<SelfhostActorDuplexLease>;
  } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "actor-cookie-broker-"));
  const peers = new Set<Socket>();
  const upstreamPath = join(root, "owner.sock");
  const upstream = createServer((socket) => {
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
    socket.once("data", () => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (options.echoUpstream) {
        socket.on("data", (bytes) => socket.write(bytes));
        socket.once("end", () => socket.end());
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(upstreamPath, resolve);
  });
  const committed: string[] = [];
  const abandoned: string[] = [];
  let reservations = 0;
  const broker = await openSelfhostActorUpgradeBroker({
    socketPath: join(root, "broker.sock"),
    token,
    async reserve() {
      reservations += 1;
      if (options.reserve) return options.reserve(upstreamPath, committed, abandoned);
      return {
        target: { socketPath: upstreamPath, headers: {} },
        async commitTransport(value) {
          committed.push(value);
        },
        async abandonTransport(value) {
          abandoned.push(value);
        },
        abandon() {},
      };
    },
  });
  try {
    await run({
      committed,
      abandoned,
      reservations: () => reservations,
      retire: () => broker.retire(),
      async exchange(path, extra = []) {
        return (await openBrokerExchange(broker.socketPath, peers, path, extra)).head;
      },
      openExchange: (path, extra = []) => openBrokerExchange(broker.socketPath, peers, path, extra),
    });
  } finally {
    try {
      if (options.expectedCloseFailure) {
        const closeOutcome = () =>
          broker.close().then(
            () => "resolved",
            () => "rejected",
          );
        expect(await closeOutcome()).toBe("rejected");
        expect(await closeOutcome()).toBe("rejected");
      } else {
        await broker.close();
      }
    } finally {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }
}

test("actual Unix broker preserves each Set-Cookie value and still commits one reservation", async () => {
  const cookies = [
    "session=one; Path=/; HttpOnly",
    "cursor=two; Expires=Wed, 09 Jun 2027 10:18:14 GMT; SameSite=Lax",
  ];
  await withBroker(
    [...handshake, `Set-Cookie: ${cookies[0]}`, "X-Middleware: kept", `sEt-CoOkIe: ${cookies[1]}`],
    async (f) => {
      const head = await f.exchange("/socket");
      expect(head.startsWith("HTTP/1.1 101 ")).toBe(true);
      expect(head.split("\r\n").filter((line) => line.startsWith("set-cookie: "))).toEqual(
        cookies.map((value) => `set-cookie: ${value}`),
      );
      expect(head).toContain("x-middleware: kept");
      expect(head).not.toContain("x-takoserver-private-actor-reservation:");
      const reservation = /^x-takoserver-private-broker-reservation: ([a-f0-9-]{36})$/mu.exec(
        head,
      )?.[1];
      expect(reservation).toBeDefined();
      expect(await f.exchange(`/__broker/commit/${reservation}`)).toContain("HTTP/1.1 204 ");
      expect(f.committed).toEqual([bearer]);
      expect(f.reservations()).toBe(1);
    },
  );
});

for (const duplicate of [
  "Upgrade: websocket",
  "Connection: Upgrade",
  "Sec-WebSocket-Accept: forged",
  `X-Takoserver-Private-Actor-Reservation: ${bearer}`,
  "Sec-WebSocket-Protocol: chat\r\nsec-websocket-protocol: chat",
  "X-Takoserver-Private-Other: a\r\nx-takoserver-private-other: b",
]) {
  test(`actual Unix broker still refuses duplicate reserved response ${duplicate.split(":")[0]}`, async () => {
    await withBroker([...handshake, duplicate], async (f) => {
      expect(await f.exchange("/socket")).toContain("HTTP/1.1 503 ");
      expect(f.committed).toEqual([]);
    });
  });
}

test("response cookie exception does not permit duplicate private request authentication", async () => {
  await withBroker(handshake, async (f) => {
    expect(await f.exchange("/socket", [`X-Takoserver-Private-Broker-Token: ${token}`])).toContain(
      "HTTP/1.1 503 ",
    );
    expect(f.reservations()).toBe(0);
  });
});

test("retirement rejects new upgrades but lets an admitted provisional lease commit and drain", async () => {
  const reserveStarted = Promise.withResolvers<void>();
  const reservation = Promise.withResolvers<void>();
  await withBroker(
    handshake,
    async (f) => {
      const provisional = f.openExchange("/socket");
      await reserveStarted.promise;
      const draining = f.retire();
      expect(
        await Promise.race([draining.then(() => "resolved"), Bun.sleep(20).then(() => "pending")]),
      ).toBe("pending");

      expect(await f.exchange("/new-socket")).toContain("HTTP/1.1 503 ");
      expect(f.reservations()).toBe(1);

      reservation.resolve();
      const accepted = await provisional;
      expect(accepted.head.startsWith("HTTP/1.1 101 ")).toBe(true);
      const reservationId = /^x-takoserver-private-broker-reservation: ([a-f0-9-]{36})$/mu.exec(
        accepted.head,
      )?.[1];
      expect(reservationId).toBeDefined();
      expect(f.committed).toEqual([]);

      expect(await f.exchange(`/__broker/commit/${reservationId}`)).toContain("HTTP/1.1 204 ");
      expect(f.committed).toEqual([bearer]);
      expect(f.abandoned).toEqual([]);
      expect(
        await Promise.race([draining.then(() => "resolved"), Bun.sleep(20).then(() => "pending")]),
      ).toBe("pending");
      expect(accepted.socket.destroyed).toBe(false);

      const frame = Buffer.from([0x81, 0x84, 0x01, 0x02, 0x03, 0x04, 0x71, 0x6b, 0x6d, 0x66]);
      const echoedFrame = once(accepted.socket, "data").then(([bytes]) => Buffer.from(bytes));
      accepted.socket.write(frame);
      expect(await echoedFrame).toEqual(frame);

      const closed = once(accepted.socket, "close");
      accepted.socket.end();
      await closed;
      await draining;
      expect(f.reservations()).toBe(1);
    },
    {
      echoUpstream: true,
      reserve: async (upstreamPath, committed, abandoned) => {
        reserveStarted.resolve();
        await reservation.promise;
        return {
          target: { socketPath: upstreamPath, headers: {} },
          async commitTransport(value) {
            committed.push(value);
          },
          async abandonTransport(value) {
            abandoned.push(value);
          },
          abandon() {},
        };
      },
    },
  );
});

test("retirement keeps abandon control available for an existing provisional upgrade", async () => {
  await withBroker(handshake, async (f) => {
    const accepted = await f.openExchange("/socket");
    expect(accepted.head.startsWith("HTTP/1.1 101 ")).toBe(true);
    const reservationId = /^x-takoserver-private-broker-reservation: ([a-f0-9-]{36})$/mu.exec(
      accepted.head,
    )?.[1];
    expect(reservationId).toBeDefined();

    const draining = f.retire();
    expect(
      await Promise.race([draining.then(() => "resolved"), Bun.sleep(20).then(() => "pending")]),
    ).toBe("pending");
    expect(await f.exchange(`/__broker/abandon/${reservationId}`)).toContain("HTTP/1.1 204 ");
    await once(accepted.socket, "close");
    await draining;
    expect(f.committed).toEqual([]);
    expect(f.abandoned).toEqual([bearer]);
    expect(f.reservations()).toBe(1);
  });
});

test("retirement waits for provisional Host abandonment settlement after the socket closes", async () => {
  const abandonStarted = Promise.withResolvers<void>();
  const settleAbandon = Promise.withResolvers<void>();
  await withBroker(
    handshake,
    async (f) => {
      const accepted = await f.openExchange("/socket");
      expect(accepted.head.startsWith("HTTP/1.1 101 ")).toBe(true);
      const reservationId = /^x-takoserver-private-broker-reservation: ([a-f0-9-]{36})$/mu.exec(
        accepted.head,
      )?.[1];
      expect(reservationId).toBeDefined();

      const draining = f.retire();
      const socketClosed = once(accepted.socket, "close");
      try {
        expect(await f.exchange(`/__broker/abandon/${reservationId}`)).toContain("HTTP/1.1 204 ");
        await abandonStarted.promise;
        await socketClosed;
        expect(f.abandoned).toEqual([]);
        expect(
          await Promise.race([
            draining.then(() => "resolved"),
            Bun.sleep(20).then(() => "pending"),
          ]),
        ).toBe("pending");
      } finally {
        settleAbandon.resolve();
      }

      await draining;
      expect(f.abandoned).toEqual([bearer]);
      expect(f.reservations()).toBe(1);
    },
    {
      reserve: async (upstreamPath, _committed, abandoned) => ({
        target: { socketPath: upstreamPath, headers: {} },
        async commitTransport() {},
        async abandonTransport(value) {
          abandonStarted.resolve();
          await settleAbandon.promise;
          abandoned.push(value);
        },
        abandon() {},
      }),
    },
  );
});

test("retirement rejects when Host abandonment settlement fails despite local fallback", async () => {
  await withBroker(
    handshake,
    async (f) => {
      const accepted = await f.openExchange("/socket");
      expect(accepted.head.startsWith("HTTP/1.1 101 ")).toBe(true);
      const reservationId = /^x-takoserver-private-broker-reservation: ([a-f0-9-]{36})$/mu.exec(
        accepted.head,
      )?.[1];
      expect(reservationId).toBeDefined();

      const draining = f.retire().then(
        () => "resolved",
        () => "rejected",
      );
      const socketClosed = once(accepted.socket, "close");
      expect(await f.exchange(`/__broker/abandon/${reservationId}`)).toContain("HTTP/1.1 204 ");
      await socketClosed;
      expect(await draining).toBe("rejected");
      expect(f.abandoned).toEqual(["local-fallback"]);
      expect(f.reservations()).toBe(1);
    },
    {
      expectedCloseFailure: true,
      reserve: async (upstreamPath, _committed, abandoned) => ({
        target: { socketPath: upstreamPath, headers: {} },
        async commitTransport() {},
        async abandonTransport() {
          throw new Error("fixture settlement failure");
        },
        abandon() {
          abandoned.push("local-fallback");
        },
      }),
    },
  );
});
