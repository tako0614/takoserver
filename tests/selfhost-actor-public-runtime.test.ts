import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTOR_ABI_INTERFACE_REFS } from "../src/actor-abi-ref.ts";
import type { TakoformInterfaceRef } from "../src/interface-ref.ts";
import {
  SELFHOST_ACTOR_BINDING_REF,
  selfhostVersionBindingsRoot,
} from "../src/providers/selfhost.ts";
import {
  createSelfhostVersionBindingStore,
  deriveSelfhostActorForwardToken,
} from "../src/providers/selfhost-version-bindings.ts";
import { openSelfhostActorPublicRuntime } from "../src/selfhost-actor-public-runtime.ts";
import {
  createSelfhostRuntimeBindingMaterializer,
  SELFHOST_ACTOR_MATERIAL_KIND,
} from "../src/selfhost-runtime-binding-materializer.ts";
import {
  SELFHOST_ACTOR_DATA_ROOT_MAX_BYTES,
  SELFHOST_SOCKET_DIRECTORY_PREFIX,
  selfhostPrivateSocketRoot,
} from "../src/selfhost-socket-layout.ts";
import type { WorkerdActorForwardPublication } from "../src/workerd-runtime.ts";
import { fixture, scope } from "./helpers/actor-resource-fixture.ts";
import { mkdtempForSockets } from "./helpers/socket-temp-root.ts";

