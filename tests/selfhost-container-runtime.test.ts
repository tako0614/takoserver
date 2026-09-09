import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DockerHttpRevision,
  DockerHttpRevisionObservation,
} from "../src/providers/docker-http-revision.ts";
import {
  createSelfhostContainerRuntime,
  type SelfhostContainerRevision,
} from "../src/providers/selfhost-container-runtime.ts";
import { nodeSelfhostScriptStateFileSystem } from "../src/providers/selfhost-script-state.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function input(generation = 1, resourceUid = "resource-one"): SelfhostContainerRevision {
  return {
    resourceUid,
    incarnationId: "incarnation-one",
    generation,
    revision: `revision-${generation}`,
    image: `registry.example/app@sha256:${generation.toString(16).padStart(64, "0")}`,
    port: 8080,
    healthPath: "/health",
    memoryBytes: 268435456,
    nanoCpus: 500000000,
    environment: { MODE: "test" },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing test value");
  return value;
}

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(drainTimeoutMs = 120) {
  const root = await mkdtemp(join(tmpdir(), "selfhost-container-"));
  const nodes = new Map<string, { nativeId: string; endpoint: string; healthy: boolean }>();
  const servers: ReturnType<typeof Bun.serve>[] = [];
  const controllers = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const cancelled = new Set<string>();
  const nativeCalls: string[] = [];
  const requests: string[] = [];
  const unhealthy = new Set<string>();
  let nextId = 1;
  const key = (revision: DockerHttpRevision) =>
    JSON.stringify([revision.resourceUid, revision.incarnationId, revision.revision]);
  const hooks: {
    reconcile?: (revision: DockerHttpRevision) => Promise<void>;
    observe?: (revision: DockerHttpRevision) => Promise<void>;
    remove?: () => Promise<void>;
  } = {};
  const backend = {
    async reconcile(revision: DockerHttpRevision): Promise<DockerHttpRevisionObservation> {
      nativeCalls.push(`reconcile:${key(revision)}`);
      await hooks.reconcile?.(revision);
      if (!nodes.has(key(revision))) {
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const url = new URL(request.url);
            requests.push(`${revision.revision}:${url.pathname}`);
            if (url.pathname === "/stream") {
              const body = new ReadableStream<Uint8Array>({
                start(controller) {
                  controllers.set(key(revision), controller);
                  controller.enqueue(new TextEncoder().encode(`${revision.revision}:head\n`));
                },
                cancel() {
                  cancelled.add(key(revision));
                },
              });
              request.signal.addEventListener("abort", () => cancelled.add(key(revision)), {
                once: true,
              });
              return new Response(body, { headers: { "x-revision": revision.revision } });
            }
            if (url.pathname === "/redirect")
              return new Response(null, {
                status: 302,
                headers: { location: "http://127.0.0.1:1/not-followed" },
              });
            if (url.pathname === "/error")
              return new Response("application failure", { status: 503 });
            if (url.pathname === "/echo")
              return Response.json({
                revision: revision.revision,
                url: request.url,
                headers: Object.fromEntries(request.headers),
                body: await request.text(),
              });
            return new Response(revision.revision);
          },
        });
        servers.push(server);
        nodes.set(key(revision), {
          nativeId: (nextId++).toString(16).padStart(64, "0"),
          endpoint: `http://127.0.0.1:${server.port}`,
          healthy: !unhealthy.has(revision.revision),
        });
      }
      return this.observe(revision);
    },
    async observe(revision: DockerHttpRevision): Promise<DockerHttpRevisionObservation> {
      nativeCalls.push(`observe:${key(revision)}`);
      await hooks.observe?.(revision);
      const node = nodes.get(key(revision));
      if (!node) return { state: "absent" };
      return node.healthy
        ? { state: "ready", nativeId: node.nativeId, endpoint: node.endpoint }
        : { state: "starting", nativeId: node.nativeId };
    },
    async remove(revision: DockerHttpRevision, nativeId?: string): Promise<void> {
      nativeCalls.push(`remove:${key(revision)}:${nativeId}`);
      await hooks.remove?.();
      const node = nodes.get(key(revision));
      if (node && node.nativeId !== nativeId) throw new Error("wrong native retirement pin");
      nodes.delete(key(revision));
    },
  };
  const handles: Awaited<ReturnType<typeof createSelfhostContainerRuntime>>[] = [];
  async function open(fileSystem = nodeSelfhostScriptStateFileSystem) {
    const runtime = await createSelfhostContainerRuntime({
      root,
      backend,
      drainTimeoutMs,
      fileSystem,
    });
    handles.push(runtime);
    return runtime;
  }
  cleanups.push(async () => {
    for (const runtime of handles) await runtime.close();
    for (const server of servers) await server.stop(true);
    await rm(root, { recursive: true, force: true });
  });
  async function snapshot() {
    const filename = (await readdir(root)).find((name) => name.endsWith(".json"));
    if (!filename) throw new Error("No durable snapshot");
    return {
      filename: join(root, filename),
      state: JSON.parse(await readFile(join(root, filename), "utf8")),
    };
  }
  return {
    root,
    backend,
    nodes,
    nativeCalls,
    requests,
    unhealthy,
    hooks,
    controllers,
    cancelled,
    key,
    open,
    snapshot,
  };
}

