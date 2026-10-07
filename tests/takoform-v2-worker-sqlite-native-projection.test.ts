import { expect, test } from "bun:test";
import { bytesDigest } from "../src/json.ts";
import type { JsonObject } from "../src/ports.ts";
import { SELFHOST_WORKER_EDGE_SQL_BINDING_KIND } from "../src/providers/selfhost-worker-wrapper.ts";
import {
  parseWorkerBundleManifest,
  validateWorkerBundlePayload,
} from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  parseWorkerVersionSpec,
  WORKER_DEPLOYMENT_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";
import {
  inspectV2WorkerCodeVersionEligibility,
  projectV2WorkerCodeVersion,
} from "../src/takoform-v2/worker-code-runtime.ts";
import { createV2WorkerPublication } from "../src/takoform-v2/worker-static-publication.ts";
import type {
  WorkerdDeploymentPublication,
  WorkerdSite,
  WorkerdStaticSite,
} from "../src/workerd-runtime.ts";

const encoder = new TextEncoder();
const source = encoder.encode(
  "export const marker = 'named'; export default { async fetch(_request, env) { const result = await env.DB.query('SELECT 1 AS value'); return Response.json(result.rows); } };",
);
const sqliteBindings = [{ name: "DB", resource: { resourceUid: "database-uid-001" } }];
const resolvedSqliteBindings = [{ name: "DB", resourceUid: "database-uid-001" }];
const identity = {
  directory: "worker-uid-001",
  hostnames: [],
  generation: "takoserver-v2-operation:11111111-1111-4111-8111-111111111111",
  workerResourceUid: "worker-uid-001",
  workerVersionUid: "version-uid-001",
  versionId: "v2-native-immutable-id",
  weight: 10_000,
  bundleResourceUid: "bundle-uid-001",
};
const spec = {
  worker: { resourceUid: identity.workerResourceUid },
  bundle: { resourceUid: identity.bundleResourceUid },
  handlers: ["fetch"],
  sqliteBindings,
};

async function heldBundle() {
  const manifestBytes = encoder.encode(
    JSON.stringify({
      entrypoint: "main.js",
      files: [
        {
          path: "main.js",
          url: "https://artifacts.example.test/main.js",
          sha256: (await bytesDigest(source)).slice(7),
          mediaType: "application/javascript+module",
        },
      ],
    }),
  );
  const manifest = parseWorkerBundleManifest(manifestBytes);
  const verified = await validateWorkerBundlePayload({
    spec: {
      artifact: {
        url: "https://artifacts.example.test/manifest.json",
        sha256: (await bytesDigest(manifestBytes)).slice(7),
      },
    },
    manifestBytes,
    fileBytes: [source],
  });
  return {
    manifest,
    manifestBytes,
    files: [source],
    observed: verified.observed as unknown as JsonObject,
  };
}

const inspectModule = async () => ({
  outcome: "valid" as const,
  exportedHandlers: ["fetch" as const],
});

test("SQLite Version eligibility requires the exact accepted reference graph", async () => {
  const bundle = await heldBundle();
  const request = {
    workerResourceUid: identity.workerResourceUid,
    bundleResourceUid: identity.bundleResourceUid,
    spec,
    bundle,
    inspectModule,
  };
  await expect(inspectV2WorkerCodeVersionEligibility(request)).rejects.toMatchObject({
    code: "worker_binding_unavailable",
  });
  await expect(
    inspectV2WorkerCodeVersionEligibility({
      ...request,
      resolvedSqliteBindings: [{ name: "DB", resourceUid: "foreign-database" }],
    }),
  ).rejects.toMatchObject({ code: "worker_binding_unavailable" });
  await expect(
    inspectV2WorkerCodeVersionEligibility({ ...request, resolvedSqliteBindings }),
  ).resolves.toBeUndefined();
});

test("SQLite native projection refuses absent boot grant and retains held bytes and named exports", async () => {
  const bundle = await heldBundle();
  const request = { identity, spec, bundle, inspectModule, resolvedSqliteBindings };
  await expect(projectV2WorkerCodeVersion(request)).rejects.toMatchObject({
    code: "worker_binding_unavailable",
  });
  const projection = await projectV2WorkerCodeVersion({
    ...request,
    sqliteBoot: { address: "127.0.0.1:45231", token: `${"a".repeat(80)}.${"b".repeat(43)}` },
  });
  expect(projection.versionId).toBe(identity.versionId);
  expect(projection.workerVersionUid).toBe(identity.workerVersionUid);
  expect(projection.site.mainModule).not.toBe("main.js");
  expect(projection.site.dataPlane?.address).toBe("127.0.0.1:45231");
  expect(projection.site.dataPlane?.vars).toEqual([
    {
      name: "__TAKOSERVER_SELFHOST_DATA_TOKEN",
      value: `${"a".repeat(80)}.${"b".repeat(43)}`,
      kind: "text",
    },
  ]);
  expect(projection.modules.get("main.js")).toEqual(source);
  const adapter = new TextDecoder().decode(projection.modules.get(projection.site.mainModule));
  expect(adapter).toContain('export * from "./main.js"');
  expect(adapter).not.toContain("127.0.0.1:45231");
  expect(adapter).not.toContain(`${"a".repeat(80)}.${"b".repeat(43)}`);
  expect(projection.site.dataPlane && SELFHOST_WORKER_EDGE_SQL_BINDING_KIND).toBe("edge.sql@1.0.0");
});

