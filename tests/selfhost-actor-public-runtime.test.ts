import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfhostVersionBindingsRoot } from "../src/providers/selfhost.ts";
import { createSelfhostVersionBindingStore } from "../src/providers/selfhost-version-bindings.ts";
import {
  deriveSelfhostActorForwardToken,
  openSelfhostActorPublicRuntime,
} from "../src/selfhost-actor-public-runtime.ts";
import type { WorkerdActorForwardPublication } from "../src/workerd-runtime.ts";
import { fixture, scope } from "./helpers/actor-resource-fixture.ts";

test("Actor broker owner restores exact v8 Version tokens for two callers of one namespace", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-public-runtime-"));
  const f = fixture();
  await f.deployments.create({
    tenantId: scope.tenantId,
    id: "deployment-holder",
    resourceUid: f.target.metadata.uid,
    offeringId: "worker-local",
    providerPackRef: "selfhost",
    providerInstallationRef: "local.primary",
    nativeId: "selfhost-worker:worker:operation-1",
    state: "active",
    observed: {},
    outputs: { scriptName: "worker" },
  });
  const bindings = createSelfhostVersionBindingStore({ root: selfhostVersionBindingsRoot(root) });
  const actorBinding = {
    name: "COUNTER",
    tenantId: scope.tenantId,
    namespaceResourceUid: scope.namespaceResourceUid,
    workerResourceUid: f.target.metadata.uid,
    className: "Counter",
  };
  const set = {
    workerResourceUid: "uid-caller-worker",
    handlers: ["fetch" as const],
    vars: [],
    sensitiveVars: [],
    serviceBindings: [],
  };
  const publication = async (suffix: string): Promise<WorkerdActorForwardPublication> => {
    const workerVersionResourceUid = `uid-caller-version-${suffix}`;
    const versionId = `version-${suffix}`;
    const stored = await bindings.write("caller", versionId, {
      ...set,
      workerVersionResourceUid,
      actorBindings: [actorBinding],
    });
    if (!stored.eventToken) throw new Error("event token unavailable");
    return {
      script: "caller",
      workerResourceUid: set.workerResourceUid,
      versionId,
      workerVersionResourceUid,
      bindings: [
        {
          publicName: actorBinding.name,
          tenantId: actorBinding.tenantId,
          namespaceResourceUid: actorBinding.namespaceResourceUid,
          httpService: "__TAKOSERVER_ACTOR_HTTP_00000",
          upgradeService: "__TAKOSERVER_ACTOR_UPGRADE_00000",
          token: deriveSelfhostActorForwardToken({
            eventToken: stored.eventToken,
            workerVersionResourceUid,
            binding: actorBinding,
          }),
        },
      ],
    };
  };
  const first = await publication("a");
  const second = await publication("b");
  const owner = await openSelfhostActorPublicRuntime({
    dataRoot: root,
    runtimeRoot: root,
    socketParent: join(root, "sockets"),
    binary: "/never-execute",
    graph: f.read,
    deployments: f.deployments,
    providerPackRef: "selfhost",
    providerInstallationRef: "local.primary",
  });
  try {
    await owner.actorNamespace.registerNamespace(scope);
    expect(owner.actorForwardSockets()).toEqual([]);
    await bindings.write("caller", "version-legacy", set);
    await expect(
      owner.actorForwardLifecycle.prepare([{ ...first, versionId: "version-legacy" }]),
    ).rejects.toThrow("Actor immutable Version authority unavailable");
    expect(owner.actorForwardSockets()).toEqual([]);
    await owner.actorForwardLifecycle.prepare([first, second]);
    expect(owner.actorForwardSockets()).toHaveLength(2);
    expect(new Set(owner.actorForwardSockets().map((item) => item.token))).toEqual(
      new Set([first.bindings[0]?.token, second.bindings[0]?.token]),
    );
    owner.actorForwardLifecycle.activated([first, second]);
    const altered = {
      ...second,
      bindings: second.bindings.map((item) => ({ ...item, tenantId: "other-tenant" })),
    };
    await expect(owner.actorForwardLifecycle.prepare([first, altered])).rejects.toThrow(
      "Actor immutable Version relation changed",
    );
    expect(owner.actorForwardSockets()).toHaveLength(2);
    owner.actorForwardLifecycle.uncertain();
    // Uncertainty revokes admission; sockets remain pinned for in-flight
    // transports and for exact rollback. No new authority is inferred here.
    expect(owner.actorForwardSockets()).toHaveLength(2);
  } finally {
    await owner.close();
    f.database.close();
    await rm(root, { recursive: true, force: true });
  }
});
