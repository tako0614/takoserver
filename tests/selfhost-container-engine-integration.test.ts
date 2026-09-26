import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { JsonObject } from "../src/json.ts";
import { createDockerHttpRevisionRuntime } from "../src/providers/docker-http-revision.ts";
import { createSelfhostContainerRuntime } from "../src/providers/selfhost-container-runtime.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("operation exceeded test deadline")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Only the external daemon is a fixture. Both Takoserver runtime layers,
// private durable storage, Unix-socket transport and application HTTP execute.
// This is deliberately not evidence that a real Docker daemon started an image.
test("container service composes Docker transport, durable recovery and application delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "container-engine-"));
  const containers = new Map<string, JsonObject>();
  let created = 0;
  let candidateHealthy = false;
  let holdNextCreate = false;
  const candidateCreateEntered = deferred();
  const releaseCandidateCreate = deferred();
  const encoded = gzipSync("compressed application response");
  const appA = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return new Response("ok");
      if (url.pathname === "/encoded") {
        return new Response(encoded, {
          headers: {
            "content-encoding": "gzip",
            "content-length": String(encoded.byteLength),
            "content-type": "application/octet-stream",
          },
        });
      }
      return Response.json(
        { version: "a", path: url.pathname + url.search, body: await request.text() },
        { status: 202 },
      );
    },
  });
  const appB = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/health") {
        return new Response("candidate", { status: candidateHealthy ? 200 : 503 });
      }
      return Response.json({ version: "b" });
    },
  });
  const socket = join(root, "engine.sock");
  const daemon = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://docker.invalid");
      if (!url.pathname.startsWith("/v1.51/")) throw new Error("incorrect Docker API version");
      const path = url.pathname.slice("/v1.51".length);
      const reply = (status: number, body: unknown = undefined) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(body === undefined ? undefined : JSON.stringify(body));
      };
      if (path === "/images/create" && request.method === "POST") {
        reply(200, { status: "fixture image present" });
        return;
      }
      if (path === "/containers/create" && request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject;
        const name = url.searchParams.get("name");
        if (!name) throw new Error("missing native name");
        if (holdNextCreate) {
          holdNextCreate = false;
          candidateCreateEntered.resolve();
          await releaseCandidateCreate.promise;
        }
        if (containers.has(name)) {
          reply(409);
          return;
        }
        const id = (++created).toString(16).padStart(64, "0");
        containers.set(name, {
          Id: id,
          Config: {
            Image: body.Image ?? null,
            Labels: body.Labels ?? null,
            Env: body.Env ?? [],
            ExposedPorts: body.ExposedPorts ?? {},
          },
          HostConfig: body.HostConfig ?? {},
          Mounts: [],
          State: { Running: false },
          NetworkSettings: { Networks: { "fixture-isolated": { IPAddress: "127.0.0.1" } } },
        });
        reply(201, { Id: id });
        return;
      }
      const [nameOrId, operation] = path.slice("/containers/".length).split("/");
      const found = [...containers.entries()].find(
        ([name, value]) => name === nameOrId || value.Id === nameOrId,
      );
      if (!found) {
        reply(404);
        return;
      }
      const [name, value] = found;
      if (operation === "json" && request.method === "GET") {
        reply(200, value);
      } else if (operation === "start" && request.method === "POST") {
        containers.set(name, { ...value, State: { Running: true } });
        reply(204);
      } else if (operation === "stop" && request.method === "POST") {
        containers.set(name, { ...value, State: { Running: false } });
        reply(204);
      } else if (!operation && request.method === "DELETE") {
        containers.delete(name);
        reply(204);
      } else {
        throw new Error("unexpected Docker request");
      }
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  let runtime: Awaited<ReturnType<typeof createSelfhostContainerRuntime>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      daemon.once("error", reject);
      daemon.listen(socket, resolve);
    });
    const backend = createDockerHttpRevisionRuntime({
      socketPath: socket,
      installationId: "fixture-host",
      network: "fixture-isolated",
      maxMemoryBytes: 512 * 1024 * 1024,
      maxNanoCpus: 1_000_000_000,
      pidsLimit: 128,
    });
    const options = { root: join(root, "runtime"), backend, drainTimeoutMs: 50 };
    runtime = await createSelfhostContainerRuntime(options);
    const identity = { resourceUid: "service-one", incarnationId: "incarnation-one" };
    const first = {
      ...identity,
      generation: 1,
      revision: "revision-a",
      image: `registry.example/app@sha256:${"a".repeat(64)}`,
      port: appA.port as number,
      healthPath: "/health",
      memoryBytes: 256 * 1024 * 1024,
      nanoCpus: 500_000_000,
      environment: { MODE: "application-a" },
    };
    await runtime.reconcile(first);
    const delivered = await runtime.fetch(
      identity,
      new Request("https://logical.example/echo?key=one", { method: "POST", body: "application" }),
    );
    expect(delivered.status).toBe(202);
    expect(await delivered.json()).toEqual({
      version: "a",
      path: "/echo?key=one",
      body: "application",
    });
    const compressed = await runtime.fetch(
      identity,
      new Request("https://logical.example/encoded", { headers: { "accept-encoding": "gzip" } }),
    );
    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    expect(compressed.headers.get("content-length")).toBe(String(encoded.byteLength));
    expect(new Uint8Array(await compressed.arrayBuffer())).toEqual(new Uint8Array(encoded));
    const firstNative = [...containers.values()][0]?.Id;
    expect(created).toBe(1);
    await runtime.close();
    runtime = await createSelfhostContainerRuntime(options);
    await runtime.reconcile(first);
    expect([...containers.values()][0]?.Id).toBe(firstNative);
    expect(created).toBe(1);

    const second = {
      ...first,
      generation: 2,
      revision: "revision-b",
      image: `registry.example/app@sha256:${"b".repeat(64)}`,
      port: appB.port as number,
    };
    holdNextCreate = true;
    const updating = runtime.reconcile(second);
    const settledUpdating = updating.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    let oldRoute: Response | undefined;
    try {
      await within(candidateCreateEntered.promise, 2_000);
      // The candidate's native creation is still pending. Admission must remain
      // bound to the old immutable revision while that external call is in flight.
      oldRoute = await within(
        runtime.fetch(identity, new Request("https://logical.example/")),
        2_000,
      );
      if (!oldRoute) throw new Error("old route did not return a response");
      expect(await oldRoute.json()).toEqual({ version: "a", path: "/", body: "" });
    } finally {
      releaseCandidateCreate.resolve();
      await within(settledUpdating, 2_000).catch(() => undefined);
    }
    const updateResult = await within(settledUpdating, 2_000);
    if (updateResult.status === "rejected") throw updateResult.error;
    expect(
      await (await runtime.fetch(identity, new Request("https://logical.example/"))).json(),
    ).toEqual({ version: "a", path: "/", body: "" });
    candidateHealthy = true;
    await runtime.reconcile(second);
    expect(
      await (await runtime.fetch(identity, new Request("https://logical.example/"))).json(),
    ).toEqual({ version: "b" });
    expect(created).toBe(2);
    const retiredBy = Date.now() + 2_000;
    while (containers.size > 1 && Date.now() < retiredBy) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(containers.size).toBe(1);
    await runtime.remove(identity);
    expect(containers.size).toBe(0);
    await expect(
      runtime.fetch(identity, new Request("https://logical.example/")),
    ).rejects.toThrow();
    await runtime.close();
    runtime = await createSelfhostContainerRuntime(options);
    await expect(runtime.reconcile(first)).rejects.toThrow();
    expect(containers.size).toBe(0);
  } finally {
    await runtime?.close();
    appA.stop(true);
    appB.stop(true);
    daemon.closeAllConnections();
    await new Promise<void>((resolve) => daemon.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
