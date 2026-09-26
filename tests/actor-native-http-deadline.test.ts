import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActorNativeOwner } from "../src/actor-native-owner-worker.ts";

const headers = {
  "x-takoserver-private-actor-id": "same-id",
  "x-takoserver-private-actor-variant": "default",
};

function fixture(
  fetch: (request: Request) => Promise<Response>,
  deadlines = { handlerMs: 20, producerMs: 30 },
) {
  const retained: Promise<unknown>[] = [];
  const aborts: string[] = [];
  const Owner = createActorNativeOwner(
    "a".repeat(64),
    "c".repeat(64),
    { generationKey: "d".repeat(64), epoch: "epoch-1", variantKeys: ["default"] },
    deadlines,
  );
  const owner = new Owner(
    {
      facets: {
        get: () => ({ fetch }),
        abort: (_name, reason) => aborts.push(reason),
      },
      waitUntil: (promise) => retained.push(promise),
    },
    { CLASS: {}, CLASS_0: {} },
  );
  return { owner, aborts, retained };
}

test("head deadline yields a complete 504, cancels the turn and releases same-ID admission", async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const f = fixture(async (request) => {
    calls += 1;
    if (calls === 1) {
      signal = request.signal;
      return new Promise<Response>(() => {});
    }
    return new Response("next");
  });
  const first = await f.owner.fetch(new Request("http://actor.invalid/", { headers }));
  expect(first.status).toBe(504);
  expect(await first.text()).toBe("");
  expect(signal?.aborted).toBe(true);
  expect(
    await (await f.owner.fetch(new Request("http://actor.invalid/", { headers }))).text(),
  ).toBe("next");
  expect(f.aborts).toHaveLength(2);
  await Promise.all(f.retained);
});

test("producer deadline retains its head and errors the unfinished body before next same-ID turn", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls += 1;
    if (calls === 1)
      return new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }), {
        status: 201,
      });
    return new Response("next");
  });
  const first = await f.owner.fetch(new Request("http://actor.invalid/", { headers }));
  const next = f.owner.fetch(new Request("http://actor.invalid/", { headers }));
  expect(first.status).toBe(201);
  await expect(first.text()).rejects.toThrow("response_aborted");
  expect(await (await next).text()).toBe("next");
  expect(f.aborts).toHaveLength(2);
  await Promise.all(f.retained);
});

test("nonsettling request-body cancellation cannot hold retirement; another owner ID continues", async () => {
  let cancelCalled = false;
  let aborted = false;
  const stuck = fixture(async (request) => {
    request.signal.addEventListener("abort", () => {
      aborted = true;
    });
    return new Promise<Response>(() => {});
  });
  const sibling = fixture(async () => new Response("sibling"));
  const request = new Request("http://actor.invalid/", {
    method: "POST",
    headers,
    body: new ReadableStream({
      pull: () => new Promise(() => {}),
      cancel() {
        cancelCalled = true;
        return new Promise<void>(() => {});
      },
    }),
  });
  const first = stuck.owner.fetch(request);
  expect(
    await (await sibling.owner.fetch(new Request("http://actor.invalid/", { headers }))).text(),
  ).toBe("sibling");
  expect((await first).status).toBe(504);
  expect(aborted).toBe(true);
  expect(cancelCalled).toBe(true);
  expect(stuck.aborts).toHaveLength(1);
  await Promise.all(stuck.retained);
  await Promise.all(sibling.retained);
});

test("already completed response is not retroactively failed by its producer deadline", async () => {
  const f = fixture(async () => new Response("complete"));
  const response = await f.owner.fetch(new Request("http://actor.invalid/", { headers }));
  expect(await response.text()).toBe("complete");
  await Bun.sleep(50);
  expect(response.status).toBe(200);
  expect(f.aborts).toHaveLength(1);
  await Promise.all(f.retained);
});

const candidate = process.env.TAKOSERVER_ACTOR_QUALIFICATION_BINARY;
const candidateDigest = process.env.TAKOSERVER_ACTOR_QUALIFICATION_SHA256;

