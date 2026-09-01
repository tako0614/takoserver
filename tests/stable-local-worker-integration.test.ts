import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startStableLocalWorkerHost } from "../src/entry-stable-local-worker-host.ts";
import type {
  InstalledTakoformForm,
  TakoformDriverRelation,
  TakoformStoredResource,
} from "../src/takoform/types.ts";
import {
  createStableLocalWorkerComposition,
  loadProviderEraTestCatalog,
  type StableLocalWorkerComposition,
} from "../src/worker-stable-local-composition.ts";

const TAKOFORM_ROOT = resolve(import.meta.dir, "fixtures/takoform-v1");

let root: string;
let composition: StableLocalWorkerComposition | undefined;

afterEach(async () => {
  await composition?.dispose();
  composition = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("the disposable stable local catalog", () => {
  test("loads and byte-verifies all 31 externally supplied frozen Form packages", async () => {
    const catalog = await loadProviderEraTestCatalog(TAKOFORM_ROOT);

    expect(catalog.provenance).toEqual({
      classification: "external-unpublished-test-input",
      familyIndexSha256: "sha256:337a138c8d2561ade5b5ff44570c0d6a5543922f98d265c961874b06ef7ba703",
      suiteManifestSha256:
        "sha256:7f3547d976592c8b8e71eea20a0b9ba80c5e9aa8e649bb4943a1a155510c83f8",
      familyCount: 8,
      formCount: 31,
      bindingCount: 6,
      currentObjectBucketInstalled: false,
      currentEdgeObjectsInterfaceInstalled: false,
    });
    expect(new Set(catalog.forms.map((form) => exactRef(form))).size).toBe(31);
    expect(
      catalog.forms.filter(
        (form) => form.identity.formRef.apiVersion === "edge.forms.takoform.com",
      ),
    ).toHaveLength(16);
    expect(catalog.forms.some((form) => form.identity.formRef.kind === "ObjectBucket")).toBe(false);
  });

  test("fails closed when the exact frozen catalog input is absent", async () => {
    root = mkdtempSync(join(tmpdir(), "takoserver-stable-catalog-missing-"));
    await expect(loadProviderEraTestCatalog(root)).rejects.toThrow("frozen_stable_input_missing");
  });
});

describe("the disposable stable local network Host", () => {
  test("separates stable Host admission from the loopback diagnostic runtime", async () => {
    const host = await startStableLocalWorkerHost({
      takoformRepositoryRoot: TAKOFORM_ROOT,
      token: "stable-local-test-token",
    });
    try {
      const discovery = await fetch(`${host.endpoint}/.well-known/takoform/v1`);
      expect(discovery.status).toBe(200);
      expect(await discovery.json()).toEqual({
        api_versions: ["forms.takoform.com/v1"],
        features: {
          service_forms: true,
          exact_form_ref: true,
          optimistic_concurrency: true,
          idempotent_lifecycle: true,
          operations: true,
          artifact_upload: true,
          support_profiles: true,
        },
        endpoints: { api: `${host.endpoint}/apis/forms.takoform.com/v1` },
      });

      const unauthenticated = await fetch(
        `${host.endpoint}/apis/forms.takoform.com/v1/spaces/${host.space}/forms`,
      );
      expect(unauthenticated.status).toBe(401);

      const diagnostic = await fetch(`${host.diagnosticRuntimeEndpoint}/__takoform_v1_fetch_probe`);
      expect(diagnostic.status).toBe(409);
      expect(await diagnostic.text()).toBe(
        "stable local tracer requires exactly one published worker\n",
      );
      expect(host.classification).toBe("test-only-local-network-adapter");
    } finally {
      await host.close();
    }
  });
});

describe("the test-only stable worker runtime", () => {
  test("runs the exact stable fetch chain in the test runtime over real loopback HTTP", async () => {
    const nonce = crypto.randomUUID();
    const moduleBytes = new TextEncoder().encode(
      `export default { fetch(request) { const url = new URL(request.url); return Response.json({ nonce: ${JSON.stringify(
        nonce,
      )}, path: url.pathname }); } };`,
    );
    const local = await localComposition(moduleBytes);
    const resources = await applyWorkerChain(local);
    const endpoint = resources.endpoint.status.outputs as {
      hostname: string;
      url: string;
    };

    expect(endpoint.url).toBe(`https://${endpoint.hostname}/`);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => local.dispatch(endpoint.hostname, request),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/__takoform_v1_fetch_probe`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        nonce,
        path: "/__takoform_v1_fetch_probe",
      });
    } finally {
      server.stop(true);
    }
    expect(local.report()).toMatchObject({
      classification: "test-only",
      endpointAdmissionEvidence: false,
      runtimeBackendEvidence: false,
      publishedWorkers: 1,
    });
  });

  test("refuses an unsupported required external service before materializing a Worker Version", async () => {
    const local = await localComposition(
      new TextEncoder().encode("export default { fetch() { return new Response('no'); } }"),
    );
    const before = local.report();
    const worker = resource(local.form("ModuleWorker"), "worker", {});
    const bundle = resource(local.form("WorkerBundle"), "bundle", {
      manifestDigest: "sha256:manifest",
    });
    await local.driver.apply(applyInput(worker, []));

    const version = resource(local.form("WorkerVersion"), "version", {
      bundle: ref(bundle),
      handlers: ["fetch"],
      worker: ref(worker),
      externalServices: [
        {
          name: "ARCHIVE",
          service: {
            apiVersion: "standards.takoform.com/v1",
            protocol: "com.example.archive",
          },
        },
      ],
    });
    await expect(
      local.driver.apply(
        applyInput(version, [relation("/worker", worker), relation("/bundle", bundle)]),
      ),
    ).rejects.toMatchObject({ code: "unsupported_capability", status: 422 });
    expect(local.report()).toMatchObject({
      materializedVersions: before.materializedVersions,
      publishedWorkers: before.publishedWorkers,
    });
  });

  test("refuses a catalog that is not the verified external 31-Form tuple", async () => {
    const catalog = await loadProviderEraTestCatalog(TAKOFORM_ROOT);
    root = mkdtempSync(join(tmpdir(), "takoserver-stable-local-invalid-catalog-"));
    expect(() =>
      createStableLocalWorkerComposition({
        catalog: { ...catalog, forms: catalog.forms.slice(1) },
        artifacts: artifacts(new TextEncoder().encode("export default {}")),
        dataRoot: root,
      }),
    ).toThrow("stable_local_catalog_unverified");
  });
});

async function localComposition(moduleBytes: Uint8Array) {
  root = mkdtempSync(join(tmpdir(), "takoserver-stable-local-worker-"));
  composition = createStableLocalWorkerComposition({
    catalog: await loadProviderEraTestCatalog(TAKOFORM_ROOT),
    artifacts: artifacts(moduleBytes),
    dataRoot: root,
  });
  return composition;
}

function artifacts(moduleBytes: Uint8Array) {
  return {
    async resolveManifest(_tenantId: string, digest: string) {
      return digest === "sha256:manifest"
        ? {
            apiVersion: "artifacts.takoform.com/v1alpha1" as const,
            kind: "WorkerBundle" as const,
            mainModule: "worker.mjs",
            modules: [
              {
                name: "worker.mjs",
                mediaType: "application/javascript+module",
                size: moduleBytes.byteLength,
                digest: "sha256:module" as const,
              },
            ],
          }
        : null;
    },
    async resolveBlob(_tenantId: string, digest: string) {
      return digest === "sha256:module" ? moduleBytes : null;
    },
  };
}

async function applyWorkerChain(local: StableLocalWorkerComposition) {
  const worker = resource(local.form("ModuleWorker"), "worker", {});
  const bundle = resource(local.form("WorkerBundle"), "bundle", {
    manifestDigest: "sha256:manifest",
  });
  const version = resource(local.form("WorkerVersion"), "version", {
    bundle: ref(bundle),
    handlers: ["fetch"],
    worker: ref(worker),
  });
  const deployment = resource(local.form("WorkerDeployment"), "deployment", {
    worker: ref(worker),
    versions: [{ workerVersion: ref(version), weight: 10_000 }],
  });
  const endpoint = resource(local.form("WorkerEndpoint"), "endpoint", {
    worker: ref(worker),
  });

  await local.driver.apply(applyInput(worker, []));
  await local.driver.apply(applyInput(bundle, []));
  await local.driver.apply(
    applyInput(version, [relation("/worker", worker), relation("/bundle", bundle)]),
  );
  await local.driver.apply(
    applyInput(deployment, [
      relation("/worker", worker),
      relation("/versions/0/workerVersion", version),
    ]),
  );
  const endpointReceipt = await local.driver.apply(
    applyInput(endpoint, [relation("/worker", worker)]),
  );
  if (endpointReceipt.outputs) endpoint.status.outputs = endpointReceipt.outputs;
  return { worker, bundle, version, deployment, endpoint };
}

function applyInput(
  value: TakoformStoredResource,
  relations: readonly TakoformDriverRelation[],
  extras: Partial<Parameters<StableLocalWorkerComposition["driver"]["apply"]>[0]> = {},
): Parameters<StableLocalWorkerComposition["driver"]["apply"]>[0] {
  return {
    operationId: `op-${value.metadata.name}`,
    operationKey: extras.operationKey ?? `stable-local-${value.metadata.name}`,
    tenantId: "org_stable_local",
    resourceUid: value.metadata.uid,
    form: formOf(value),
    name: value.metadata.name,
    space: value.metadata.space,
    spec: value.spec,
    relations,
    ...extras,
  };
}

function relation(pointer: `/${string}`, value: TakoformStoredResource): TakoformDriverRelation {
  return {
    pointer,
    relation: pointer.replace(/\/\d+\//gu, "/*/") as `/${string}`,
    targetUid: value.metadata.uid,
    resource: value,
  };
}

function resource(
  form: InstalledTakoformForm,
  name: string,
  spec: Record<string, unknown>,
): TakoformStoredResource & { status: { outputs?: Record<string, unknown> } } {
  return {
    apiVersion: form.identity.formRef.apiVersion,
    kind: form.identity.formRef.kind,
    form: structuredClone(form.identity),
    metadata: {
      name,
      space: "default",
      uid: `uid-${name}`,
      generation: "1",
      revision: "1",
    },
    spec,
    status: {
      observedGeneration: "1",
      conditions: [
        {
          type: "Ready",
          status: "True",
          reason: "Available",
          lastTransitionTime: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
  } as TakoformStoredResource & {
    status: { outputs?: Record<string, unknown> };
  };
}

function ref(value: TakoformStoredResource) {
  return {
    apiVersion: value.apiVersion,
    kind: value.kind,
    name: value.metadata.name,
  };
}

function formOf(value: TakoformStoredResource): InstalledTakoformForm {
  return composition?.form(value.kind) as InstalledTakoformForm;
}

function exactRef(form: InstalledTakoformForm): string {
  const ref = form.identity.formRef;
  return [ref.apiVersion, ref.kind, ref.definitionVersion, ref.schemaDigest].join("\0");
}