test("publication binds the selected native Version ID to the accepted SQLite graph", async () => {
  const bundle = await heldBundle();
  const operationId = "11111111-1111-4111-8111-111111111111";
  const versionSpec = parseWorkerVersionSpec(spec);
  const execution = {
    operationId,
    leaseToken: "lease",
    backendKey: "backend-key",
    backendId: "backend-id",
    targetKey: "selfhost-sqlite-target-1",
    resourceUid: "deployment-uid-001",
    principal: "alice",
    action: "create",
    generation: 1,
    form: WORKER_DEPLOYMENT_FORM_URL,
    space: "space-a",
    name: "deployment",
    spec: { worker: { resourceUid: identity.workerResourceUid }, versions: [] },
    previousObserved: {},
    previousOutput: {},
  } satisfies V2Execution;
  const snapshot = {
    sourceOperationId: operationId,
    worker: {
      uid: identity.workerResourceUid,
      principal: "alice",
      space: "space-a",
      generation: 1,
    },
    deployment: {
      uid: execution.resourceUid,
      generation: 1,
      spec: {
        worker: { resourceUid: identity.workerResourceUid },
        versions: [{ workerVersion: { resourceUid: identity.workerVersionUid }, weight: 10_000 }],
      },
      versions: [
        {
          uid: identity.workerVersionUid,
          sourceOperationId: "22222222-2222-4222-8222-222222222222",
          generation: 3,
          weight: 10_000,
          spec: versionSpec,
        },
      ],
    },
    endpoint: null,
  };
  const resolution = {
    kind: "ready" as const,
    snapshot,
    sqlGuard: {} as never,
    stillCurrent: async () => true,
    readVersionMaterials: async () => ({ bundle, assets: null }),
  };
  let published: WorkerdDeploymentPublication<WorkerdSite | WorkerdStaticSite> | null = null;
  const issued: unknown[] = [];
  const inspected: unknown[] = [];
  const runtime = {
    inspectModule,
    async observeExactPublication() {
      return published ? ("matches" as const) : ("different" as const);
    },
    async publishFenced(
      _name: string,
      project: (
        current: null,
      ) => Promise<WorkerdDeploymentPublication<WorkerdSite | WorkerdStaticSite> | null>,
      fence: () => Promise<boolean>,
    ) {
      if (!(await fence())) throw new Error("stale graph");
      published = await project(null);
    },
  };
  const publication = createV2WorkerPublication({
    targetKey: execution.targetKey,
    publicationState: { resolve: async () => resolution },
    runtime,
    v2SqliteBinding: {
      address: "127.0.0.1:45231",
      issueGrant(grant) {
        issued.push(grant);
        return `${"a".repeat(80)}.${"b".repeat(43)}`;
      },
      async resolveCurrentBinding(claim, name) {
        inspected.push({ claim, name });
        return { resourceUid: "database-uid-001", vector: "current-settled-vector" };
      },
    },
  });
  expect(await publication.publish(execution)).toMatchObject({ kind: "confirmed" });
  const selected = (
    published as WorkerdDeploymentPublication<WorkerdSite | WorkerdStaticSite> | null
  )?.versions[0];
  expect(issued.length).toBeGreaterThan(0);
  expect(issued[0]).toMatchObject({
    principal: "alice",
    space: "space-a",
    targetKey: execution.targetKey,
    workerUid: identity.workerResourceUid,
    workerVersionUid: identity.workerVersionUid,
    nativeVersionId: selected?.versionId,
    incarnationId: operationId,
    servingSourceOperationId: operationId,
    bindings: resolvedSqliteBindings,
  });
  expect(inspected.length).toBeGreaterThan(0);
  const site = selected?.site;
  expect(site && "dataPlane" in site ? site.dataPlane?.address : undefined).toBe("127.0.0.1:45231");
  expect(site && "mainModule" in site ? site.mainModule : undefined).not.toBe("main.js");
  const graph = selected;
  expect(graph?.hostModules?.has("__takoserver-selfhost-data.js")).toBe(true);
  expect(new TextDecoder().decode(graph?.modules.get("main.js"))).toBe(
    new TextDecoder().decode(source),
  );

  const grantCount = issued.length;
  const refused = createV2WorkerPublication({
    targetKey: execution.targetKey,
    publicationState: { resolve: async () => resolution },
    runtime,
    v2SqliteBinding: {
      address: "127.0.0.1:45231",
      issueGrant: () => {
        throw new Error("unresolved binding must not mint a grant");
      },
      resolveCurrentBinding: async () => null,
    },
  });
  expect(await refused.publish(execution)).toMatchObject({
    kind: "not_dispatched",
    code: "worker_material_unavailable",
  });
  expect(issued).toHaveLength(grantCount);
});
