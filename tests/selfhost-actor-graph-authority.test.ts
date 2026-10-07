import { expect, test } from "bun:test";
import { createLegacyActorGraphAuthority } from "../src/selfhost-actor-graph-authority.ts";
import { fixture, scope } from "./helpers/actor-resource-fixture.ts";

test("legacy Actor authority fences a changed canonical graph after realization selection", async () => {
  const f = fixture();
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
    const authority = createLegacyActorGraphAuthority({
      runtimeRoot: "/unused/runtime",
      graph: f.read,
      deployments: f.deployments,
      providerPackRef: "selfhost",
      providerInstallationRef: "local.primary",
    });
    const signal = new AbortController().signal;
    const graph = await authority.readGraph(scope, signal);
    expect(graph).not.toBeNull();
    if (!graph) throw new Error("missing canonical Actor graph");
    expect(await authority.hasRealization(graph)).toBe(true);
    const deployment = await f.deployments.active(scope.tenantId, graph.workerUid);
    const selected = {
      script: "worker",
      graph: null as never,
      authorityKey: JSON.stringify(deployment),
    };
    expect(await authority.stillCurrent(graph, selected, signal)).toBe(true);

    const changed = {
      ...structuredClone(f.source),
      spec: { ...f.source.spec, className: "Replacement" },
    };
    f.database
      .query("UPDATE tf_resources SET resource_json = ? WHERE uid = ?")
      .run(JSON.stringify(changed), f.source.metadata.uid);
    expect(await authority.stillCurrent(graph, selected, signal)).toBe(false);
    expect(await authority.hasNamespaceAuthority(scope, signal)).toBe(true);
  } finally {
    f.database.close();
  }
});