test("container intent and native identity persist before serving, and restart uses exact serving", async () => {
  const f = await fixture();
  f.hooks.reconcile = async () => {
    const { state } = await f.snapshot();
    expect(state.desired).toBe(1);
    expect(state.serving).toBeNull();
    expect(state.revisions[0].nativeId).toBeNull();
  };
  let runtime = await f.open();
  expect(await runtime.reconcile(input())).toMatchObject({ state: "ready", servingGeneration: 1 });
  const { filename, state } = await f.snapshot();
  expect(state.revisions[0].nativeId).toBe(f.nodes.get(f.key(input()))?.nativeId);
  expect((await stat(filename)).mode & 0o777).toBe(0o600);
  expect((await stat(f.root)).mode & 0o777).toBe(0o700);
  await runtime.close();
  const before = f.nativeCalls.filter((call) => call.startsWith("reconcile:")).length;
  runtime = await f.open();
  expect(await runtime.observe(input())).toMatchObject({ state: "ready", servingGeneration: 1 });
  expect(await (await runtime.fetch(input(), new Request("https://caller.invalid/"))).text()).toBe(
    "revision-1",
  );
  expect(f.nativeCalls.filter((call) => call.startsWith("reconcile:"))).toHaveLength(before);
});

test("unhealthy or pending updates retain old traffic without holding its admission lock", async () => {
  const f = await fixture();
  const runtime = await f.open();
  await runtime.reconcile(input());
  const entered = deferred();
  const release = deferred();
  f.unhealthy.add("revision-2");
  f.hooks.reconcile = async (revision) => {
    if (revision.revision === "revision-2") {
      entered.resolve();
      await release.promise;
    }
  };
  const updating = runtime.reconcile(input(2));
  await entered.promise;
  expect(await (await runtime.fetch(input(), new Request("https://caller.invalid/"))).text()).toBe(
    "revision-1",
  );
  release.resolve();
  expect(await updating).toMatchObject({
    state: "updating",
    desiredGeneration: 2,
    servingGeneration: 1,
  });
  await runtime.close();
  const recovered = await f.open();
  expect(await recovered.observe(input())).toMatchObject({
    state: "updating",
    servingGeneration: 1,
  });
  expect(
    await (await recovered.fetch(input(), new Request("https://caller.invalid/"))).text(),
  ).toBe("revision-1");
});

