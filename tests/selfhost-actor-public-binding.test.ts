import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSelfhostActorExecutionHost } from "../src/selfhost-actor-execution-host.ts";

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
