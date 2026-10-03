import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SELFHOST_WORKER_PRELUDE_MODULE,
  selfhostWorkerPreludeSource,
} from "../src/providers/selfhost-worker-prelude.ts";
import { selfhostWorkerEntrypointSource } from "../src/providers/selfhost-worker-wrapper.ts";
import { createSelfhostActorExecutionHost } from "../src/selfhost-actor-execution-host.ts";
import { WORKERD_CLOSED_GRAPH_ARTIFACT } from "../src/workerd-artifact.ts";
import { createWorkerdRuntime, type WorkerdDeploymentPublication } from "../src/workerd-runtime.ts";
import {
  actorForm,
  fixture,
  insert,
  resource,
  scope,
  workerForm,
} from "./helpers/actor-resource-fixture.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("actor-qualification");
const digest = process.env.TAKOSERVER_ACTOR_QUALIFICATION_SHA256;
const encoder = new TextEncoder();
const request = (path = "/value") =>
  new Request(`http://application.invalid${path}`, {
    method: path === "/increment" ? "POST" : "GET",
  });

async function deployedFixture() {
  const f = fixture();
  await f.deployments.create({
    tenantId: scope.tenantId,
    id: "deployment-worker",
    resourceUid: f.target.metadata.uid,
    offeringId: "worker-local",
    providerPackRef: "selfhost",
    providerInstallationRef: "local.primary",
    nativeId: "selfhost-worker:worker:operation-1",
    state: "active",
    observed: {},
    outputs: { scriptName: "worker" },
  });
  return f;
}

