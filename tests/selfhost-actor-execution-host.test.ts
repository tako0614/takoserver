import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SELFHOST_WORKER_PRELUDE_MODULE,
  selfhostWorkerPreludeSource,
} from "../src/providers/selfhost-worker-prelude.ts";
import { selfhostWorkerEntrypointSource } from "../src/providers/selfhost-worker-wrapper.ts";
import { createSelfhostActorExecutionHost } from "../src/selfhost-actor-execution-host.ts";
import { WORKERD_CLOSED_GRAPH_ARTIFACT } from "../src/workerd-artifact.ts";
import { createWorkerdRuntime, type WorkerdDeploymentPublication } from "../src/workerd-runtime.ts";
import { actorForm, fixture, insert, resource, scope } from "./helpers/actor-resource-fixture.ts";

const binary = process.env.TAKOSERVER_ACTOR_QUALIFICATION_BINARY;
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
    await expect(owner.fetch({ ...scope, id: "a" }, request())).rejects.toThrow(
      "realization unavailable",
    );
    await expect(owner.fetch({ ...scope, tenantId: "other", id: "a" }, request())).rejects.toThrow(
      "Resource unavailable",
    );
    expect(await stat(join(root, "state")).catch(() => null)).toBeNull();
  } finally {
    await owner.close();
    f.database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(binary === undefined)(
  "real self-host Actor owner selects persisted deployment, gates streams and retains UID-private SQL",
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
    const f = await deployedFixture();
    const runtimeRoot = join(root, "runtime");
    const storageRoot = join(root, "state");
    const runtime = createWorkerdRuntime({ root: runtimeRoot, isReady: () => true });
    const source = await readFile(join(import.meta.dir, "fixtures/actor-host/counter.mjs"), "utf8");
    const main = `import { Counter as Base } from './counter.mjs';
export class Counter extends Base {
 async fetch(request) {
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
}`;
    const publication = (generation: string): WorkerdDeploymentPublication => ({
      generation,
      workerResourceUid: f.target.metadata.uid,
      hostnames: [],
      versions: ["a", "b"].map((version) => ({
        versionId: `version-${version}`,
        workerVersionUid: `version-uid-${version}`,
        weight: version === "a" ? 1 : 9999,
        site: {
          directory: "worker",
          mainModule: "main.mjs",
          hostEntrypoint: "__host.mjs",
          hostModules: [SELFHOST_WORKER_PRELUDE_MODULE],
          hostnames: [],
          generation,
          workerResourceUid: f.target.metadata.uid,
          fetchHandler: true,
          modules: ["counter.mjs"],
          vars: [
            { name: "VERSION", value: version, kind: "text" },
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
    let afterGraphRead: (() => void) | undefined;
    const makeOwner = () =>
      createSelfhostActorExecutionHost({
        runtimeRoot,
        storageRoot,
        binary,
        graph: async (scope, signal) => {
          const graph = await f.read(scope, signal);
          afterGraphRead?.();
          return graph;
        },
        deployments: f.deployments,
        providerPackRef: "selfhost",
        providerInstallationRef: "local.primary",
        basisPoint: () => basisPoint,
      });
    let owner = makeOwner();
    const identity = { ...scope, id: "カウンター/a" };
    try {
      await runtime.publish?.("worker", publication("generation-1"));
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
      basisPoint = 9999;
      expect(await (await owner.fetch(identity, request())).json()).toEqual({
        id: identity.id,
        value: 2,
        version: "b",
      });
      await owner.close();
      owner = makeOwner();
      expect((await (await owner.fetch(identity, request())).json()).value).toBe(2);
      const held = await owner.fetch(identity, request("/stream"));
      const heldReader = held.body?.getReader();
      expect(new TextDecoder().decode((await heldReader?.read())?.value)).toBe("head");
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
      // The second request selected Version A but must wait for Version B's
      // held body. Deletion in that gap must fence the selected bytes.
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
    } finally {
      await owner.close();
      f.database.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
