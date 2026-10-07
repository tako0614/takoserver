import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalJson } from "../src/json.ts";
import {
  SELFHOST_WORKER_PRELUDE_MODULE,
  selfhostWorkerPreludeSource,
} from "../src/providers/selfhost-worker-prelude.ts";
import { selfhostWorkerEntrypointSource } from "../src/providers/selfhost-worker-wrapper.ts";
import { createSelfhostActorExecutionHost } from "../src/selfhost-actor-execution-host.ts";
import { createLegacyActorGraphAuthority } from "../src/selfhost-actor-graph-authority.ts";
import { openWorkerdActorNamespace } from "../src/selfhost-actor-native-process.ts";
import { WORKERD_CLOSED_GRAPH_ARTIFACT } from "../src/workerd-artifact.ts";
import {
  createWorkerdRuntime,
  type WorkerdActiveActorGraph,
  type WorkerdDeploymentPublication,
} from "../src/workerd-runtime.ts";
import { fixture, scope } from "./helpers/actor-resource-fixture.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("actor-qualification");
const digest = process.env.TAKOSERVER_ACTOR_QUALIFICATION_SHA256;
const encoder = new TextEncoder();

test.skipIf(binary === undefined)(
  "real native Actor namespace observes distinct live contexts and retained alarm state under one epoch",
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
    const root = await mkdtemp(join(tmpdir(), "actor-native-observe-"));
    const f = fixture();
    const runtimeRoot = join(root, "runtime");
    const storageRoot = join(root, "state");
    const childPidFile = join(root, "child.pid");
    const childConfigFile = join(root, "child-config");
    const denySpawnFile = join(root, "deny-spawn");
    const childWrapper = join(root, "child-wrapper");
    await writeFile(
      childWrapper,
      `#!/bin/sh\nif test -e '${denySpawnFile}'; then exit 65; fi\nprintf '%s\\n' "$$" > '${childPidFile}'\nprintf '%s\\n' "$2" > '${childConfigFile}'\nexec '${binary}' "$@"\n`,
      { mode: 0o700 },
    );
    const runtime = createWorkerdRuntime({ root: runtimeRoot, isReady: () => true });
    const source = await readFile(join(import.meta.dir, "fixtures/actor-host/counter.mjs"), "utf8");
    const main = `import { Counter as Base } from './counter.mjs';
export class Counter extends Base {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/alarm-set') {
      await this.context.alarm.set(Date.now() + 60000);
      return Response.json({ pending: await this.context.alarm.get() });
    }
    if (path === '/stream') return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('head'));
      setTimeout(() => controller.close(), 2000);
    } }));
    return super.fetch(request);
  }
}`;
    const publication: WorkerdDeploymentPublication = {
      generation: "observation-one",
      workerResourceUid: f.target.metadata.uid,
      hostnames: [],
      versions: [
        {
          versionId: "native-version-one",
          workerVersionUid: "version-uid-one",
          weight: 10_000,
          site: {
            directory: "worker",
            mainModule: "main.mjs",
            hostEntrypoint: "__host.mjs",
            hostModules: [SELFHOST_WORKER_PRELUDE_MODULE],
            hostnames: [],
            generation: "observation-one",
            workerResourceUid: f.target.metadata.uid,
            fetchHandler: true,
            modules: ["counter.mjs"],
            vars: [{ name: "VERSION", value: "one", kind: "text" }],
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
                  publication: "observation-one",
                  probeHostname: "probe.invalid",
                }),
              ),
            ],
          ]),
        },
      ],
    };
    const legacyAuthority = createLegacyActorGraphAuthority({
      runtimeRoot,
      graph: f.read,
      deployments: f.deployments,
      providerPackRef: "selfhost",
      providerInstallationRef: "local.primary",
    });
    let ownOperationBusy = false;
    const sourceOperationId = "physical-count-source-operation";
    const incarnationId = "physical-count-incarnation";
    const host = createSelfhostActorExecutionHost({
      runtimeRoot,
      storageRoot,
      binary: childWrapper,
      authority: {
        ...legacyAuthority,
        readGraph: (scope, signal) =>
          ownOperationBusy ? Promise.resolve(null) : legacyAuthority.readGraph(scope, signal),
        async readRealization(graph, signal) {
          const result = await legacyAuthority.readRealization(graph, signal);
          if (result.kind !== "ready") return result;
          return {
            kind: "ready" as const,
            realization: {
              ...result.realization,
              authorityKey: canonicalJson({
                sourceOperationId,
                incarnationId,
                generationKey: result.realization.graph.generationKey,
                versions: result.realization.graph.versions.map(
                  ({ versionId, workerVersionUid, weight }) => ({
                    versionId,
                    workerVersionUid,
                    weight,
                  }),
                ),
              }),
            },
          };
        },
        async stillCurrent(graph, _realization, signal) {
          if (ownOperationBusy) return false;
          const result = await legacyAuthority.readRealization(graph, signal);
          return (
            result.kind === "ready" &&
            (await legacyAuthority.stillCurrent(graph, result.realization, signal))
          );
        },
      },
      basisPoint: () => 0,
    });
    try {
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
      await runtime.publish?.("worker", publication);
      await host.registerNamespace(scope);
      const warmGraph = await legacyAuthority.readGraph(scope, AbortSignal.timeout(5_000));
      if (!warmGraph) throw new Error("accepted Actor graph missing before warm");
      const warmNative = await legacyAuthority.readRealization(
        warmGraph,
        AbortSignal.timeout(5_000),
      );
      if (warmNative.kind !== "ready") throw new Error("native Actor graph missing before warm");
      const warmRealization = {
        ...warmNative.realization,
        authorityKey: canonicalJson({
          sourceOperationId,
          incarnationId,
          generationKey: warmNative.realization.graph.generationKey,
          versions: warmNative.realization.graph.versions.map(
            ({ versionId, workerVersionUid, weight }) => ({ versionId, workerVersionUid, weight }),
          ),
        }),
      };
      const warmExpected = {
        workerUid: warmGraph.workerUid,
        className: warmGraph.className,
        sourceOperationId,
        incarnationId,
        generationKey: warmRealization.graph.generationKey,
        versions: warmRealization.graph.versions.map(({ versionId, workerVersionUid, weight }) => ({
          versionId,
          workerVersionUid,
          weight,
        })),
      };
      ownOperationBusy = true;
      expect(await host.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000))).toEqual({
        kind: "unknown",
      });
      expect(
        await host.warmNamespaceForAcceptedOperation(
          scope,
          {
            graph: warmGraph,
            realization: warmRealization,
            expected: warmExpected,
            stillAuthorized: async () => false,
          },
          AbortSignal.timeout(5_000),
        ),
      ).toEqual({ kind: "unknown" });
      expect(
        await access(childPidFile).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(
        await host.warmNamespaceForAcceptedOperation(
          scope,
          {
            graph: warmGraph,
            realization: warmRealization,
            expected: { ...warmExpected, incarnationId: "foreign-incarnation" },
            stillAuthorized: async () => true,
          },
          AbortSignal.timeout(5_000),
        ),
      ).toEqual({ kind: "unknown" });
      expect(
        await access(childPidFile).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(
        await host.warmNamespaceForAcceptedOperation(
          scope,
          {
            graph: warmGraph,
            realization: warmRealization,
            expected: warmExpected,
            stillAuthorized: async () => {
              // The held lease is revoked after native spawn but before readback.
              return !(await access(childPidFile).then(
                () => true,
                () => false,
              ));
            },
          },
          AbortSignal.timeout(10_000),
        ),
      ).toEqual({ kind: "unknown" });
      const failedWarmPid = Number((await readFile(childPidFile, "utf8")).trim());
      expect(Number.isSafeInteger(failedWarmPid) && failedWarmPid > 0).toBe(true);
      expect(() => process.kill(failedWarmPid, 0)).toThrow();
      expect(await host.hasNamespace(scope)).toBe(true);
      expect(
        await host.observeNamespaceRuntimeForAcceptedOperation(
          scope,
          warmExpected,
          AbortSignal.timeout(5_000),
        ),
      ).toEqual({ kind: "unknown" });
      await unlink(childPidFile);
      const warmed = await host.warmNamespaceForAcceptedOperation(
        scope,
        {
          graph: warmGraph,
          realization: warmRealization,
          expected: warmExpected,
          stillAuthorized: async () => ownOperationBusy,
        },
        AbortSignal.timeout(10_000),
      );
      expect(warmed).toMatchObject({
        kind: "confirmed",
        activeActorCount: 0,
        pendingAlarmCount: 0,
        openSocketCount: 0,
      });
      expect(await host.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000))).toEqual({
        kind: "unknown",
      });
      const warmedPid = Number((await readFile(childPidFile, "utf8")).trim());
      expect(warmedPid).not.toBe(failedWarmPid);
      ownOperationBusy = false;
      expect(() => process.kill(warmedPid, 0)).not.toThrow();
      expect(await host.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000))).toMatchObject({
        kind: "confirmed",
        activeActorCount: 0,
      });
      const identity = { ...scope, id: "actor-one" };
      expect(
        await (await host.fetch(identity, new Request("http://actor.invalid/value"))).json(),
      ).toEqual({
        id: identity.id,
        value: 0,
        version: "one",
      });
      expect(Number((await readFile(childPidFile, "utf8")).trim())).toBe(warmedPid);
      const initial = await host.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000));
      expect(initial).toMatchObject({
        kind: "confirmed",
        activeActorCount: 0,
        pendingAlarmCount: 0,
        openSocketCount: 0,
      });
      const armed = await host.fetch(identity, new Request("http://actor.invalid/alarm-set"));
      expect(((await armed.json()) as { pending: number }).pending).toBeGreaterThan(Date.now());
      const pending = await host.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000));
      expect(pending).toMatchObject({
        kind: "confirmed",
        activeActorCount: 0,
        pendingAlarmCount: 1,
        openSocketCount: 0,
      });
      const stream = await host.fetch(
        { ...scope, id: "actor-two" },
        new Request("http://actor.invalid/stream"),
      );
      expect(Number((await readFile(childPidFile, "utf8")).trim())).toBe(warmedPid);
      const reader = stream.body?.getReader();
      expect(await reader?.read()).toMatchObject({ done: false });
      const active = await host.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000));
      expect(active).toMatchObject({
        kind: "confirmed",
        activeActorCount: 1,
        pendingAlarmCount: 1,
        openSocketCount: 0,
      });
      await reader?.cancel();
      let settled = await host.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000));
      for (
        let attempt = 0;
        attempt < 100 && (settled.kind !== "confirmed" || settled.activeActorCount !== 0);
        attempt += 1
      ) {
        await Bun.sleep(25);
        settled = await host.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000));
      }
      expect(settled).toMatchObject({
        kind: "confirmed",
        activeActorCount: 0,
        pendingAlarmCount: 1,
        openSocketCount: 0,
      });
      expect(await host.observeNamespaceRuntime(scope, AbortSignal.abort("cancelled"))).toEqual({
        kind: "unknown",
      });
      expect(
        await host.observeNamespaceRuntime(
          { ...scope, tenantId: "another-tenant" },
          AbortSignal.timeout(5_000),
        ),
      ).toEqual({ kind: "unknown" });
      await writeFile(denySpawnFile, "blocked");
      const childPid = Number((await readFile(childPidFile, "utf8")).trim());
      expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
      process.kill(childPid, "SIGKILL");
      let lost = await host.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000));
      for (let attempt = 0; attempt < 100 && lost.kind !== "unknown"; attempt += 1) {
        await Bun.sleep(10);
        lost = await host.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000));
      }
      expect(lost).toEqual({ kind: "unknown" });
      await unlink(denySpawnFile);
      expect(
        await (await host.fetch(identity, new Request("http://actor.invalid/value"))).json(),
      ).toEqual({
        id: identity.id,
        value: 0,
        version: "one",
      });
      const recovered = await host.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000));
      expect(recovered).toMatchObject({ kind: "confirmed", pendingAlarmCount: 1 });
      if (initial.kind !== "confirmed" || recovered.kind !== "confirmed")
        throw new Error("native observation was not confirmed");
      expect(recovered.epoch).not.toBe(initial.epoch);
      const accepted = await legacyAuthority.readGraph(scope, AbortSignal.timeout(5_000));
      if (!accepted) throw new Error("accepted Actor graph missing");
      const currentNative = await legacyAuthority.readRealization(
        accepted,
        AbortSignal.timeout(5_000),
      );
      if (currentNative.kind !== "ready") throw new Error("native Actor graph missing");
      const expected = {
        workerUid: accepted.workerUid,
        className: accepted.className,
        sourceOperationId,
        incarnationId,
        generationKey: currentNative.realization.graph.generationKey,
        versions: currentNative.realization.graph.versions.map(
          ({ versionId, workerVersionUid, weight }) => ({ versionId, workerVersionUid, weight }),
        ),
      };
      ownOperationBusy = true;
      expect(await host.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000))).toEqual({
        kind: "unknown",
      });
      expect(
        await host.observeNamespaceRuntimeForAcceptedOperation(
          scope,
          expected,
          AbortSignal.timeout(5_000),
        ),
      ).toMatchObject({ kind: "confirmed", pendingAlarmCount: 1 });
      expect(
        await host.observeNamespaceRuntimeForAcceptedOperation(
          scope,
          { ...expected, incarnationId: "foreign-incarnation" },
          AbortSignal.timeout(5_000),
        ),
      ).toEqual({ kind: "unknown" });
      expect(
        await host.observeNamespaceRuntimeForAcceptedOperation(
          scope,
          { ...expected, sourceOperationId: "foreign-source-operation" },
          AbortSignal.timeout(5_000),
        ),
      ).toEqual({ kind: "unknown" });
      expect(
        await host.observeNamespaceRuntimeForAcceptedOperation(
          scope,
          {
            ...expected,
            versions: expected.versions.map((version) => ({ ...version, weight: 1 })),
          },
          AbortSignal.timeout(5_000),
        ),
      ).toEqual({ kind: "unknown" });
      ownOperationBusy = false;
      // The original child is still alive; only its Unix pathname is replaced.
      // A foreign listener may relay valid native replies, but it is not the
      // listener whose readiness the Host accepted for this child.
      const configPath = (await readFile(childConfigFile, "utf8")).trim();
      const nativeSocket = join(dirname(configPath), "run.sock");
      const displacedSocket = join(dirname(configPath), "run-displaced.sock");
      await rename(nativeSocket, displacedSocket);
      let foreign: ReturnType<typeof Bun.serve> | undefined;
      try {
        foreign = Bun.serve({
          unix: nativeSocket,
          fetch: (request) => fetch(request, { unix: displacedSocket, redirect: "manual" }),
        });
        expect(await host.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000))).toEqual({
          kind: "unknown",
        });
      } finally {
        foreign?.stop(true);
        await unlink(nativeSocket).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        await rename(displacedSocket, nativeSocket);
      }
      expect(await host.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000))).toEqual({
        kind: "unknown",
      });
      await runtime.publish?.("worker", {
        ...publication,
        generation: "observation-two",
        versions: publication.versions.map((version) => ({
          ...version,
          site: { ...version.site, generation: "observation-two" },
        })),
      });
      expect(await host.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000))).toEqual({
        kind: "unknown",
      });
      await host.close();
      expect(await host.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000))).toEqual({
        kind: "unknown",
      });
    } finally {
      await host.close();
      f.database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(binary === undefined)(
  "Actor startup refuses a foreign listener's pre-readiness 204 while its selected child is alive",
  async () => {
    if (!binary || !digest) throw new Error("candidate required");
    expect(
      createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
    ).toBe(digest);
    const root = await mkdtemp(join(tmpdir(), "actor-foreign-startup-"));
    const configPathFile = join(root, "child-config");
    const startGate = join(root, "start-gate");
    const wrapper = join(root, "delayed-child");
    await writeFile(startGate, "held");
    await writeFile(
      wrapper,
      `#!/bin/sh\nprintf '%s\\n' "$2" > '${configPathFile}'\nwhile test -e '${startGate}'; do sleep 0.01; done\nexec '${binary}' "$@"\n`,
      { mode: 0o700 },
    );
    const main = "main.mjs";
    const host = "__host.mjs";
    const graph: WorkerdActiveActorGraph = {
      generation: "foreign-startup-generation",
      generationKey: createHash("sha256").update("foreign-startup-generation").digest("hex"),
      workerResourceUid: "foreign-startup-worker",
      versions: [
        {
          versionId: "foreign-startup-version",
          workerVersionUid: "foreign-startup-version-uid",
          weight: 10_000,
          variantKey: "foreign-startup-variant",
          site: {
            directory: "worker",
            mainModule: main,
            hostEntrypoint: host,
            hostModules: [host, SELFHOST_WORKER_PRELUDE_MODULE],
            hostnames: [],
            generation: "foreign-startup-generation",
            workerResourceUid: "foreign-startup-worker",
            fetchHandler: true,
          },
          modules: new Map([
            [main, encoder.encode("export class Actor { fetch() { return new Response('ok'); } }")],
          ]),
          hostModules: new Map([
            [SELFHOST_WORKER_PRELUDE_MODULE, encoder.encode(selfhostWorkerPreludeSource())],
            [
              host,
              encoder.encode(
                selfhostWorkerEntrypointSource({
                  originalMainModule: main,
                  declaredHandlers: ["fetch"],
                  bindings: [],
                  publication: "foreign-startup-generation",
                  probeHostname: "probe.invalid",
                }),
              ),
            ],
          ]),
        },
      ],
    };
    const controller = new AbortController();
    const opening = openWorkerdActorNamespace(wrapper, {
      namespaceKey: "a".repeat(64),
      storagePath: join(root, "state"),
      className: "Actor",
      graph,
      signal: controller.signal,
      admitAlarm: async () => null,
      completeAlarm() {},
      admitSocket: async () => null,
      completeSocket() {},
    });
    let foreign: ReturnType<typeof Bun.serve> | undefined;
    let socket = "";
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (
          await access(configPathFile).then(
            () => true,
            () => false,
          )
        )
          break;
        await Bun.sleep(10);
      }
      const config = (await readFile(configPathFile, "utf8")).trim();
      socket = join(dirname(config), "run.sock");
      foreign = Bun.serve({ unix: socket, fetch: () => new Response(null, { status: 204 }) });
      const state = await Promise.race([
        opening.then(
          () => "admitted",
          () => "refused",
        ),
        Bun.sleep(300).then(() => "pending"),
      ]);
      expect(state).not.toBe("admitted");
    } finally {
      controller.abort(new Error("foreign startup probe finished"));
      await unlink(startGate);
      const namespace = await opening.catch(() => null);
      await namespace?.close();
      try {
        if (foreign && socket)
          expect((await fetch("http://actor.invalid/", { unix: socket })).status).toBe(204);
      } finally {
        foreign?.stop(true);
        if (socket)
          await unlink(socket).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
