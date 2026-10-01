import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSelfhostActorHttpBroker } from "../src/selfhost-actor-http-broker.ts";

test("a disconnected backpressured Actor response cancels its upstream body", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-http-broker-"));
  const cancelled = Promise.withResolvers<void>();
  const pulled = Promise.withResolvers<void>();
  let cancelCount = 0;
  const token = "a".repeat(64);
  const broker = await openSelfhostActorHttpBroker({
    socketPath: join(root, "broker.sock"),
    token,
    async fetch() {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled.resolve();
          controller.enqueue(new Uint8Array(8 * 1024 * 1024));
        },
        cancel() {
          cancelCount += 1;
          cancelled.resolve();
        },
      });
      return new Response(body);
    },
  });
  const client = createConnection({ path: broker.socketPath });
  client.pause();
  try {
    await once(client, "connect");
    client.write(
      [
        "GET /invoke HTTP/1.1",
        "Host: actor.invalid",
        `x-takoserver-private-broker-token: ${token}`,
        "x-takoserver-private-broker-actor-id: actor-a",
        "Connection: close",
        "\r\n",
      ].join("\r\n"),
    );
    await pulled.promise;
    client.destroy();

    await Promise.race([
      cancelled.promise,
      Bun.sleep(250).then(() => {
        throw new Error("Actor HTTP broker did not cancel the disconnected response body");
      }),
    ]);
    expect(cancelCount).toBe(1);
  } finally {
    client.destroy();
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a disconnect before fetch resolves cancels the later response body", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-http-broker-"));
  const cancelled = Promise.withResolvers<void>();
  const fetchStarted = Promise.withResolvers<void>();
  const fetchAborted = Promise.withResolvers<void>();
  const pendingResponse = Promise.withResolvers<Response>();
  const token = "b".repeat(64);
  const broker = await openSelfhostActorHttpBroker({
    socketPath: join(root, "broker.sock"),
    token,
    fetch(_actorId, request) {
      fetchStarted.resolve();
      if (request.signal.aborted) fetchAborted.resolve();
      else request.signal.addEventListener("abort", () => fetchAborted.resolve(), { once: true });
      return pendingResponse.promise;
    },
  });
  const client = createConnection({ path: broker.socketPath });
  client.pause();
  try {
    await once(client, "connect");
    client.write(
      [
        "GET /invoke HTTP/1.1",
        "Host: actor.invalid",
        `x-takoserver-private-broker-token: ${token}`,
        "x-takoserver-private-broker-actor-id: actor-a",
        "Connection: close",
        "\r\n",
      ].join("\r\n"),
    );
    await fetchStarted.promise;
    client.destroy();
    await fetchAborted.promise;
    pendingResponse.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled.resolve();
          },
        }),
      ),
    );

    await Promise.race([
      cancelled.promise,
      Bun.sleep(250).then(() => {
        throw new Error("Actor HTTP broker missed an abort that preceded body setup");
      }),
    ]);
  } finally {
    client.destroy();
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});
