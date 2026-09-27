import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActorNativeOwner } from "../src/actor-native-owner-worker.ts";
import { ACTOR_NATIVE_BOOTSTRAP_SOURCE } from "../src/generated/actor-native-bootstrap.ts";

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
  "exact native candidate stops captured callbacks and producer work before same-ID readmission",
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
      await writeFile(join(root, "helper.mjs"), ACTOR_NATIVE_BOOTSTRAP_SOURCE);
      await writeFile(
        join(root, "supervisor.mjs"),
        `import { createActorNativeOwner, createActorNativeIngress } from "./owner.mjs";
export const Owner = createActorNativeOwner("${"a".repeat(64)}", "${"c".repeat(64)}", {
  generationKey: "${"d".repeat(64)}", epoch: "epoch-1", variantKeys: ["default"],
}, { handlerMs: 500, producerMs: 250 });
const ingress = createActorNativeIngress("${"e".repeat(64)}", "${"b".repeat(64)}");
export default {
  fetch(request, env) {
    if (new URL(request.url).pathname === "/health") return new Response("ready");
    if (request.headers.has("x-takoserver-private-alarm-action")) return ingress.fetch(request, env);
    const id = new URL(request.url).searchParams.get("id") || "same-id";
    const headers = new Headers(request.headers);
    headers.set("x-takoserver-private-actor-token", "${"e".repeat(64)}");
    headers.set("x-takoserver-private-actor-id", encodeURIComponent(id));
    headers.set("x-takoserver-private-actor-variant", "default");
    return ingress.fetch(new Request(request, { headers }), env);
  },
};`,
      );
      await writeFile(
        join(root, "child.mjs"),
        `import { createNativeActorExecution, createActorNativeAlarmPort } from "./helper.mjs";
class Application {
  constructor(context) {
    this.context = context;
    this.instance = crypto.randomUUID();
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/head-stuck") return new Promise(() => {});
    if (path === "/captured-producer") {
      await this.context.storage.execute("CREATE TABLE IF NOT EXISTS retirement_probe (stage TEXT NOT NULL)");
      const context = this.context;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("first")); },
        async pull(controller) {
          await context.storage.execute("INSERT INTO retirement_probe (stage) VALUES ('armed')");
          console.error("actor-probe:producer-armed");
          await new Promise((resolve) => setTimeout(resolve, 700));
          console.error("actor-probe:producer-resumed");
          await Promise.allSettled([
            context.storage.execute("INSERT INTO retirement_probe (stage) VALUES ('late')"),
            context.alarm.set(Date.now() + 60_000),
          ]);
          controller.enqueue(new TextEncoder().encode("late"));
        },
      }), { status: 202, headers: { "x-actor-instance": this.instance } });
    }
    if (path === "/detached-callback") {
      await this.context.storage.execute("INSERT INTO retirement_probe (stage) VALUES ('detached-armed')");
      const context = this.context;
      console.error("actor-probe:detached-armed");
      setTimeout(async () => {
        console.error("actor-probe:detached-resumed");
        await Promise.allSettled([
          context.storage.execute("INSERT INTO retirement_probe (stage) VALUES ('detached-late')"),
          context.alarm.set(Date.now() + 60_000),
        ]);
      }, 700);
      return new Response("detached");
    }
    if (path === "/retirement-state") {
      const result = await this.context.storage.query("SELECT stage FROM retirement_probe ORDER BY rowid");
      return Response.json({ stages: result.rows.map((row) => row.stage), alarmAt: await this.context.alarm.get() });
    }
    if (path === "/stuck") return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("first")); },
    }), { status: 202 });
    return new Response(path === "/next" ? "next" : "sibling", {
      headers: { "x-actor-instance": this.instance },
    });
  }
  alarm() {}
  socketMessage() {}
  socketClose() {}
  socketError() {}
}
export class Child {
  constructor(state, env) {
    const id = state.id.toString();
    this.execution = createNativeActorExecution({
      namespace: { Application }, exportName: "Application", id,
      env: {}, storage: state.storage,
      alarm: createActorNativeAlarmPort(env.ALARM_OWNER, "${"b".repeat(64)}", id),
    });
  }
  fetch(request) { return this.execution.fetch(request); }
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
      modules = [(name = "child.mjs", esModule = embed "child.mjs"),
        (name = "helper.mjs", esModule = embed "helper.mjs")],
      compatibilityDate = "2026-01-01", compatibilityFlags = ["experimental"],
      globalOutbound = "deny",
      bindings = [(name = "ALARM_OWNER", service = "owner")]
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
      const captured = await fetch(`${origin}/captured-producer`, {
        signal: AbortSignal.timeout(5_000),
      });
      expect(captured.status).toBe(202);
      const capturedInstance = captured.headers.get("x-actor-instance");
      const capturedReader = captured.body?.getReader();
      expect(new TextDecoder().decode((await capturedReader?.read())?.value)).toBe("first");
      expect(
        await (
          await fetch(`${origin}/sibling?id=other`, { signal: AbortSignal.timeout(5_000) })
        ).text(),
      ).toBe("sibling");
      try {
        await capturedReader?.read();
      } catch {
        // The producer deadline can reset the external HTTP body transport.
      }
      const nextAfterRetirement = await fetch(`${origin}/next`, {
        signal: AbortSignal.timeout(5_000),
      });
      expect(await nextAfterRetirement.text()).toBe("next");
      await Bun.sleep(900);
      const retirementState = await fetch(`${origin}/retirement-state`, {
        signal: AbortSignal.timeout(5_000),
      });
      expect(retirementState.status).toBe(200);
      expect(await retirementState.json()).toEqual({ stages: ["armed"], alarmAt: null });
      expect(nextAfterRetirement.headers.get("x-actor-instance")).not.toBe(capturedInstance);
      const detached = await fetch(`${origin}/detached-callback`, {
        signal: AbortSignal.timeout(5_000),
      });
      expect(await detached.text()).toBe("detached");
      expect(
        await (
          await fetch(`${origin}/sibling?id=other`, { signal: AbortSignal.timeout(5_000) })
        ).text(),
      ).toBe("sibling");
      expect(
        await (await fetch(`${origin}/next`, { signal: AbortSignal.timeout(5_000) })).text(),
      ).toBe("next");
      await Bun.sleep(900);
      const afterDetached = await fetch(`${origin}/retirement-state`, {
        signal: AbortSignal.timeout(5_000),
      });
      expect(await afterDetached.json()).toEqual({
        stages: ["armed", "detached-armed"],
        alarmAt: null,
      });
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
    expect(stderr).toContain("actor-probe:producer-armed");
    expect(stderr).toContain("actor-probe:detached-armed");
    expect(stderr).not.toContain("actor-probe:producer-resumed");
    expect(stderr).not.toContain("actor-probe:detached-resumed");
  },
  15_000,
);