test("streamed calls retain old revision through cutover, bounded drain aborts even unread bodies", async () => {
  const f = await fixture(180);
  const runtime = await f.open();
  await runtime.reconcile(input());
  const response = await runtime.fetch(input(), new Request("http://attacker.invalid/stream"));
  const reader = required(response.body).getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("revision-1:head\n");
  await runtime.reconcile(input(2));
  expect(await (await runtime.fetch(input(), new Request("https://caller.invalid/"))).text()).toBe(
    "revision-2",
  );
  expect(f.nodes.has(f.key(input()))).toBe(true);
  required(f.controllers.get(f.key(input()))).enqueue(new TextEncoder().encode("old:tail"));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("old:tail");
  const remaining = reader.read();
  await expect(remaining).rejects.toThrow();
  await until(() => !f.nodes.has(f.key(input())));
  await until(() => f.cancelled.has(f.key(input())));
  const unread = await runtime.fetch(input(), new Request("http://caller.invalid/stream"));
  await runtime.reconcile(input(3));
  await until(() => !f.nodes.has(f.key(input(2))));
  await expect(unread.text()).rejects.toThrow();
  await until(() => f.cancelled.has(f.key(input(2))));
});

test("generation fencing is durable and shared by two in-process handles", async () => {
  const f = await fixture();
  const first = await f.open();
  const second = await f.open();
  await first.reconcile(input());
  await second.reconcile(input(2));
  const before = f.nativeCalls.filter((call) => call.startsWith("reconcile:")).length;
  await expect(first.reconcile(input())).rejects.toMatchObject({ code: "conflict" });
  await expect(
    first.reconcile({ ...input(2), environment: { MODE: "changed" } }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(f.nativeCalls.filter((call) => call.startsWith("reconcile:"))).toHaveLength(before);
  await first.close();
  expect(await (await second.fetch(input(), new Request("https://caller.invalid/"))).text()).toBe(
    "revision-2",
  );
  await second.close();
  const reopened = await f.open();
  await expect(reopened.reconcile(input())).rejects.toMatchObject({ code: "conflict" });
});

test("drain deadlines abort old streams while a newer reconciliation holds the lifecycle lock", async () => {
  const f = await fixture(80);
  const runtime = await f.open();
  await runtime.reconcile(input());
  const response = await runtime.fetch(input(), new Request("https://caller.invalid/stream"));
  const reader = required(response.body).getReader();
  await reader.read();
  await runtime.reconcile(input(2));
  const entered = deferred();
  const release = deferred();
  f.hooks.reconcile = async (revision) => {
    if (revision.revision === "revision-3") {
      entered.resolve();
      await release.promise;
    }
  };
  const updating = runtime.reconcile(input(3));
  await entered.promise;
  try {
    await expect(reader.read()).rejects.toThrow();
    expect(f.nodes.has(f.key(input()))).toBe(true);
    expect(
      await (await runtime.fetch(input(), new Request("https://caller.invalid/"))).text(),
    ).toBe("revision-2");
  } finally {
    release.resolve();
    await updating;
  }
});

test("delete tombstone fences calls before drain and cannot reactivate a recreated UID", async () => {
  const f = await fixture(80);
  const runtime = await f.open();
  await runtime.reconcile(input());
  const replacement = input(1, "different-resource-uid");
  await runtime.reconcile(replacement);
  const response = await runtime.fetch(input(), new Request("https://caller.invalid/stream"));
  const deletion = runtime.remove(input());
  await until(async () => (await runtime.observe(input())).state === "deleting");
  await expect(runtime.fetch(input(), new Request("https://caller.invalid/"))).rejects.toThrow();
  expect(await deletion).toMatchObject({ state: "deleted" });
  await expect(response.text()).rejects.toThrow();
  expect(f.nodes.has(f.key(input()))).toBe(false);
  expect(
    await (await runtime.fetch(replacement, new Request("https://caller.invalid/"))).text(),
  ).toBe("revision-1");
  await runtime.close();
  const restarted = await f.open();
  await expect(restarted.reconcile(input(2))).rejects.toMatchObject({ code: "conflict" });
  expect(await restarted.remove(input())).toMatchObject({ state: "deleted" });
  expect(f.nodes.has(f.key(replacement))).toBe(true);
});

test("unknown native readback refuses, definite absence repairs, contradictory ID never mutates", async () => {
  const f = await fixture();
  const runtime = await f.open();
  await runtime.reconcile(input());
  f.hooks.observe = async () => {
    throw new Error("indeterminate native transport");
  };
  await expect(runtime.observe(input())).rejects.toThrow("indeterminate");
  const before = f.nativeCalls.filter((call) => call.startsWith("reconcile:")).length;
  await expect(runtime.reconcile(input())).rejects.toThrow("indeterminate");
  expect(f.nativeCalls.filter((call) => call.startsWith("reconcile:"))).toHaveLength(before);
  delete f.hooks.observe;
  const original = required(f.nodes.get(f.key(input())));
  f.nodes.set(f.key(input()), { ...original, nativeId: "f".repeat(64) });
  await expect(runtime.reconcile(input())).rejects.toMatchObject({ code: "conflict" });
  expect(f.nativeCalls.filter((call) => call.startsWith("reconcile:"))).toHaveLength(before);
  f.nodes.delete(f.key(input()));
  expect(await runtime.observe(input())).toMatchObject({ state: "unavailable" });
  expect(await runtime.reconcile(input())).toMatchObject({ state: "ready" });
  expect(f.nodes.get(f.key(input()))?.nativeId).not.toBe(original.nativeId);
});

test("lost create response remains recoverable and delete removes its unacknowledged native object", async () => {
  const f = await fixture(15);
  const original = f.backend.reconcile.bind(f.backend);
  f.backend.reconcile = async (revision) => {
    await original(revision);
    throw new Error("lost response");
  };
  let runtime = await f.open();
  await expect(runtime.reconcile(input())).rejects.toThrow("lost response");
  expect((await f.snapshot()).state.revisions[0].nativeId).toBeNull();
  expect(f.nodes.size).toBe(1);
  await runtime.close();
  runtime = await f.open();
  expect(await runtime.remove(input())).toMatchObject({ state: "deleted" });
  expect(f.nodes.size).toBe(0);
  expect(f.nativeCalls.find((call) => call.startsWith("remove:"))).toEndWith("1".padStart(64, "0"));
});

test("restart honors retained drain deadline and close never deletes native execution", async () => {
  const f = await fixture(300);
  let runtime = await f.open();
  await runtime.reconcile(input());
  await runtime.reconcile(input(2));
  await runtime.close();
  expect(f.nodes.size).toBe(2);
  runtime = await f.open();
  expect(await runtime.observe(input())).toMatchObject({ state: "ready", servingGeneration: 2 });
  expect(f.nodes.size).toBe(2);
  await until(() => f.nodes.size === 1);
  expect(f.nodes.has(f.key(input(2)))).toBe(true);
});

test("a lost create acknowledgement followed by absence cannot authorize recreate or completed deletion", async () => {
  const f = await fixture(15);
  const create = f.backend.reconcile.bind(f.backend);
  let attempted = 0;
  f.backend.reconcile = async () => {
    attempted++;
    throw new Error("daemon has queued the create");
  };
  let runtime = await f.open();
  await expect(runtime.reconcile(input())).rejects.toThrow("queued");
  await runtime.close();
  runtime = await f.open();
  await expect(runtime.reconcile(input())).rejects.toMatchObject({ code: "unavailable" });
  expect(attempted).toBe(1);
  await expect(runtime.remove(input())).rejects.toMatchObject({ code: "unavailable" });
  expect(await runtime.observe(input())).toMatchObject({ state: "deleting" });
  expect((await f.snapshot()).state.deleted).toBe(false);
  // The original daemon request commits late, without a new lifecycle call.
  await create(input());
  expect(await runtime.remove(input())).toMatchObject({ state: "deleted" });
  expect(f.nodes.size).toBe(0);
  expect(attempted).toBe(1);
});

test("HTTP proxy strips native-origin authority and hop headers, streams body, preserves errors and redirects", async () => {
  const f = await fixture();
  const runtime = await f.open();
  await runtime.reconcile(input());
  const parts = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("part-one"));
      controller.enqueue(new TextEncoder().encode("part-two"));
      controller.close();
    },
  });
  const result = await runtime.fetch(
    input(),
    new Request("https://untrusted.invalid/echo?x=1", {
      method: "POST",
      headers: {
        host: "attacker.invalid",
        connection: "x-private",
        "x-private": "do-not-forward",
        "x-app": "kept",
      },
      body: parts,
    }),
  );
  const echoed = await result.json();
  expect(echoed.url).toEndWith("/echo?x=1");
  expect(echoed.url).toStartWith("http://127.0.0.1:");
  expect(echoed.body).toBe("part-onepart-two");
  expect(echoed.headers["x-private"]).toBeUndefined();
  expect(echoed.headers["x-app"]).toBe("kept");
  expect(echoed.headers.host).not.toBe("attacker.invalid");
  const error = await runtime.fetch(input(), new Request("https://caller.invalid/error"));
  expect(error.status).toBe(503);
  expect(await error.text()).toBe("application failure");
  const redirect = await runtime.fetch(input(), new Request("https://caller.invalid/redirect"));
  expect(redirect.status).toBe(302);
  expect(redirect.headers.get("location")).toBe("http://127.0.0.1:1/not-followed");
  expect(f.requests.filter((request) => request.endsWith(":/redirect"))).toHaveLength(1);
});

