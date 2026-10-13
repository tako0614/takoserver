import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSelfhostPublicHttpsArtifactFetch,
  fetchPinnedArtifact,
  isPublicArtifactAddress,
} from "../src/selfhost-public-https-artifact-fetch.ts";

const host = "artifact.example.test";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "takoserver-artifact-tls-"));
  const key = join(root, "key.pem");
  const cert = join(root, "cert.pem");
  const openssl = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      `/CN=${host}`,
      "-addext",
      `subjectAltName=DNS:${host}`,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  if ((await openssl.exited) !== 0) throw new Error("TLS fixture failed");
  return {
    key: await readFile(key, "utf8"),
    cert: await readFile(cert, "utf8"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("IANA special and transition ranges fail closed", () => {
  for (const address of [
    "0.0.0.1",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.0.0.9",
    "192.0.2.1",
    "192.31.196.1",
    "192.52.193.1",
    "192.88.99.1",
    "192.168.1.1",
    "192.175.48.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
  ])
    expect(isPublicArtifactAddress({ address, family: 4 })).toBe(false);
  for (const address of [
    "::1",
    "::ffff:127.0.0.1",
    "64:ff9b::7f00:1",
    "2001::1",
    "2001:db8::1",
    "2002:7f00:1::1",
    "2620:4f:8000::1",
    "3fff::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
  ])
    expect(isPublicArtifactAddress({ address, family: 6 })).toBe(false);
  expect(isPublicArtifactAddress({ address: "8.8.8.8", family: 4 })).toBe(true);
  expect(isPublicArtifactAddress({ address: "2606:4700:4700::1111", family: 6 })).toBe(true);
  expect(isPublicArtifactAddress({ address: "8.8.8.8", family: 6 })).toBe(false);
});

test("mixed DNS answers and later private rebinding refuse before a second dial", async () => {
  let calls = 0;
  let connections = 0;
  const privateServer = createTcpServer((socket) => {
    connections++;
    socket.destroy();
  });
  try {
    await new Promise<void>((resolve) => privateServer.listen(0, "127.0.0.1", resolve));
    const address = privateServer.address();
    if (!address || typeof address === "string") throw new Error("fixture port missing");
    const fetchPublic = createSelfhostPublicHttpsArtifactFetch({
      port: address.port,
      resolve: async () => {
        calls++;
        return calls === 1
          ? [
              { address: "8.8.8.8", family: 4 },
              { address: "127.0.0.1", family: 4 },
            ]
          : [{ address: "127.0.0.1", family: 4 }];
      },
    });
    const request = () => new Request(`https://${host}/artifact`, { method: "GET" });
    await expect(fetchPublic(request())).rejects.toThrow("DNS refused");
    await expect(fetchPublic(request())).rejects.toThrow("DNS refused");
    await expect(
      fetchPublic(
        new Request(`https://${host}/artifact`, {
          headers: { Cookie: "must-not-leave-host" },
        }),
      ),
    ).rejects.toThrow("request refused");
    expect(calls).toBe(2);
    expect(connections).toBe(0);
  } finally {
    await new Promise<void>((resolve) => privateServer.close(() => resolve()));
  }
});

test("abort rejects promptly during DNS and observes late success or failure", async () => {
  for (const late of ["success", "failure"] as const) {
    let finish!: (answers: readonly { address: string; family: number }[]) => void;
    let fail!: (error: Error) => void;
    let lookups = 0;
    const pending = new Promise<readonly { address: string; family: number }[]>(
      (resolve, reject) => {
        finish = resolve;
        fail = reject;
      },
    );
    const fetchPublic = createSelfhostPublicHttpsArtifactFetch({
      resolve: () => {
        lookups++;
        return pending;
      },
    });
    const controller = new AbortController();
    const attempt = fetchPublic(
      new Request(`https://${host}/artifact`, {
        signal: controller.signal,
      }),
    );
    await Bun.sleep(0);
    expect(lookups).toBe(1);
    controller.abort();
    const outcome = await Promise.race([
      attempt.then(
        () => "resolved",
        () => "rejected",
      ),
      Bun.sleep(100).then(() => "still pending"),
    ]);
    expect(outcome).toBe("rejected");
    if (late === "success") finish([{ address: "8.8.8.8", family: 4 }]);
    else fail(new Error("late DNS failure"));
    await Bun.sleep(1);
  }
});

test("Bun HTTPS dials pinned address while preserving Host, SNI and certificate validation", async () => {
  const tls = await fixture();
  const seen: { host: string | undefined; sni: string | undefined; path: string | undefined } = {
    host: undefined,
    sni: undefined,
    path: undefined,
  };
  let connections = 0;
  const server = createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
    seen.host = request.headers.host;
    seen.path = request.url;
    if (request.url === "/slow") {
      response.writeHead(200);
      response.write("first byte");
      return;
    }
    response.writeHead(302, { location: "https://private.example.test/next" });
    response.end("redirect body");
  });
  server.on("connection", () => {
    connections++;
  });
  server.on("secureConnection", (socket) => {
    seen.sni = String(socket.servername);
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture port missing");
    const response = await fetchPinnedArtifact(
      new Request(`https://${host}/artifact?version=1`),
      { address: "127.0.0.1", family: 4 },
      { port: address.port, ca: tls.cert },
    );
    expect(response.status).toBe(302);
    expect(response.body).toBeNull();
    expect(seen).toEqual({ host, sni: host, path: "/artifact?version=1" });
    const second = await fetchPinnedArtifact(
      new Request(`https://${host}/artifact?version=2`),
      { address: "127.0.0.1", family: 4 },
      { port: address.port, ca: tls.cert },
    );
    await second.text();
    expect(connections).toBe(2);
    await expect(
      fetchPinnedArtifact(
        new Request("https://wrong.example.test/artifact"),
        { address: "127.0.0.1", family: 4 },
        { port: address.port, ca: tls.cert },
      ),
    ).rejects.toThrow();
    const abort = new AbortController();
    const stalled = await fetchPinnedArtifact(
      new Request(`https://${host}/slow`, { signal: abort.signal }),
      { address: "127.0.0.1", family: 4 },
      { port: address.port, ca: tls.cert },
    );
    const reader = stalled.body?.getReader();
    expect((await reader?.read())?.done).toBe(false);
    abort.abort();
    await expect(reader?.read()).rejects.toThrow();
    expect(connections).toBe(4);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await tls.cleanup();
  }
});