test("Actor owner rejects persisted relation/deployment gaps before native allocation", async () => {
  const f = await deployedFixture();
  const root = await mkdtemp(join(tmpdir(), "actor-owner-deny-"));
  const owner = createSelfhostActorExecutionHost({
    runtimeRoot: root,
    storageRoot: join(root, "state"),
    binary: "/never-execute",
    graph: f.read,
    deployments: f.deployments,
    providerPackRef: "selfhost",
    providerInstallationRef: "wrong-installation",
  });
  try {
    await owner.ready;
    await owner.registerNamespace(scope);
    await owner.registerNamespace({ ...scope, tenantId: "other" });
    expect(await owner.readCurrentGraph(scope, AbortSignal.timeout(1_000))).toBeNull();
    await expect(owner.fetch({ ...scope, id: "a" }, request())).rejects.toThrow(
      "realization unavailable",
    );
    await expect(owner.fetch({ ...scope, tenantId: "other", id: "a" }, request())).rejects.toThrow(
      "Resource unavailable",
    );
    expect(await stat(join(root, "state", "namespaces")).catch(() => null)).toBeNull();
  } finally {
    await owner.close();
    f.database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Actor cold restore fails closed on corrupt registration metadata", async () => {
  const f = await deployedFixture();
  const root = await mkdtemp(join(tmpdir(), "actor-owner-corrupt-registration-"));
  const storageRoot = join(root, "state");
  const registrations = join(storageRoot, "registrations");
  const key = createHash("sha256")
    .update(JSON.stringify([scope.tenantId, scope.namespaceResourceUid]))
    .digest("hex");
  await mkdir(registrations, { recursive: true });
  await writeFile(
    join(registrations, `${key}.json`),
    JSON.stringify({ tenantId: scope.tenantId, namespaceResourceUid: scope.namespaceResourceUid }),
  );
  await writeFile(join(registrations, `${"f".repeat(64)}.json`), "{}");
  const owner = createSelfhostActorExecutionHost({
    runtimeRoot: root,
    storageRoot,
    binary: "/never-execute",
    graph: f.read,
    deployments: f.deployments,
    providerPackRef: "selfhost",
    providerInstallationRef: "local.primary",
  });
  try {
    await expect(owner.ready).rejects.toThrow("registration invalid");
    await expect(owner.fetch({ ...scope, id: "a" }, request())).rejects.toThrow(
      "registration invalid",
    );
    expect(await stat(join(storageRoot, "namespaces")).catch(() => null)).toBeNull();
  } finally {
    await owner.close();
    f.database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(binary === undefined)(
  "real self-host Actor owner recovers child exits without losing UID-private SQL or lease fences",
  async () => {
    if (!binary || !digest || !/^[a-f0-9]{64}$/u.test(digest))
      throw new Error("candidate SHA required");
    expect(
      createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
    ).toBe(digest);
    expect(WORKERD_CLOSED_GRAPH_ARTIFACT.sha256).toBe(
      "c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52",
    );
    const root = await mkdtemp(join(tmpdir(), "actor-owner-native-"));
    const childPidFile = join(root, "actor-child.pid");
    const childConfigFile = join(root, "actor-child.config");
    const childWrapper = join(root, "actor-child");
    const badNamespaceUid = "namespace-bad";
    const badKey = createHash("sha256")
      .update(JSON.stringify([scope.tenantId, badNamespaceUid]))
      .digest("hex");
    await writeFile(
      childWrapper,
      `#!/bin/sh\nif /usr/bin/grep -q '${badKey}' "$2"; then exit 65; fi\nprintf '%s\\n' "$$" >> '${childPidFile}'\nprintf '%s\\n' "$2" >> '${childConfigFile}'\nexec '${binary}' "$@"\n`,
      { mode: 0o700 },
    );
    const f = await deployedFixture();
    insert(f.database, resource(actorForm, "counter-bad", badNamespaceUid), [f.relation]);
    const selectorNamespaceUid = "namespace-selector-bad";
    const selectorWorker = resource(workerForm, "worker-selector-bad", "worker-selector-bad-uid");
    insert(f.database, selectorWorker, []);
    insert(
      f.database,
      {
        ...resource(actorForm, "counter-selector-bad", selectorNamespaceUid),
        spec: {
          className: "Counter",
          worker: {
            apiVersion: selectorWorker.apiVersion,
            kind: "ModuleWorker",
            name: selectorWorker.metadata.name,
          },
        },
      },
      [
        {
          ...f.relation,
          targetName: selectorWorker.metadata.name,
          targetUid: selectorWorker.metadata.uid,
        },
      ],
    );
    await f.deployments.create({
      tenantId: scope.tenantId,
      id: "deployment-selector-bad",
      resourceUid: selectorWorker.metadata.uid,
      offeringId: "worker-local",
      providerPackRef: "selfhost",
      providerInstallationRef: "local.primary",
      nativeId: "selfhost-worker:selector-worker:operation-1",
      state: "active",
      observed: {},
      outputs: { scriptName: "selector-worker" },
    });
    expect(
      await f.read(
        { tenantId: scope.tenantId, namespaceResourceUid: selectorNamespaceUid },
        new AbortController().signal,
      ),
    ).not.toBeNull();
    const runtimeRoot = join(root, "runtime");
    const storageRoot = join(root, "state");
    const runtime = createWorkerdRuntime({ root: runtimeRoot, isReady: () => true });
    const source = await readFile(join(import.meta.dir, "fixtures/actor-host/counter.mjs"), "utf8");
    const main = `import { Counter as Base } from './counter.mjs';
// Hostile application top-level runs before every handler. If the Host uses
// mutable request/header globals for its private alarm port, redirect A to B
// and observe the capability bearer. The real Host must capture first.
const NativeHeaders = globalThis.Headers;
const NativeRequest = globalThis.Request;
const nativeGet = NativeHeaders.prototype.get;
const nativeSet = NativeHeaders.prototype.set;
NativeHeaders.prototype.get = function(name) {
  const value = nativeGet.call(this, name);
  if (name === 'x-takoserver-private-actor-token' && /^[a-f0-9]{64}$/.test(value ?? '')) globalThis.__alarmTokenObserved = true;
  return value;
};
NativeHeaders.prototype.set = function(name, value) {
  return nativeSet.call(this, name, name === 'x-takoserver-private-actor-id' ? encodeURIComponent('b') : value);
};
globalThis.Headers = class extends NativeHeaders {
  constructor(init) {
    super(init);
    const token = nativeGet.call(this, 'x-takoserver-private-actor-token');
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      globalThis.__alarmTokenObserved = true;
      nativeSet.call(this, 'x-takoserver-private-actor-id', encodeURIComponent('b'));
    }
  }
};
globalThis.Request = class extends NativeRequest {
  constructor(input, init) {
    const token = init?.headers && nativeGet.call(init.headers, 'x-takoserver-private-actor-token');
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      globalThis.__alarmTokenObserved = true;
      nativeSet.call(init.headers, 'x-takoserver-private-actor-id', encodeURIComponent('b'));
    }
    super(input, init);
  }
};
export class Counter extends Base {
 async fetch(request) {
   const url = new URL(request.url);
   if (url.pathname === '/alarm-set') {
     await this.context.alarm.set(Date.now() + Number(url.searchParams.get('delay') ?? '50'));
     return Response.json({ pending: await this.context.alarm.get() });
   }
   if (url.pathname === '/alarm-invalid') {
     const failures = [];
     for (const at of [NaN, 1e20, -1, 1.5]) {
       try { await this.context.alarm.set(at); failures.push('accepted'); }
       catch (error) { failures.push(error.name); }
     }
     return Response.json({ failures, pending:await this.context.alarm.get() });
   }
   if (url.pathname === '/alarm-private') {
     const schema = await this.context.storage.query("SELECT name FROM sqlite_schema WHERE name = 'actor_alarm_state'");
     let builtin = 'blocked';
     try { await import('cloudflare:workers'); builtin = 'allowed'; } catch {}
     let hostModule = 'blocked';
     try { await import('./__actor_entry.js'); hostModule = 'allowed'; } catch {}
     return Response.json({ visible:schema.rows.length, builtin, hostModule, tokenObserved:globalThis.__alarmTokenObserved === true });
   }
   if (url.pathname === '/alarm-status') {
     const runs = await this.context.storage.query("SELECT count(*) AS n FROM alarm_runs").catch(() => ({ rows:[{ n:0 }] }));
     return Response.json({ runs:runs.rows[0].n, pending:await this.context.alarm.get() });
   }
   if (url.pathname === '/alarm-clear') {
     await this.context.alarm.clear();
     return Response.json({ pending:await this.context.alarm.get() });
   }
   if (new URL(request.url).pathname === '/stream') {
     return new Response(new ReadableStream({ start(controller) {
       controller.enqueue(new TextEncoder().encode('head'));
       setTimeout(() => { controller.enqueue(new TextEncoder().encode('tail')); controller.close(); }, 250);
     } }));
   }
   if (new URL(request.url).pathname === '/env') return Response.json({ keys:Object.keys(this.env), id:this.context.id });
   if (new URL(request.url).pathname === '/echo') return Response.json({ body:await request.text(), privateHeaders:[...request.headers.keys()].filter(key=>key.startsWith('x-takoserver-private-actor-')) });
   if (new URL(request.url).pathname === '/redirect') return new Response(null, { status:302, headers:{ Location:'/value' } });
   return super.fetch(request);
 }
 async alarm() {
   if (this.context.id === 'held-alarm-b') {
     await this.context.storage.execute("CREATE TABLE IF NOT EXISTS alarm_hold (phase TEXT)");
     await this.context.storage.execute("INSERT INTO alarm_hold VALUES ('start')");
     await new Promise(resolve => setTimeout(resolve, 2000));
     await this.context.storage.execute("INSERT INTO alarm_hold VALUES ('finish')");
   }
   await this.context.storage.execute("CREATE TABLE IF NOT EXISTS alarm_runs (n INTEGER)");
   await this.context.storage.execute("INSERT INTO alarm_runs VALUES (1)");
   await this.context.storage.execute("CREATE TABLE IF NOT EXISTS alarm_versions (version TEXT)");
   await this.context.storage.execute("INSERT INTO alarm_versions VALUES (?)", [this.env.VERSION]);
   const runs = await this.context.storage.query("SELECT count(*) AS n FROM alarm_runs");
   if (runs.rows[0].n === 1) {
     if (this.context.id.endsWith('b')) await this.context.alarm.clear();
     else await this.context.alarm.set(Date.now() + 10000);
     throw new Error('retry first alarm without consuming successor');
   }
 }
}`;
    const publication = (
      generation: string,
      workerResourceUid = f.target.metadata.uid,
      script = "worker",
    ): WorkerdDeploymentPublication => ({
      generation,
      workerResourceUid,
      hostnames: [],
      versions: ["a", "b"].map((version) => ({
        versionId: `version-${version}`,
        workerVersionUid: `version-uid-${version}`,
        weight: version === "a" ? 1 : 9999,
        site: {
          directory: script,
          mainModule: "main.mjs",
          hostEntrypoint: "__host.mjs",
          hostModules: [SELFHOST_WORKER_PRELUDE_MODULE],
          hostnames: [],
          generation,
          workerResourceUid,
          fetchHandler: true,
          modules: ["counter.mjs"],
          vars: [
            {
              name: "VERSION",
              value: generation === "generation-2" && version === "b" ? "b2" : version,
              kind: "text",
            },
            { name: "PRIVATE", value: "not-declared", kind: "text" },
          ],
        },
        modules: new Map([
          ["main.mjs", encoder.encode(main)],
          ["counter.mjs", encoder.encode(source)],
        ]),
        hostModules: new Map([
          [SELFHOST_WORKER_PRELUDE_MODULE, encoder.encode(selfhostWorkerPreludeSource())],
          [
            "__host.mjs",
            encoder.encode(
              selfhostWorkerEntrypointSource({
                originalMainModule: "main.mjs",
                declaredHandlers: ["fetch"],
                bindings: [{ name: "VERSION", type: "plain_text" }],
                publication: generation,
                probeHostname: "probe.invalid",
              }),
            ),
          ],
        ]),
      })),
    });
    let basisPoint = 0;
    let afterGraphRead: ((readScope: typeof scope) => void | Promise<void>) | undefined;
    const makeOwner = () =>
      createSelfhostActorExecutionHost({
        runtimeRoot,
        storageRoot,
        binary: childWrapper,
        graph: async (scope, signal) => {
          const graph = await f.read(scope, signal);
          await afterGraphRead?.(scope);
          return graph;
        },
        deployments: f.deployments,
        providerPackRef: "selfhost",
        providerInstallationRef: "local.primary",
        basisPoint: () => basisPoint,
      });
    const crashChild = async (): Promise<string> => {
      const childPid = Number((await readFile(childPidFile, "utf8")).trim().split("\n").at(-1));
      const deadConfig = (await readFile(childConfigFile, "utf8")).trim().split("\n").at(-1);
      expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
      expect(deadConfig).toBeDefined();
      process.kill(childPid, "SIGKILL");
      let childGone = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          process.kill(childPid, 0);
        } catch {
          childGone = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(childGone).toBe(true);
      return deadConfig ?? "";
    };
    const durableAlarmRuns = async (expectedIds: number | null = 2): Promise<number> => {
      const namespaceRoot = join(storageRoot, "namespaces");
      const counts: number[] = [];
      for await (const relative of new Bun.Glob("**/*.sqlite").scan(namespaceRoot)) {
        const database = new Database(join(namespaceRoot, relative), { readonly: true });
        try {
          const row = database.query("SELECT count(*) AS n FROM alarm_runs").get() as {
            n: number;
          } | null;
          if (row) counts.push(row.n);
        } catch (error) {
          // Other Actor IDs and Host-private owner stores have no fixture table.
          if (!String(error).includes("no such table: alarm_runs")) throw error;
        } finally {
          database.close();
        }
      }
      if (expectedIds !== null) expect(counts).toHaveLength(expectedIds);
      return counts.reduce((total, count) => total + count, 0);
    };
    const durableAlarmObligations = async (): Promise<number> => {
      let obligations = 0;
      for await (const relative of new Bun.Glob("**/*.sqlite").scan(
        join(storageRoot, "namespaces"),
      )) {
        const database = new Database(join(storageRoot, "namespaces", relative), {
          readonly: true,
        });
        try {
          const row = database.query("SELECT obligation FROM actor_alarm_state").get() as {
            obligation: number;
          } | null;
          obligations += row?.obligation ?? 0;
        } catch (error) {
          if (!String(error).includes("no such table: actor_alarm_state")) throw error;
        } finally {
          database.close();
        }
      }
      return obligations;
    };
    let owner = makeOwner();
    const identity = { ...scope, id: "カウンター/a" };
    try {
      await runtime.publish?.("worker", publication("generation-1"));
      await runtime.publish?.(
        "selector-worker",
        publication("generation-selector", selectorWorker.metadata.uid, "selector-worker"),
      );
      await owner.registerNamespace(scope);
      const initial = await (await owner.fetch(identity, request("/increment"))).json();
      expect(initial).toEqual({ id: identity.id, value: 1, version: "a" });
      expect(await (await owner.fetch(identity, request("/env"))).json()).toEqual({
        keys: ["VERSION"],
        id: identity.id,
      });
      expect(
        await (
          await owner.fetch(
            identity,
            new Request("http://application.invalid/echo", {
              method: "POST",
              body: "payload",
              headers: { "x-takoserver-private-actor-token": "attacker-value" },
            }),
          )
        ).json(),
      ).toEqual({ body: "payload", privateHeaders: [] });
      const redirect = await owner.fetch(identity, request("/redirect"));
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe("/value");
      await redirect.body?.cancel();
      expect((await (await owner.fetch({ ...identity, id: "b" }, request())).json()).value).toBe(0);
      expect(await (await owner.fetch(identity, request("/alarm-invalid"))).json()).toEqual({
        failures: ["TypeError", "TypeError", "TypeError", "TypeError"],
        pending: null,
      });
      expect(await (await owner.fetch(identity, request("/alarm-private"))).json()).toEqual({
        visible: 0,
        builtin: "blocked",
        hostModule: "blocked",
        tokenObserved: false,
      });
      const alarmSet = (await (await owner.fetch(identity, request("/alarm-set"))).json()) as {
        pending: number;
      };
      expect(Number.isSafeInteger(alarmSet.pending)).toBe(true);
      expect(
        (await (await owner.fetch({ ...identity, id: "b" }, request("/alarm-status"))).json())
          .pending,
      ).toBeNull();
      expect(
        (await (await owner.fetch(identity, request("/alarm-private"))).json()).tokenObserved,
      ).toBe(false);
      let alarmStatus: { runs: number; pending: number | null } = { runs: 0, pending: null };
      for (let attempt = 0; attempt < 120; attempt += 1) {
        alarmStatus = (await (
          await owner.fetch(identity, request("/alarm-status"))
        ).json()) as typeof alarmStatus;
        if (alarmStatus.runs >= 2) break;
        await Bun.sleep(50);
      }
      expect(alarmStatus.runs).toBe(2);
      expect(alarmStatus.pending).toBeGreaterThan(Date.now());
      expect(await (await owner.fetch(identity, request("/alarm-clear"))).json()).toEqual({
        pending: null,
      });
      expect(
        (await (await owner.fetch({ ...identity, id: "b" }, request("/alarm-status"))).json()).runs,
      ).toBe(0);
      await (await owner.fetch({ ...identity, id: "b" }, request("/alarm-set"))).json();
      let clearedRuns = 0;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const status = (await (
          await owner.fetch({ ...identity, id: "b" }, request("/alarm-status"))
        ).json()) as { runs: number; pending: number | null };
        clearedRuns = status.runs;
        if (clearedRuns >= 2) {
          expect(status.pending).toBeNull();
          break;
        }
        await Bun.sleep(50);
      }
      expect(clearedRuns).toBe(2);
      const stream = await owner.fetch(identity, request("/stream"));
      const reader = stream.body?.getReader();
      expect(reader).toBeDefined();
      expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("head");
      let secondReturned = false;
      const second = owner.fetch(identity, request("/increment")).then(async (response) => {
        secondReturned = true;
        return response.json();
      });
      await Bun.sleep(30);
      expect(secondReturned).toBe(false);
      // A different ID is not serialized behind this ID's streaming response.
      expect(
        (await (await owner.fetch({ ...identity, id: "b" }, request("/increment"))).json()).value,
      ).toBe(1);
      expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("tail");
      expect((await reader?.read())?.done).toBe(true);
      expect((await second).value).toBe(2);
      // A second Host cannot open the same namespace against retained SQL.
      const competing = makeOwner();
      try {
        await expect(competing.fetch(identity, request())).rejects.toThrow();
      } finally {
        await competing.close();
      }
      const startsBeforeWeightChange = (await readFile(childPidFile, "utf8"))
        .trim()
        .split("\n").length;
      basisPoint = 9999;
      expect(await (await owner.fetch(identity, request())).json()).toEqual({
        id: identity.id,
        value: 2,
        version: "b",
      });
      // A fresh weighted event may select B without replacing a native owner
      // that already has both classes and the same durable SQL path.
      expect((await readFile(childPidFile, "utf8")).trim().split("\n")).toHaveLength(
        startsBeforeWeightChange,
      );
      await owner.close();
      owner = makeOwner();
      expect((await (await owner.fetch(identity, request())).json()).value).toBe(2);
      const badIdentity = { ...identity, namespaceResourceUid: badNamespaceUid };
      await owner.registerNamespace(badIdentity);
      await expect(owner.fetch(badIdentity, request())).rejects.toThrow(
        "native child exited during startup",
      );
      const selectorBadIdentity = { ...identity, namespaceResourceUid: selectorNamespaceUid };
      await owner.registerNamespace(selectorBadIdentity);
      expect((await (await owner.fetch(selectorBadIdentity, request())).json()).value).toBe(0);
      await writeFile(join(runtimeRoot, "workers", "selector-worker", "takoserver-site.json"), "{");
      const pendingBeforeRestart = (await (
        await owner.fetch(identity, request("/alarm-set?delay=3000"))
      ).json()) as { pending: number };
      expect(pendingBeforeRestart.pending).toBeGreaterThan(Date.now());
      await owner.close();
      const startsBeforeColdRestart = (await readFile(childPidFile, "utf8"))
        .trim()
        .split("\n").length;
      owner = makeOwner();
      // No HTTP call may be needed to reconstruct the native owner and wake
      // this persisted alarm. Only direct SQLite reads observe the wake.
      const failedColdStarts = [
        {
          tenantId: scope.tenantId,
          namespaceResourceUid: badNamespaceUid,
          reason: "native_start_unavailable",
          attempts: 3,
        },
        {
          tenantId: scope.tenantId,
          namespaceResourceUid: selectorNamespaceUid,
          reason: "version_snapshot_unavailable",
          attempts: 3,
        },
      ] as const;
      expect(await owner.ready).toEqual(expect.arrayContaining(failedColdStarts));
      expect(owner.coldStartFailures()).toEqual(expect.arrayContaining(failedColdStarts));
      expect(owner.coldStartFailures()).toHaveLength(2);
      let coldStarts = startsBeforeColdRestart;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        coldStarts = (await readFile(childPidFile, "utf8")).trim().split("\n").length;
        if (coldStarts > startsBeforeColdRestart) break;
        await Bun.sleep(20);
      }
      expect(coldStarts).toBe(startsBeforeColdRestart + 1);
      let restoredRuns = await durableAlarmRuns();
      for (let attempt = 0; attempt < 160 && restoredRuns < 5; attempt += 1) {
        await Bun.sleep(50);
        restoredRuns = await durableAlarmRuns();
      }
      expect(restoredRuns).toBe(5);
      expect((await (await owner.fetch(identity, request())).json()).value).toBe(2);
      await expect(owner.fetch(badIdentity, request())).rejects.toThrow(
        "native child exited during startup",
      );
      await expect(owner.fetch(selectorBadIdentity, request())).rejects.toThrow(
        "unusable worker active Actor graph",
      );
      f.database
        .query(
          "UPDATE tf_resource_deletion_attestations SET state = 'pending' WHERE resource_uid = ?",
        )
        .run(badNamespaceUid);
      f.database
        .query(
          "UPDATE tf_resource_deletion_attestations SET state = 'pending' WHERE resource_uid = ?",
        )
        .run(selectorNamespaceUid);
      expect(
        (await (await owner.fetch(identity, request("/alarm-status"))).json()).pending,
      ).toBeNull();
      const coldCrashAlarm = (await (
        await owner.fetch(identity, request("/alarm-set?delay=3000"))
      ).json()) as { pending: number };
      const startsBeforeColdCrash = (await readFile(childPidFile, "utf8"))
        .trim()
        .split("\n").length;
      await crashChild();
      let startsAfterColdCrash = startsBeforeColdCrash;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        startsAfterColdCrash = (await readFile(childPidFile, "utf8")).trim().split("\n").length;
        if (startsAfterColdCrash > startsBeforeColdCrash) break;
        await Bun.sleep(20);
      }
      expect(startsAfterColdCrash).toBe(startsBeforeColdCrash + 1);
      expect(coldCrashAlarm.pending).toBeGreaterThan(Date.now());
      let recoveredColdRuns = await durableAlarmRuns();
      for (let attempt = 0; attempt < 160 && recoveredColdRuns < 6; attempt += 1) {
        await Bun.sleep(50);
        recoveredColdRuns = await durableAlarmRuns();
      }
      expect(recoveredColdRuns).toBe(6);
      const idleConfig = await crashChild();
      expect((await (await owner.fetch(identity, request("/increment"))).json()).value).toBe(3);
      expect(await stat(dirname(idleConfig)).catch(() => null)).toBeNull();
      const crashedStream = await owner.fetch(identity, request("/stream"));
      const crashedReader = crashedStream.body?.getReader();
      expect(new TextDecoder().decode((await crashedReader?.read())?.value)).toBe("head");
      const activeConfig = await crashChild();
      // The old response is not replayed or drained on the caller's behalf.
      // A new request must reopen against the same UID-private SQL authority.
      const recovered = await Promise.all([
        owner.fetch(identity, request("/increment")).then((response) => response.json()),
        owner.fetch(identity, request("/increment")).then((response) => response.json()),
      ]);
      expect(recovered.map((result) => result.value).sort()).toEqual([4, 5]);
      expect(await stat(dirname(activeConfig)).catch(() => null)).toBeNull();
      await crashedReader?.cancel().catch(() => {});
      const held = await owner.fetch(identity, request("/stream"));
      const heldReader = held.body?.getReader();
      expect(new TextDecoder().decode((await heldReader?.read())?.value)).toBe("head");
      // A weight-only change does not retire this graph. Publish a distinct
      // generation to exercise deletion while a legitimate rotation drains.
      await runtime.publish?.("worker", publication("generation-1-rotation"));
      basisPoint = 0;
      let remainingGraphReads = 2;
      const selected = new Promise<void>((resolve) => {
        afterGraphRead = () => {
          remainingGraphReads -= 1;
          if (remainingGraphReads === 0) {
            afterGraphRead = undefined;
            resolve();
          }
        };
      });
      const stale = owner.fetch(identity, request("/increment"));
      await selected;
      // The second request selected the new graph but must wait for the old
      // graph's held body. Deletion in that gap must fence the selected bytes.
      await Bun.sleep(10);
      f.database
        .query(
          "UPDATE tf_resource_deletion_attestations SET state = 'pending' WHERE resource_uid = ?",
        )
        .run(scope.namespaceResourceUid);
      expect(new TextDecoder().decode((await heldReader?.read())?.value)).toBe("tail");
      expect((await heldReader?.read())?.done).toBe(true);
      const staleOutcome = await stale.then(
        async (response) => {
          await response.body?.cancel();
          return "incorrectly dispatched";
        },
        (error: unknown) => error,
      );
      expect(staleOutcome).toBeInstanceOf(Error);
      expect(String(staleOutcome)).toContain("changed during selection");
      // Deletion immediately denies the old UID; a same-name replacement starts
      // a distinct durable namespace rather than adopting the predecessor SQL.
      await expect(owner.fetch(identity, request())).rejects.toThrow("Resource unavailable");
      f.database.query("DELETE FROM tf_resources WHERE uid = ?").run(scope.namespaceResourceUid);
      const replacement = resource(actorForm, "counter", "namespace-replacement");
      insert(f.database, replacement, [f.relation]);
      await owner.registerNamespace({
        ...identity,
        namespaceResourceUid: replacement.metadata.uid,
      });
      expect(
        (
          await (
            await owner.fetch(
              { ...identity, namespaceResourceUid: replacement.metadata.uid },
              request(),
            )
          ).json()
        ).value,
      ).toBe(0);
      const closingStream = await owner.fetch(
        { ...identity, namespaceResourceUid: replacement.metadata.uid },
        request("/stream"),
      );
      const closingReader = closingStream.body?.getReader();
      expect(new TextDecoder().decode((await closingReader?.read())?.value)).toBe("head");
      const closingConfig = await crashChild();
      await owner.close();
      expect(await stat(dirname(closingConfig)).catch(() => null)).toBeNull();
      await closingReader?.cancel().catch(() => {});
      owner = makeOwner();
      await owner.ready;
      await expect(owner.fetch(identity, request())).rejects.toThrow("Resource unavailable");
      expect(
        (
          await (
            await owner.fetch(
              { ...identity, namespaceResourceUid: replacement.metadata.uid },
              request(),
            )
          ).json()
        ).value,
      ).toBe(0);
      const replacementIdentity = {
        ...identity,
        id: "b",
        namespaceResourceUid: replacement.metadata.uid,
      };
      await (await owner.fetch(replacementIdentity, request("/alarm-set?delay=1000"))).json();
      await owner.close();
      let replacementReads = 0;
      let releaseFinalGraph!: () => void;
      const heldFinalGraph = new Promise<void>((resolve) => {
        releaseFinalGraph = resolve;
      });
      let reachedFinalGraph!: () => void;
      const finalGraphReached = new Promise<void>((resolve) => {
        reachedFinalGraph = resolve;
      });
      afterGraphRead = async (readScope) => {
        if (readScope.namespaceResourceUid !== replacement.metadata.uid) return;
        replacementReads += 1;
        if (replacementReads === 3) {
          afterGraphRead = undefined;
          reachedFinalGraph();
          await heldFinalGraph;
        }
      };
      owner = makeOwner();
      try {
        await finalGraphReached;
        // Native startup has loaded the retained due alarm, but final Host
        // verification is still held: no tenant callback may begin yet.
        await Bun.sleep(1_200);
        expect(await durableAlarmRuns(2)).toBe(6);
        expect(await durableAlarmObligations()).toBeGreaterThan(0);
      } finally {
        releaseFinalGraph();
      }
      await owner.ready;
      let startupRuns = 6;
      for (let attempt = 0; attempt < 100 && startupRuns < 8; attempt += 1) {
        await Bun.sleep(50);
        startupRuns = await durableAlarmRuns(null);
      }
      expect(startupRuns).toBe(8);
      const selectedPointer = join(runtimeRoot, "workers", "worker", "takoserver-site.json");
      const selectedBytes = await readFile(selectedPointer);
      await (await owner.fetch(replacementIdentity, request("/alarm-set?delay=700"))).json();
      await writeFile(selectedPointer, "{");
      await Bun.sleep(1_300);
      expect(await durableAlarmRuns(3)).toBe(8);
      expect(await durableAlarmObligations()).toBeGreaterThan(0);
      await writeFile(selectedPointer, selectedBytes);
      let repairedRuns = 8;
      for (let attempt = 0; attempt < 100 && repairedRuns < 9; attempt += 1) {
        await Bun.sleep(50);
        repairedRuns = await durableAlarmRuns(null);
      }
      expect(repairedRuns).toBe(9);
      await (await owner.fetch(replacementIdentity, request("/alarm-set?delay=700"))).json();
      f.database
        .query(
          "UPDATE tf_resource_deletion_attestations SET state = 'pending' WHERE resource_uid = ?",
        )
        .run(replacement.metadata.uid);
      await Bun.sleep(1_300);
      expect(await durableAlarmRuns(3)).toBe(9);
      expect(await durableAlarmObligations()).toBeGreaterThan(0);
      await owner.close();
      owner = makeOwner();
      expect(await owner.ready).toEqual(
        expect.arrayContaining([
          {
            tenantId: scope.tenantId,
            namespaceResourceUid: replacement.metadata.uid,
            reason: "authority_unavailable",
            attempts: 1,
          },
        ]),
      );
      await Bun.sleep(1_300);
      expect(await durableAlarmRuns(3)).toBe(9);
      expect(await durableAlarmObligations()).toBeGreaterThan(0);

      // A retained alarm, with no subsequent HTTP call, must cause the
      // namespace owner to rotate to the newly active graph. Each retry then
      // samples the current weights afresh rather than inheriting startup A.
      const updateUid = "namespace-autonomous-version-update";
      const updateResource = resource(actorForm, "counter-autonomous-version-update", updateUid);
      insert(f.database, updateResource, [f.relation]);
      const updateIdentity = { ...identity, id: "updated-b", namespaceResourceUid: updateUid };
      await owner.registerNamespace(updateIdentity);
      basisPoint = 0;
      await (await owner.fetch(updateIdentity, request("/alarm-set?delay=2000"))).json();
      const startsBeforeAutonomousUpdate = (await readFile(childPidFile, "utf8"))
        .trim()
        .split("\n").length;
      await runtime.publish?.("worker", publication("generation-2"));
      basisPoint = 9999;
      const updateKey = createHash("sha256")
        .update(JSON.stringify([scope.tenantId, updateUid]))
        .digest("hex");
      const readUpdateVersions = async (): Promise<string[]> => {
        const versions: string[] = [];
        for await (const relative of new Bun.Glob("**/*.sqlite").scan(
          join(storageRoot, "namespaces", updateKey),
        )) {
          const database = new Database(join(storageRoot, "namespaces", updateKey, relative), {
            readonly: true,
          });
          try {
            const rows = database
              .query("SELECT version FROM alarm_versions ORDER BY rowid")
              .all() as {
              version: string;
            }[];
            versions.push(...rows.map((row) => row.version));
          } catch (error) {
            if (!String(error).includes("no such table: alarm_versions")) throw error;
          } finally {
            database.close();
          }
        }
        return versions;
      };
      let updatedVersions: string[] = [];
      for (let attempt = 0; attempt < 200; attempt += 1) {
        updatedVersions = await readUpdateVersions();
        if (updatedVersions.includes("b2")) break;
        await Bun.sleep(25);
      }
      expect(updatedVersions).toEqual(["b2"]);
      basisPoint = 0;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        updatedVersions = await readUpdateVersions();
        if (updatedVersions.length >= 2) break;
        await Bun.sleep(25);
      }
      expect(updatedVersions).toEqual(["b2", "a"]);
      expect((await readFile(childPidFile, "utf8")).trim().split("\n").length).toBeGreaterThan(
        startsBeforeAutonomousUpdate,
      );

      // A valid Resource revision replacement also rotates from its retained
      // alarm wake without a new HTTP request. Pending deletion above remains
      // a denial, not a replacement.
      const versionsBeforeResourceChange = updatedVersions.length;
      const startsBeforeResourceChange = (await readFile(childPidFile, "utf8"))
        .trim()
        .split("\n").length;
      basisPoint = 9999;
      await (
        await owner.fetch(
          { ...updateIdentity, id: "resource-refresh-b" },
          request("/alarm-set?delay=700"),
        )
      ).json();
      const revisedResource = {
        ...updateResource,
        metadata: { ...updateResource.metadata, revision: "8" },
      };
      f.database
        .query("UPDATE tf_resources SET revision = ?, resource_json = ? WHERE uid = ?")
        .run("8", JSON.stringify(revisedResource), updateUid);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        updatedVersions = await readUpdateVersions();
        if (updatedVersions.length > versionsBeforeResourceChange) break;
        await Bun.sleep(25);
      }
      expect(updatedVersions.length).toBeGreaterThan(versionsBeforeResourceChange);
      expect((await readFile(childPidFile, "utf8")).trim().split("\n").length).toBeGreaterThan(
        startsBeforeResourceChange,
      );

      const versionsBeforeDeploymentChange = updatedVersions.length;
      const startsBeforeDeploymentChange = (await readFile(childPidFile, "utf8"))
        .trim()
        .split("\n").length;
      await (
        await owner.fetch(
          { ...updateIdentity, id: "deployment-refresh-b" },
          request("/alarm-set?delay=700"),
        )
      ).json();
      f.database
        .query("UPDATE tf_resource_deployments SET native_id = ? WHERE id = ?")
        .run("selfhost-worker:worker:operation-2", "deployment-worker");
      for (let attempt = 0; attempt < 200; attempt += 1) {
        updatedVersions = await readUpdateVersions();
        if (updatedVersions.length > versionsBeforeDeploymentChange) break;
        await Bun.sleep(25);
      }
      expect(updatedVersions.length).toBeGreaterThan(versionsBeforeDeploymentChange);
      expect((await readFile(childPidFile, "utf8")).trim().split("\n").length).toBeGreaterThan(
        startsBeforeDeploymentChange,
      );

      // Rotation is namespace-wide, so an alarm admitted for another ID is
      // part of the drain even if no HTTP response is active in that ID.
      const readHeldPhases = async (): Promise<string[]> => {
        const phases: string[] = [];
        for await (const relative of new Bun.Glob("**/*.sqlite").scan(
          join(storageRoot, "namespaces", updateKey),
        )) {
          const database = new Database(join(storageRoot, "namespaces", updateKey, relative), {
            readonly: true,
          });
          try {
            const rows = database.query("SELECT phase FROM alarm_hold ORDER BY rowid").all() as {
              phase: string;
            }[];
            phases.push(...rows.map((row) => row.phase));
          } catch (error) {
            if (!String(error).includes("no such table: alarm_hold")) throw error;
          } finally {
            database.close();
          }
        }
        return phases;
      };
      await (
        await owner.fetch({ ...updateIdentity, id: "held-alarm-b" }, request("/alarm-set?delay=50"))
      ).json();
      let heldPhases: string[] = [];
      for (let attempt = 0; attempt < 100; attempt += 1) {
        heldPhases = await readHeldPhases();
        if (heldPhases.includes("start")) break;
        await Bun.sleep(10);
      }
      expect(heldPhases).toEqual(["start"]);
      const heldProcessPid = Number(
        (await readFile(childPidFile, "utf8")).trim().split("\n").at(-1),
      );
      await runtime.publish?.("worker", publication("generation-3"));
      let rotationDone = false;
      const rotation = owner
        .fetch({ ...updateIdentity, id: "rotation-c" }, request())
        .then(async (response) => {
          rotationDone = true;
          return response.json();
        });
      await Bun.sleep(100);
      expect(rotationDone).toBe(false);
      expect(() => process.kill(heldProcessPid, 0)).not.toThrow();
      await rotation;
      expect(await readHeldPhases()).toContain("finish");
    } finally {
      await owner.close();
      f.database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  45_000,
);