test.skipIf(candidate === undefined)(
  "exact native candidate retires a stuck response producer before same-ID readmission",
  async () => {
    if (!candidate || !candidateDigest || !/^[a-f0-9]{64}$/u.test(candidateDigest))
      throw new Error("explicit candidate binary and SHA256 required");
    const root = await mkdtemp(join(tmpdir(), "takoserver-actor-http-deadline-"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let diagnostics: Promise<string> | undefined;
    let stderr = "";
    try {
      const snapshot = join(root, "workerd");
      await copyFile(candidate, snapshot);
      expect(
        createHash("sha256")
          .update(await readFile(snapshot))
          .digest("hex"),
      ).toBe(candidateDigest);
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, "../src/actor-native-owner-worker.ts")],
        target: "browser",
        format: "esm",
        minify: false,
      });
      if (!built.success || !built.outputs[0]) throw new Error("Actor owner bundle failed");
      await writeFile(join(root, "owner.mjs"), await built.outputs[0].text());
      await writeFile(
        join(root, "supervisor.mjs"),
        `import { createActorNativeOwner } from "./owner.mjs";
export const Owner = createActorNativeOwner("${"a".repeat(64)}", "${"c".repeat(64)}", {
  generationKey: "${"d".repeat(64)}", epoch: "epoch-1", variantKeys: ["default"],
}, { handlerMs: 500, producerMs: 250 });
export default {
  fetch(request, env) {
    if (new URL(request.url).pathname === "/health") return new Response("ready");
    const id = new URL(request.url).searchParams.get("id") || "same-id";
    const headers = new Headers(request.headers);
    headers.set("x-takoserver-private-actor-id", encodeURIComponent(id));
    headers.set("x-takoserver-private-actor-variant", "default");
    return env.NAMESPACE.get(env.NAMESPACE.idFromName(id)).fetch(new Request(request, { headers }));
  },
};`,
      );
      await writeFile(
        join(root, "child.mjs"),
        `export class Child {
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/head-stuck") return new Promise(() => {});
    if (path === "/stuck") return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("first")); },
    }), { status: 202 });
    return new Response(path === "/next" ? "next" : "sibling");
  }
}
export default { fetch() { return new Response("private", { status: 404 }); } };`,
      );
      await mkdir(join(root, "state"), { mode: 0o700 });
      const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = reserved.port;
      reserved.stop(true);
      await writeFile(
        join(root, "config.capnp"),
        `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "owner", worker = (
      modules = [(name = "supervisor.mjs", esModule = embed "supervisor.mjs"),
        (name = "owner.mjs", esModule = embed "owner.mjs")],
      compatibilityDate = "2026-01-01", compatibilityFlags = ["experimental"],
      globalOutbound = "deny",
      bindings = [(name = "NAMESPACE", durableObjectNamespace = "Owner"),
        (name = "CLASS", durableObjectClass = (name = "child", entrypoint = "Child")),
        (name = "CLASS_0", durableObjectClass = (name = "child", entrypoint = "Child"))],
      durableObjectNamespaces = [(className = "Owner", uniqueKey = "actor-http-deadline", enableSql = true)],
      durableObjectStorage = (localDisk = "state")
    )),
    (name = "child", worker = (
      modules = [(name = "child.mjs", esModule = embed "child.mjs")],
      compatibilityDate = "2026-01-01", compatibilityFlags = ["experimental"],
      globalOutbound = "deny"
    )),
    (name = "state", disk = (path = ${JSON.stringify(join(root, "state"))}, writable = true)),
    (name = "deny", network = (allow = []))
  ], sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "owner")]
);`,
      );
      child = Bun.spawn([snapshot, "serve", "--experimental", join(root, "config.capnp")], {
        env: {},
        stdout: "ignore",
        stderr: "pipe",
      });
      diagnostics =
        typeof child.stderr === "number" ? Promise.resolve("") : new Response(child.stderr).text();
      const origin = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          ready = (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(100) })).ok;
        } catch {}
        if (ready) break;
        await Bun.sleep(25);
      }
      expect(ready).toBe(true);
      const first = await fetch(`${origin}/stuck`, { signal: AbortSignal.timeout(5_000) });
      expect(first.status).toBe(202);
      const reader = first.body?.getReader();
      expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("first");
      expect(
        await (
          await fetch(`${origin}/sibling?id=other`, { signal: AbortSignal.timeout(5_000) })
        ).text(),
      ).toBe("sibling");
      try {
        await reader?.read();
      } catch {
        // workerd may surface an errored response body as a reset transport.
      }
      expect(
        await (await fetch(`${origin}/next`, { signal: AbortSignal.timeout(5_000) })).text(),
      ).toBe("next");
      const expiredHead = await fetch(`${origin}/head-stuck`, {
        signal: AbortSignal.timeout(5_000),
      });
      expect(expiredHead.status).toBe(504);
      expect(await expiredHead.text()).toBe("");
      expect(
        await (await fetch(`${origin}/next`, { signal: AbortSignal.timeout(5_000) })).text(),
      ).toBe("next");
    } finally {
      child?.kill(9);
      await child?.exited;
      stderr = (await diagnostics) ?? "";
      if (stderr && !stderr.includes("response_aborted")) console.error(stderr);
      await rm(root, { recursive: true, force: true });
    }
    // The candidate's HTTP socket can surface the errored body as EOF rather
    // than a JS rejection. Its own runtime diagnostic proves the error reason.
    expect(stderr).toContain("response_aborted");
  },
  15_000,
);