test("cancelling a response cancels upstream and close aborts a held body without native deletion", async () => {
  const f = await fixture();
  const runtime = await f.open();
  await runtime.reconcile(input());
  const response = await runtime.fetch(input(), new Request("https://caller.invalid/stream"));
  await required(response.body).cancel();
  await until(() => f.cancelled.has(f.key(input())));
  f.cancelled.clear();
  const held = await runtime.fetch(input(), new Request("https://caller.invalid/stream"));
  await runtime.close();
  await expect(held.text()).rejects.toThrow();
  await until(() => f.cancelled.has(f.key(input())));
  expect(f.nodes.size).toBe(1);
  expect(f.nativeCalls.filter((call) => call.startsWith("remove:"))).toHaveLength(0);
});

test("ambiguous fsync after rename fences cached authority until exact reopening", async () => {
  const f = await fixture();
  let failSync = false;
  const fileSystem = {
    ...nodeSelfhostScriptStateFileSystem,
    async syncDirectory(path: string) {
      if (failSync) throw new Error("directory sync failed");
      return nodeSelfhostScriptStateFileSystem.syncDirectory(path);
    },
  };
  const runtime = await f.open(fileSystem);
  await runtime.reconcile(input());
  const response = await runtime.fetch(input(), new Request("https://caller.invalid/stream"));
  failSync = true;
  await expect(runtime.remove(input())).rejects.toMatchObject({ code: "unavailable" });
  expect((await f.snapshot()).state.deleting).toBe(true);
  await expect(response.text()).rejects.toThrow();
  await expect(
    runtime.fetch(input(), new Request("https://caller.invalid/")),
  ).rejects.toMatchObject({ code: "unavailable" });
  await expect(runtime.observe(input())).rejects.toMatchObject({ code: "unavailable" });
  await runtime.close();
  failSync = false;
  const reopened = await f.open(fileSystem);
  expect(await reopened.remove(input())).toMatchObject({ state: "deleted" });
});

test("unknown or inconsistent persisted snapshot cannot become serving authority", async () => {
  const f = await fixture();
  const runtime = await f.open();
  await runtime.reconcile(input());
  await runtime.close();
  const { filename, state } = await f.snapshot();
  await writeFile(filename, JSON.stringify({ ...state, version: 99 }), { mode: 0o600 });
  const reopened = await f.open();
  await expect(reopened.observe(input())).rejects.toMatchObject({ code: "corrupt" });
  await expect(
    reopened.fetch(input(), new Request("https://caller.invalid/")),
  ).rejects.toMatchObject({ code: "corrupt" });
});
