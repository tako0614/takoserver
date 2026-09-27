import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSelfhostActorUpgradeBroker } from "../src/selfhost-actor-upgrade-broker.ts";

const token = "a".repeat(64);
const bearer = "b".repeat(64);
const handshake = [
  "Upgrade: websocket",
  "Connection: Upgrade",
  "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
  `x-takoserver-private-actor-reservation: ${bearer}`,
];

async function withBroker(
  headers: readonly string[],
  run: (fixture: {
    exchange(path: string, extra?: readonly string[]): Promise<string>;
    committed: string[];
    reservations(): number;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "actor-cookie-broker-"));
  const peers = new Set<Socket>();
  const upstreamPath = join(root, "owner.sock");
  const upstream = createServer((socket) => {
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
    socket.once("data", () =>
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join("\r\n")}\r\n\r\n`),
    );
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(upstreamPath, resolve);
  });
  const committed: string[] = [];
  let reservations = 0;
  const broker = await openSelfhostActorUpgradeBroker({
    socketPath: join(root, "broker.sock"),
    token,
    async reserve() {
      reservations += 1;
      return {
        target: { socketPath: upstreamPath, headers: {} },
        async commitTransport(value) {
          committed.push(value);
        },
        async abandonTransport() {},
        abandon() {},
      };
    },
  });
  try {
    await run({
      committed,
      reservations: () => reservations,
      exchange(path, extra = []) {
        return new Promise<string>((resolve, reject) => {
          const client = createConnection({ path: broker.socketPath });
          peers.add(client);
          client.once("close", () => peers.delete(client));
          client.once("error", reject);
          let buffer = "";
          const timer = setTimeout(() => {
            client.destroy();
            reject(new Error("broker head timeout"));
          }, 2_000);
          client.on("data", (bytes) => {
            buffer += bytes.toString("latin1");
            const end = buffer.indexOf("\r\n\r\n");
            if (end >= 0) {
              clearTimeout(timer);
              resolve(buffer.slice(0, end));
            }
          });
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
      },
    });
  } finally {
    await broker.close();
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
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
