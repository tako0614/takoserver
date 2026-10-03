import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSelfhostProvider } from "../src/providers/selfhost.ts";
import { createSelfhostActorExecutionHost } from "../src/selfhost-actor-execution-host.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import type { WorkerdRuntime } from "../src/workerd-runtime.ts";

const actorForm = currentTakoformCandidates().forms.find(
  (form) => form.identity.formRef.kind === "ActorNamespace",
);
if (!actorForm) throw new Error("released ActorNamespace Form missing");

const runtime: WorkerdRuntime = {
  async inspectModule() {
    return { outcome: "valid", exportedHandlers: [] };
  },
  async write() {},
  async remove() {},
  async reload() {},
  async has() {
    return false;
  },
};

test("self-host Actor identity allocates only for a same-tenant pinned Worker relation", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-public-provider-"));
  const scopes: string[] = [];
  const registrations = new Set<string>();
  const offering = {
    id: "selfhost.edge.actornamespace",
    kind: "takoform.ActorNamespace",
    displayName: "Actor Namespace",
    form: actorForm.identity.formRef,
    providedInterfaces: actorForm.providedInterfaces ?? [],
    bindingRefs: [],
    capabilities: ["create", "delete", "import", "observe"] as const,
  };
  const provider = createSelfhostProvider({
    offerings: [offering],
    dataRoot: root,
    runtime,
    artifacts: {
      async manifest() {
        return null;
      },
      async blob() {
        return null;
      },
    },
    actorNamespace: {
      async registerNamespace(scope) {
        scopes.push(JSON.stringify(scope));
        registrations.add(JSON.stringify(scope));
      },
      async hasNamespace(scope) {
        return registrations.has(JSON.stringify(scope));
      },
      async namespaceAbsent(scope) {
        return !registrations.has(JSON.stringify(scope));
      },
      async forgetNamespace(scope) {
        registrations.delete(JSON.stringify(scope));
      },
    },
  });
  const identity = {
    tenantRef: "tenant-one",
    space: "default",
    name: "counter",
    uid: "uid-actor-counter-one",
  };
  const relation = {
    pointer: "/worker",
    relation: "/worker",
    targetUid: "uid-worker-one",
    resource: {
      apiVersion: "edge.forms.takoform.com",
      kind: "ModuleWorker",
      form: { formRef: { ...actorForm.identity.formRef, kind: "ModuleWorker" } },
      metadata: {
        name: "worker",
        space: "default",
        uid: "uid-worker-one",
        generation: "1",
        revision: "1",
      },
      spec: {},
    },
    deployment: {
      tenantId: "tenant-one",
      id: "dep-worker-one",
      resourceUid: "uid-worker-one",
      offeringId: "selfhost.edge.moduleworker",
      providerPackRef: provider.id,
      providerInstallationRef: "local.primary",
      nativeId: "selfhost-worker:worker:op",
      state: "active" as const,
      observed: {},
      outputs: { scriptName: "worker" },
      createdAt: "2026-10-03T00:00:00.000Z",
      updatedAt: "2026-10-03T00:00:00.000Z",
    },
  };
  const request = {
    operationId: "op-actor-one",
    offering,
    identity,
    spec: {
      className: "Counter",
      worker: { apiVersion: "edge.forms.takoform.com", kind: "ModuleWorker", name: "worker" },
    },
    relations: [relation],
  };
  try {
    const withoutRuntime = createSelfhostProvider({
      offerings: [offering],
      dataRoot: root,
      runtime,
      artifacts: {
        async manifest() {
          return null;
        },
        async blob() {
          return null;
        },
      },
    });
    expect(await withoutRuntime.apply(request)).toMatchObject({
      phase: "failed",
      failure: { code: "denied" },
    });
    expect(scopes).toHaveLength(0);
    expect(await provider.apply(request)).toMatchObject({
      phase: "succeeded",
      result: { nativeId: "selfhost-actor:uid-actor-counter-one" },
    });
    expect(scopes).toEqual([
      '{"tenantId":"tenant-one","namespaceResourceUid":"uid-actor-counter-one"}',
    ]);
    expect(
      await provider.apply({
        ...request,
        operationId: "op-wrong-tenant",
        relations: [
          { ...relation, deployment: { ...relation.deployment, tenantId: "tenant-two" } },
        ],
      }),
    ).toMatchObject({ phase: "failed" });
    expect(scopes).toHaveLength(1);
    const nativeId = "selfhost-actor:uid-actor-counter-one";
    const descriptor = provider.createNativeReadbackDescriptor?.({
      offering,
      identity,
      nativeId,
      spec: request.spec,
      relations: [relation],
    });
    expect(descriptor?.data).toEqual({ resourceUid: identity.uid });
    expect(JSON.stringify(descriptor)).not.toContain("token");
    expect(JSON.stringify(descriptor)).not.toContain("socket");
    expect(
      await provider.observe({
        offering,
        identity,
        nativeId,
        spec: request.spec,
        relations: [relation],
      }),
    ).toMatchObject({
      phase: "succeeded",
      result: { nativeId, observed: { ready: false } },
    });
    expect(
      await provider.delete({
        operationId: "op-delete-actor",
        offering,
        identity,
        nativeId,
        spec: request.spec,
        relations: [relation],
      }),
    ).toMatchObject({ phase: "succeeded" });
    expect(registrations.size).toBe(0);
    if (!descriptor) throw new Error("Actor readback descriptor missing");
    expect(
      await provider.verifyNativeAbsence?.({
        offering,
        descriptor,
        target: {
          tenantId: identity.tenantRef,
          resourceUid: identity.uid,
          incarnationId: "dep-actor",
          generation: "1",
        },
      }),
    ).toMatchObject({ outcome: "absent", evidence: { kind: "ActorNamespace" } });
    expect(
      await provider.recoverDelete?.({
        operationId: "op-delete-actor",
        offering,
        identity,
        nativeId,
        spec: request.spec,
        relations: [relation],
      }),
    ).toMatchObject({ phase: "succeeded" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Actor namespace registration persists its UID and can be revoked without starting an Actor", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-public-binding-"));
  const scope = { tenantId: "tenant-one", namespaceResourceUid: "uid-actor-counter-one" };
  const otherTenant = { tenantId: "tenant-two", namespaceResourceUid: scope.namespaceResourceUid };
  const options = {
    runtimeRoot: join(root, "runtime"),
    storageRoot: join(root, "actor"),
    binary: "/unused/workerd",
    graph: async () => null,
    deployments: { active: async () => null },
    providerPackRef: "local.pack",
    providerInstallationRef: "local.primary",
  } as const;
  const host = createSelfhostActorExecutionHost(options);
  try {
    await host.ready;
    await host.registerNamespace(scope);
    await host.registerNamespace(otherTenant);
    expect(await host.hasNamespace(scope)).toBe(true);
    expect(await host.hasNamespace(otherTenant)).toBe(true);
    await host.close();
    const restored = createSelfhostActorExecutionHost(options);
    try {
      await restored.ready;
      expect(await restored.hasNamespace(scope)).toBe(true);
      await restored.forgetNamespace(scope);
      expect(await restored.hasNamespace(scope)).toBe(false);
      expect(await restored.hasNamespace(otherTenant)).toBe(true);
    } finally {
      await restored.close();
    }
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unacknowledged Actor registration is retried from the exact existing record", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-registration-sync-"));
  const scope = { tenantId: "tenant-one", namespaceResourceUid: "uid-actor-sync-one" };
  let interrupt = true;
  const host = createSelfhostActorExecutionHost({
    runtimeRoot: join(root, "runtime"),
    storageRoot: join(root, "actor"),
    binary: "/unused/workerd",
    graph: async () => null,
    deployments: { active: async () => null },
    providerPackRef: "local.pack",
    providerInstallationRef: "local.primary",
    async afterRegistrationLinkBeforeSync() {
      if (interrupt) {
        interrupt = false;
        throw new Error("interrupted before directory sync");
      }
    },
  });
  try {
    await host.ready;
    await expect(host.registerNamespace(scope)).rejects.toThrow(
      "interrupted before directory sync",
    );
    expect(await host.hasNamespace(scope)).toBe(true);
    await host.registerNamespace(scope);
    expect(await host.hasNamespace(scope)).toBe(true);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a retained pre-fsync Actor registration can be re-acknowledged without changing identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-legacy-registration-"));
  const scope = { tenantId: "tenant-one", namespaceResourceUid: "uid-actor-legacy-one" };
  const storageRoot = join(root, "actor");
  const registrations = join(storageRoot, "registrations");
  const key = createHash("sha256")
    .update(JSON.stringify([scope.tenantId, scope.namespaceResourceUid]))
    .digest("hex");
  await mkdir(registrations, { recursive: true });
  await writeFile(join(registrations, `${key}.json`), JSON.stringify(scope));
  const host = createSelfhostActorExecutionHost({
    runtimeRoot: join(root, "runtime"),
    storageRoot,
    binary: "/unused/workerd",
    graph: async () => null,
    deployments: { active: async () => null },
    providerPackRef: "local.pack",
    providerInstallationRef: "local.primary",
  });
  try {
    await host.ready;
    await host.registerNamespace(scope);
    expect(await host.hasNamespace(scope)).toBe(true);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("revocation fences a pending Actor authority read before native startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-revoke-race-"));
  const scope = { tenantId: "tenant-one", namespaceResourceUid: "uid-actor-race-one" };
  let entered!: () => void;
  const enteredGraph = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const releaseGraph = new Promise<void>((resolve) => {
    release = resolve;
  });
  const host = createSelfhostActorExecutionHost({
    runtimeRoot: join(root, "runtime"),
    storageRoot: join(root, "actor"),
    binary: "/unused/workerd",
    graph: async () => {
      entered();
      await releaseGraph;
      return null;
    },
    deployments: { active: async () => null },
    providerPackRef: "local.pack",
    providerInstallationRef: "local.primary",
  });
  try {
    await host.ready;
    await host.registerNamespace(scope);
    const fetching = host.fetch({ ...scope, id: "one" }, new Request("http://actor.invalid/"));
    await enteredGraph;
    const forgetting = host.forgetNamespace(scope);
    release();
    await expect(fetching).rejects.toThrow();
    await forgetting;
    expect(await host.hasNamespace(scope)).toBe(false);
    await expect(
      host.fetch({ ...scope, id: "one" }, new Request("http://actor.invalid/")),
    ).rejects.toThrow("revoked");
  } finally {
    release();
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("deletion retains the exclusive lease until native data is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-delete-lease-"));
  const scope = { tenantId: "tenant-one", namespaceResourceUid: "uid-actor-delete-one" };
  const storageRoot = join(root, "actor");
  const key = createHash("sha256")
    .update(JSON.stringify([scope.tenantId, scope.namespaceResourceUid]))
    .digest("hex");
  let entered!: () => void;
  const deleting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let proceed!: () => void;
  const resumed = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  const options = {
    runtimeRoot: join(root, "runtime"),
    storageRoot,
    binary: "/unused/workerd",
    graph: async () => null,
    deployments: { active: async () => null },
    providerPackRef: "local.pack",
    providerInstallationRef: "local.primary",
  } as const;
  const host = createSelfhostActorExecutionHost({
    ...options,
    async beforeNamespaceStorageDelete() {
      entered();
      await resumed;
    },
  });
  const peer = createSelfhostActorExecutionHost(options);
  try {
    await Promise.all([host.ready, peer.ready]);
    await host.registerNamespace(scope);
    const forget = host.forgetNamespace(scope);
    await deleting;
    expect((await lstat(join(storageRoot, "leases", key))).isDirectory()).toBe(true);
    await expect(
      peer.fetch({ ...scope, id: "one" }, new Request("http://actor.invalid/")),
    ).rejects.toThrow("not registered");
    await expect(peer.forgetNamespace(scope)).rejects.toThrow();
    proceed();
    await forget;
    expect(await host.namespaceAbsent(scope)).toBe(true);
  } finally {
    proceed();
    await Promise.all([host.close(), peer.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("owner refuses to delete a namespace while canonical graph authority remains", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-live-delete-"));
  const scope = { tenantId: "tenant-one", namespaceResourceUid: "uid-actor-live-one" };
  const host = createSelfhostActorExecutionHost({
    runtimeRoot: join(root, "runtime"),
    storageRoot: join(root, "actor"),
    binary: "/unused/workerd",
    graph: async () =>
      ({ tenantId: scope.tenantId, namespace: { uid: scope.namespaceResourceUid } }) as never,
    deployments: { active: async () => null },
    providerPackRef: "local.pack",
    providerInstallationRef: "local.primary",
  });
  try {
    await host.ready;
    await host.registerNamespace(scope);
    await expect(host.forgetNamespace(scope)).rejects.toThrow("Resource authority");
    expect(await host.hasNamespace(scope)).toBe(true);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("delete recovery proves a failed lease-unlink ACK durably absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-lease-sync-"));
  const scope = { tenantId: "tenant-one", namespaceResourceUid: "uid-actor-sync-delete" };
  const options = {
    runtimeRoot: join(root, "runtime"),
    storageRoot: join(root, "actor"),
    binary: "/unused/workerd",
    graph: async () => null,
    deployments: { active: async () => null },
    providerPackRef: "local.pack",
    providerInstallationRef: "local.primary",
  } as const;
  const first = createSelfhostActorExecutionHost({
    ...options,
    async afterLeaseUnlinkBeforeSync() {
      throw new Error("lease sync interrupted");
    },
  });
  try {
    await first.ready;
    await first.registerNamespace(scope);
    await expect(first.forgetNamespace(scope)).rejects.toThrow("lease sync interrupted");
    expect(await first.namespaceAbsent(scope)).toBe(false);
    await first.close();
    const recovery = createSelfhostActorExecutionHost(options);
    try {
      await recovery.ready;
      expect(await recovery.namespaceAbsent(scope)).toBe(true);
    } finally {
      await recovery.close();
    }
  } finally {
    await first.close();
    await rm(root, { recursive: true, force: true });
  }
});
