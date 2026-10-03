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