test("Actor broker owner restores exact v8 Version tokens for two callers of one namespace", async () => {
  const root = await mkdtempForSockets("actor-public-runtime-", SELFHOST_ACTOR_DATA_ROOT_MAX_BYTES);
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
  let graphReads = 0;
  let failFrom = Number.POSITIVE_INFINITY;
  const owner = await openSelfhostActorPublicRuntime({
    dataRoot: root,
    runtimeRoot: root,
    socketParent: selfhostPrivateSocketRoot(root),
    binary: "/never-execute",
    graph: async (...args) => {
      graphReads += 1;
      return graphReads >= failFrom ? null : f.read(...args);
    },
    deployments: f.deployments,
    providerPackRef: "selfhost",
    providerInstallationRef: "local.primary",
  });
  try {
    await owner.actorNamespace.registerNamespace(scope);
    await f.deployments.create({
      tenantId: scope.tenantId,
      id: "deployment-actor",
      resourceUid: scope.namespaceResourceUid,
      offeringId: "compute.actor.stable-v1.standard",
      providerPackRef: "selfhost",
      providerInstallationRef: "local.primary",
      nativeId: `selfhost-actor:${scope.namespaceResourceUid}`,
      state: "active",
      observed: {},
      outputs: { resourceUid: scope.namespaceResourceUid },
    });
    const deployment = await f.deployments.active(scope.tenantId, scope.namespaceResourceUid);
    if (!deployment) throw new Error("Actor deployment unavailable");
    const relation = {
      pointer: "/actorBindings/0/resource",
      relation: "/actorBindings/*/resource",
      targetUid: scope.namespaceResourceUid,
      bindingRef: SELFHOST_ACTOR_BINDING_REF,
      resource: f.source,
      deployment,
    };
    const materializer = createSelfhostRuntimeBindingMaterializer("selfhost", owner);
    const route = {
      bindingRef: SELFHOST_ACTOR_BINDING_REF,
      materialKind: SELFHOST_ACTOR_MATERIAL_KIND,
    };
    const exported = await materializer.exporter?.exportTarget({
      tenantId: scope.tenantId,
      relation,
      route,
    });
    expect(exported).toBeDefined();
    const material = await materializer.importer?.importBinding({
      tenantId: scope.tenantId,
      source: {
        tenantRef: scope.tenantId,
        space: "default",
        name: "caller",
        uid: set.workerResourceUid,
      },
      sourceSpec: {},
      name: "COUNTER",
      relation,
      route,
      exported: {
        providerPackRef: "selfhost",
        materialKind: SELFHOST_ACTOR_MATERIAL_KIND,
        material: exported,
      },
    });
    expect(material).toEqual({
      kind: SELFHOST_ACTOR_MATERIAL_KIND,
      tenantId: scope.tenantId,
      namespaceResourceUid: scope.namespaceResourceUid,
      workerResourceUid: f.target.metadata.uid,
      className: "Counter",
    });
    expect(JSON.stringify(material)).not.toContain("token");
    expect(
      await materializer.exporter?.exportTarget({ tenantId: "other", relation, route }),
    ).toBeNull();
    expect(owner.actorForwardSockets()).toEqual([]);
    await bindings.write("caller", "version-legacy", set);
    await expect(
      owner.actorForwardLifecycle.prepare([{ ...first, versionId: "version-legacy" }]),
    ).rejects.toThrow("Actor immutable Version authority unavailable");
    expect(owner.actorForwardSockets()).toEqual([]);
    failFrom = graphReads + 3;
    await expect(owner.actorForwardLifecycle.prepare([first])).rejects.toThrow(
      "Actor namespace authority unavailable",
    );
    expect(owner.actorForwardSockets()).toEqual([]);
    failFrom = Number.POSITIVE_INFINITY;
    // The failed reproof closed and unlinked its real local brokers; retrying
    // the same deterministic paths must work in this Bun incarnation.
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

test("Actor v9 publication proves the stored, published, and current full ABI ref", async () => {
  const root = await mkdtempForSockets("actor-public-v9-", SELFHOST_ACTOR_DATA_ROOT_MAX_BYTES);
  const f = fixture();
  const selectedRef = ACTOR_ABI_INTERFACE_REFS.v2;
  let currentRef: TakoformInterfaceRef = selectedRef;
  const bindings = createSelfhostVersionBindingStore({ root: selfhostVersionBindingsRoot(root) });
  const actorBinding = {
    name: "COUNTER",
    tenantId: scope.tenantId,
    namespaceResourceUid: scope.namespaceResourceUid,
    workerResourceUid: f.target.metadata.uid,
    className: "Counter",
    runtimeClassRef: selectedRef,
  };
  const versionId = "version-v9";
  const workerVersionResourceUid = "uid-version-v9";
  const stored = await bindings.write("caller", versionId, {
    workerResourceUid: "uid-caller-worker",
    workerVersionResourceUid,
    handlers: ["fetch"],
    vars: [],
    sensitiveVars: [],
    serviceBindings: [],
    actorBindings: [actorBinding],
  });
  if (!stored.eventToken) throw new Error("event token unavailable");
  const publication: WorkerdActorForwardPublication = {
    script: "caller",
    workerResourceUid: "uid-caller-worker",
    workerVersionResourceUid,
    versionId,
    bindings: [
      {
        publicName: actorBinding.name,
        tenantId: actorBinding.tenantId,
        namespaceResourceUid: actorBinding.namespaceResourceUid,
        runtimeClassRef: selectedRef,
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
  const owner = await openSelfhostActorPublicRuntime({
    dataRoot: root,
    runtimeRoot: root,
    socketParent: selfhostPrivateSocketRoot(root),
    binary: "/never-execute",
    graph: async (...args) => {
      const graph = await f.read(...args);
      return graph ? { ...graph, runtimeClassRef: currentRef } : null;
    },
    deployments: f.deployments,
    providerPackRef: "selfhost",
    providerInstallationRef: "local.primary",
  });
  try {
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
    await owner.actorNamespace.registerNamespace(scope);
    await expect(
      owner.actorForwardLifecycle.prepare([
        {
          ...publication,
          bindings: publication.bindings.map(
            ({ runtimeClassRef: _omitted, ...binding }) => binding,
          ),
        },
      ]),
    ).rejects.toThrow("Actor immutable Version relation changed");
    expect(owner.actorForwardSockets()).toEqual([]);
    currentRef = ACTOR_ABI_INTERFACE_REFS.legacy;
    await expect(owner.actorForwardLifecycle.prepare([publication])).rejects.toThrow(
      "Actor namespace authority unavailable",
    );
    expect(owner.actorForwardSockets()).toEqual([]);
    currentRef = selectedRef;
    await owner.actorForwardLifecycle.prepare([publication]);
    expect(owner.actorForwardSockets()).toHaveLength(1);
  } finally {
    await owner.close();
    f.database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Actor reservations release failed attempts and reuse bounded broker slots across updates", async () => {
  const root = await mkdtempForSockets(
    "actor-public-capacity-",
    SELFHOST_ACTOR_DATA_ROOT_MAX_BYTES,
  );
  const f = fixture();
  const owner = await openSelfhostActorPublicRuntime({
    dataRoot: root,
    runtimeRoot: root,
    socketParent: selfhostPrivateSocketRoot(root),
    binary: "/never-execute",
    graph: f.read,
    deployments: f.deployments,
    providerPackRef: "selfhost",
    providerInstallationRef: "local.primary",
  });
  try {
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
    await owner.actorNamespace.registerNamespace(scope);
    const bindings = createSelfhostVersionBindingStore({ root: selfhostVersionBindingsRoot(root) });
    const actorBinding = {
      name: "COUNTER",
      tenantId: scope.tenantId,
      namespaceResourceUid: scope.namespaceResourceUid,
      workerResourceUid: f.target.metadata.uid,
      className: "Counter",
    };
    const publication = async (index: number): Promise<WorkerdActorForwardPublication> => {
      const workerVersionResourceUid = `uid-caller-version-${index}`;
      const versionId = `version-${index}`;
      const stored = await bindings.write("caller", versionId, {
        workerResourceUid: "uid-caller-worker",
        workerVersionResourceUid,
        handlers: ["fetch"],
        vars: [],
        sensitiveVars: [],
        serviceBindings: [],
        actorBindings: [actorBinding],
      });
      if (!stored.eventToken) throw new Error("event token unavailable");
      return {
        script: "caller",
        workerResourceUid: "uid-caller-worker",
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
    const first = await publication(0);
    const publications = [first];
    const failedAttempt = await owner.actorForwardLifecycle.reserve([first]);
    expect(owner.actorForwardSockets()).toHaveLength(1);
    await failedAttempt.release();
    await failedAttempt.release();
    expect(owner.actorForwardSockets()).toEqual([]);
    // The same exact private paths can be opened again after the attempt
    // failed before activation; no stale socket or leaked capacity remains.
    const retry = await owner.actorForwardLifecycle.reserve([first]);
    expect(owner.actorForwardSockets()).toHaveLength(1);
    owner.actorForwardLifecycle.activated([first]);
    await retry.release();
    expect(owner.isRestored()).toBe(true);
    for (let index = 1; index <= 129; index += 1) {
      const next = await publication(index);
      publications.push(next);
      const reservation = await owner.actorForwardLifecycle.reserve([next]);
      owner.actorForwardLifecycle.activated([next]);
      await reservation.release();
      expect(owner.actorForwardSockets()).toHaveLength(1);
      expect(owner.actorForwardSockets()[0]?.token).toBe(next.bindings[0]?.token);
    }
    owner.actorForwardLifecycle.activated([]);
    const finalReservation = await owner.actorForwardLifecycle.reserve([]);
    await finalReservation.release();
    expect(owner.actorForwardSockets()).toEqual([]);
    const full = await owner.actorForwardLifecycle.reserve(publications.slice(0, 128));
    expect(owner.actorForwardSockets()).toHaveLength(128);
    await full.release();
    expect(owner.actorForwardSockets()).toEqual([]);
    await expect(owner.actorForwardLifecycle.reserve(publications.slice(0, 129))).rejects.toThrow(
      "Actor forward socket capacity exceeded",
    );
    expect(owner.actorForwardSockets()).toEqual([]);
    const second = publications[1];
    if (!second) throw new Error("second Actor publication unavailable");
    const rollback = await owner.actorForwardLifecycle.reserve([first, second]);
    owner.actorForwardLifecycle.activated([second]);
    const releasing = rollback.release();
    // The first never-admitted pair is removed from the visible map before
    // its real Unix listener close completes. Inject uncertainty while that
    // close is in flight, before cleanup can examine the accepted second pair.
    for (let attempt = 0; attempt < 100 && owner.actorForwardSockets().length !== 1; attempt += 1)
      await Promise.resolve();
    expect(owner.actorForwardSockets()).toHaveLength(1);
    owner.actorForwardLifecycle.uncertain();
    await releasing;
    expect(owner.actorForwardSockets().map((socket) => socket.token)).toEqual([
      second.bindings[0]?.token,
    ]);
    expect(owner.isRestored()).toBe(false);
  } finally {
    await owner.close();
    f.database.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** Open the public Actor runtime below `dataRoot` and reserve one real broker pair. */
async function reserveOneActorBrokerPair(dataRoot: string): Promise<readonly string[]> {
  const f = fixture();
  const owner = await openSelfhostActorPublicRuntime({
    dataRoot,
    runtimeRoot: dataRoot,
    socketParent: selfhostPrivateSocketRoot(dataRoot),
    binary: "/never-execute",
    graph: f.read,
    deployments: f.deployments,
    providerPackRef: "selfhost",
    providerInstallationRef: "local.primary",
  });
  try {
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
    await owner.actorNamespace.registerNamespace(scope);
    const actorBinding = {
      name: "COUNTER",
      tenantId: scope.tenantId,
      namespaceResourceUid: scope.namespaceResourceUid,
      workerResourceUid: f.target.metadata.uid,
      className: "Counter",
    };
    const stored = await createSelfhostVersionBindingStore({
      root: selfhostVersionBindingsRoot(dataRoot),
    }).write("caller", "version-0", {
      workerResourceUid: "uid-caller-worker",
      workerVersionResourceUid: "uid-caller-version-0",
      handlers: ["fetch"],
      vars: [],
      sensitiveVars: [],
      serviceBindings: [],
      actorBindings: [actorBinding],
    });
    if (!stored.eventToken) throw new Error("event token unavailable");
    const lease = await owner.actorForwardLifecycle.reserve([
      {
        script: "caller",
        workerResourceUid: "uid-caller-worker",
        versionId: "version-0",
        workerVersionResourceUid: "uid-caller-version-0",
        bindings: [
          {
            publicName: actorBinding.name,
            tenantId: actorBinding.tenantId,
            namespaceResourceUid: actorBinding.namespaceResourceUid,
            httpService: "__TAKOSERVER_ACTOR_HTTP_00000",
            upgradeService: "__TAKOSERVER_ACTOR_UPGRADE_00000",
            token: deriveSelfhostActorForwardToken({
              eventToken: stored.eventToken,
              workerVersionResourceUid: "uid-caller-version-0",
              binding: actorBinding,
            }),
          },
        ],
      },
    ]);
    try {
      return owner
        .actorForwardSockets()
        .flatMap((socket) => [socket.httpSocketPath, socket.upgradeSocketPath]);
    } finally {
      await lease.release();
    }
  } finally {
    await owner.close();
    f.database.close();
  }
}

test("Actor brokers bind below a data root of exactly the published maximum and refuse one byte more", async () => {
  const base = await mkdtempForSockets("apr-", SELFHOST_ACTOR_DATA_ROOT_MAX_BYTES - 2);
  try {
    const exact = join(
      base,
      "d".repeat(SELFHOST_ACTOR_DATA_ROOT_MAX_BYTES - Buffer.byteLength(base) - 1),
    );
    expect(Buffer.byteLength(exact)).toBe(SELFHOST_ACTOR_DATA_ROOT_MAX_BYTES);
    const paths = await reserveOneActorBrokerPair(exact);
    expect(paths).toHaveLength(2);
    for (const path of paths) {
      expect(
        path.startsWith(
          `${selfhostPrivateSocketRoot(exact)}/${SELFHOST_SOCKET_DIRECTORY_PREFIX.actorBrokers}`,
        ),
      ).toBe(true);
    }
    expect(Math.max(...paths.map((path) => Buffer.byteLength(path)))).toBe(99);
    await expect(reserveOneActorBrokerPair(`${exact}x`)).rejects.toThrow(
      "Actor forward socket path unavailable",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("the shared Actor socket parent must stay a private, owned, real directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-public-parent-"));
  const f = fixture();
  const open = (socketParent: string) =>
    openSelfhostActorPublicRuntime({
      dataRoot: root,
      runtimeRoot: root,
      socketParent,
      binary: "/never-execute",
      graph: f.read,
      deployments: f.deployments,
      providerPackRef: "selfhost",
      providerInstallationRef: "local.primary",
    });
  try {
    const shared = selfhostPrivateSocketRoot(root);
    await mkdir(shared, { mode: 0o755 });
    await chmod(shared, 0o755);
    await expect(open(shared)).rejects.toThrow(
      `Actor socket directory ${shared} must be a private (0700) real directory owned by this user`,
    );
    await chmod(shared, 0o700);
    await symlink(shared, join(root, "alias"));
    await expect(open(join(root, "alias"))).rejects.toThrow(
      "must be a private (0700) real directory",
    );
    const owner = await open(shared);
    await owner.close();
  } finally {
    f.database.close();
    await rm(root, { recursive: true, force: true });
  }
});
