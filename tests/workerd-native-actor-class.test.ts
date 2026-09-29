import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKERD_CLOSED_GRAPH_ARTIFACT } from "../src/workerd-artifact.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

// Explicit LOCAL qualifier. This does not alter the production selector/pin.
const binary = nativeEvidenceBinary("actor-qualification");
const expectedDigest = process.env.TAKOSERVER_ACTOR_QUALIFICATION_SHA256;

test.skipIf(binary === undefined)(
  "native child executes generic Actor class with private durable SQL",
  async () => {
    if (!binary || !expectedDigest || !/^[a-f0-9]{64}$/.test(expectedDigest))
      throw new Error("explicit candidate binary and SHA256 required");
    const root = await mkdtemp(join(tmpdir(), "takoserver-actor-class-"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const control = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        entered();
        await held;
        return new Response("released");
      },
    });
    let diagnostics = "";
    let drain: Promise<void> | undefined;
    try {
      const snapshot = join(root, "workerd");
      await copyFile(binary, snapshot);
      expect(
        createHash("sha256")
          .update(await readFile(snapshot))
          .digest("hex"),
      ).toBe(expectedDigest);
      // A candidate qualifier must not silently promote the serving pin.
      expect(WORKERD_CLOSED_GRAPH_ARTIFACT.sha256).toBe(
        "c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52",
      );
      const bundle = await Bun.build({
        entrypoints: [join(import.meta.dir, "../src/actor-native-class-execution.ts")],
        target: "browser",
        format: "esm",
        minify: false,
      });
      if (!bundle.success || !bundle.outputs[0]) throw new Error("Actor adapter build failed");
      await writeFile(join(root, "adapter.mjs"), await bundle.outputs[0].text());
      await writeFile(
        join(root, "host.mjs"),
        `import * as namespace from "./witness.mjs";
import { createNativeActorExecution } from "./adapter.mjs";
export class ActorChild {
 constructor(state, env) { this.actor = createNativeActorExecution({ namespace, exportName: "Witness", id: state.id.toString(), env: { VERSION: env.VERSION, CONTROL: env.CONTROL }, storage: state.storage, alarm: { async set() { throw new Error("no owner"); }, async get() { throw new Error("no owner"); }, async clear() { throw new Error("no owner"); } } }); }
 fetch(request) { return this.actor.fetch(request); }
}
export default { fetch() { return new Response("not a public entrypoint", {status:404}); } };`,
      );
      for (const name of ["counter", "witness", "supervisor"])
        await copyFile(
          join(import.meta.dir, "fixtures/actor-host", `${name}.mjs`),
          join(root, `${name}.mjs`),
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
  (name = "supervisor", worker = (
   modules = [(name = "supervisor.mjs", esModule = embed "supervisor.mjs")],
   compatibilityDate = "2026-01-01", compatibilityFlags = ["experimental"], globalOutbound = "deny",
   bindings = [(name = "COUNTERS", durableObjectNamespace = "Supervisor"), (name = "CLASS", durableObjectClass = (name = "child", entrypoint = "ActorChild"))],
   durableObjectNamespaces = [(className = "Supervisor", uniqueKey = "actor-class-qualification", enableSql = true)], durableObjectStorage = (localDisk = "state")
  )),
  (name = "child", worker = (
   modules = [(name = "host.mjs", esModule = embed "host.mjs", role = hostPrivate), (name = "adapter.mjs", esModule = embed "adapter.mjs", role = hostPrivate),
    (name = "witness.mjs", esModule = embed "witness.mjs", role = application), (name = "counter.mjs", esModule = embed "counter.mjs", role = application)],
   modulePolicy = (applicationMain = "witness.mjs"), compatibilityDate = "2026-01-01", compatibilityFlags = ["experimental", "disallow_importable_env"], globalOutbound = "deny",
   bindings = [(name = "VERSION", text = "fixture-v1"), (name = "CONTROL", service = "control"), (name = "PRIVATE", text = "not-projected")]
  )),
  (name = "state", disk = (path = ${JSON.stringify(join(root, "state"))}, writable = true)),
  (name = "deny", network = (allow = [])),
  (name = "control", external = (address = "127.0.0.1:${control.port}", http = ()))
 ], sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "supervisor")]
);`,
      );
      const origin = `http://127.0.0.1:${port}`;
      const start = async () => {
        child = Bun.spawn([snapshot, "serve", "--experimental", join(root, "config.capnp")], {
          env: {},
          stdout: "ignore",
          stderr: "pipe",
        });
        drain = (async () => {
          const stderr = child?.stderr;
          if (stderr && typeof stderr !== "number")
            diagnostics += await new Response(stderr).text();
        })();
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(100) })).ok) {
              ready = true;
              break;
            }
          } catch {}
          await Bun.sleep(25);
        }
        expect(ready).toBe(true);
      };
      await start();
      const call = async (path: string, method = "GET") => {
        const response = await fetch(`${origin}${path}`, {
          method,
          signal: AbortSignal.timeout(5000),
        });
        const body = await response.text();
        if (response.status !== 200) throw new Error(`Actor fixture ${response.status}: ${body}`);
        return JSON.parse(body);
      };
      const first = await call("/increment", "POST");
      expect(first).toMatchObject({ value: 1, version: "fixture-v1" });
      const witness = await call("/witness");
      expect(witness).toMatchObject({
        order: ["constructor", "start", "ready", "fetch", "fetch"],
        starts: 1,
        hidden: "blocked",
        builtin: "blocked",
        atomic: "invalid_sql",
        signal: true,
        contextKeys: ["alarm", "id", "sockets", "storage"],
        storageKeys: ["execute", "query", "transaction"],
        envKeys: ["CONTROL", "VERSION"],
        blob: { encoding: "base64", data: "AAH/" },
        controls: ["invalid_sql", "invalid_sql", "invalid_sql", "invalid_sql"],
      });
      expect(witness.schema).not.toContain("host_metadata");
      expect(witness.schema).not.toContain("query_must_rollback");
      expect((await call("/value")).value).toBe(1);
      expect(await call("/sql-probe")).toEqual({
        errors: [
          "numeric_out_of_range",
          "numeric_out_of_range",
          "invalid_sql",
          "constraint_violation",
          "invalid_sql",
          "result_too_large",
        ].map((code) => ({ name: code, code })),
        rows: [{ id: 1, value: 1 }],
        triggerRollback: 0,
      });
      const values = await Promise.all(Array.from({ length: 8 }, () => call("/increment", "POST")));
      expect(values.map((value) => value.value).sort((a, b) => a - b)).toEqual([
        2, 3, 4, 5, 6, 7, 8, 9,
      ]);
      expect((await call("/value?id=other")).value).toBe(0);
      await call("/reconstruct");
      const reconstructed = await call("/value");
      expect(reconstructed).toEqual({ ...first, value: 9 });
      expect((await call("/witness")).starts).toBe(2);
      const holding = call("/increment?hold=1", "POST");
      await Promise.race([
        reached,
        Bun.sleep(3000).then(() => {
          throw new Error("hold not entered");
        }),
      ]);
      let settled = false;
      const queued = call("/increment", "POST").then((value) => {
        settled = true;
        return value;
      });
      expect((await call("/increment?id=other", "POST")).value).toBe(1);
      expect(settled).toBe(false);
      release();
      expect((await holding).value).toBe(10);
      expect((await queued).value).toBe(11);
      // Process death/restart at a quiescent point proves durable data, not
      // multi-process exclusion or recovery of an in-flight admission lease.
      child?.kill(9);
      await child?.exited;
      await drain;
      await start();
      expect(await call("/value")).toEqual({ ...first, value: 11 });
      expect((await call("/witness")).starts).toBe(3);
      expect((await call("/value?id=other")).value).toBe(1);
    } finally {
      release();
      control.stop(true);
      child?.kill(9);
      await child?.exited;
      await drain;
      if (diagnostics) console.error(diagnostics);
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
