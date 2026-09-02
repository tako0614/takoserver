import { describe, expect, test } from "bun:test";
import { createCloudflareRuntimeBindingMaterializer } from "../src/cloudflare-runtime-binding-materializer.ts";
import { edgeProviderOffering } from "../src/edge-forms.ts";
import {
  createCatalog,
  createEphemeralSql,
  createLedger,
  createResourceDeploymentStore,
} from "../src/index.ts";
import { createProviderDriver } from "../src/provider-driver.ts";
import { createProviderPack, type RuntimeBindingMaterializer } from "../src/provider-pack.ts";
import type { ProviderRelation } from "../src/provider-port.ts";
import {
  canMaterializeAcrossProviderPacks,
  materializeProviderRuntimeBindings,
} from "../src/provider-runtime-bindings.ts";
import { CloudflareProvider } from "../src/providers/cloudflare.ts";
import {
  CLOUDFLARE_R2_EDGE_OBJECTS_MATERIAL_KIND,
  EDGE_OBJECTS_BINDING_REF,
} from "../src/providers/cloudflare-runtime-bindings.ts";
import { createRemoteProvider } from "../src/providers/remote.ts";
import { stableProductionTakoformCatalog } from "../src/takoform/stable-production-catalog.ts";

const TEST_MATERIAL_KIND = "test.target-object-capability@v1";
const sourceSpec = {
  bucketBindings: [
    {
      name: "OBJECTS",
      resource: {
        apiVersion: "edge.forms.takoform.com",
        kind: "ObjectBucket",
        name: "media",
      },
    },
  ],
} as const;

function relation(providerPackRef = "cloudflare"): ProviderRelation {
  const bucketName = `ts-${"a".repeat(40)}`;
  return {
    pointer: "/bucketBindings/0/resource",
    relation: "/bucketBindings/*/resource",
    targetUid: "uid-bucket",
    bindingRef: EDGE_OBJECTS_BINDING_REF,
    resource: {
      apiVersion: "edge.forms.takoform.com",
      kind: "ObjectBucket",
      form: {
        formRef: {
          apiVersion: "edge.forms.takoform.com",
          kind: "ObjectBucket",
          definitionVersion: "0.1.0",
          schemaDigest: `sha256:${"a".repeat(64)}`,
        },
      },
      metadata: {
        name: "media",
        space: "default",
        uid: "uid-bucket",
        generation: "1",
        revision: "1",
      },
      spec: {},
    },
    deployment: {
      tenantId: "org-test",
      id: "dep-bucket",
      resourceUid: "uid-bucket",
      offeringId: "storage.object.cloudflare",
      providerPackRef,
      providerInstallationRef: `${providerPackRef}.primary`,
      nativeId: providerPackRef === "cloudflare" ? `r2:${bucketName}` : "native:bucket",
      state: "active",
      observed: {},
      outputs: providerPackRef === "cloudflare" ? { bucketName } : {},
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  };
}

function route(materialKind = TEST_MATERIAL_KIND) {
  return { bindingRef: EDGE_OBJECTS_BINDING_REF, materialKind } as const;
}

function pack(id: string, runtimeBindingMaterializer?: RuntimeBindingMaterializer) {
  return createProviderPack({
    id,
    providerType: id,
    provisioners: [],
    attachmentFactories: [],
    transferEndpoints: [],
    credentialIssuers: [],
    meterSources: [],
    costEstimators: [],
    ...(runtimeBindingMaterializer ? { runtimeBindingMaterializer } : {}),
  });
}

function completeMaterializer(id: string, calls: string[] = []): RuntimeBindingMaterializer {
  return {
    id: `${id}-runtime-bindings`,
    exporter: {
      routes: [route()],
      async exportTarget({ route: selected }) {
        calls.push(`${id}.export`);
        return selected.materialKind === TEST_MATERIAL_KIND
          ? Object.freeze({ opaque: `${id}-target-capability` })
          : null;
      },
    },
    importer: {
      routes: [route()],
      async importBinding({ route: selected, exported }) {
        calls.push(`${id}.import`);
        return selected.materialKind === TEST_MATERIAL_KIND && exported.providerPackRef === id
          ? { kind: "private-test" }
          : null;
      },
    },
  };
}

const baseInput = {
  tenantId: "org-test",
  source: { tenantRef: "org-test", space: "default", name: "version", uid: "uid-version" },
  sourceSpec,
} as const;

describe("provider-private runtime Binding materialization", () => {
  test("requires matching exporter and importer routes even inside one Provider Pack", async () => {
    const calls: string[] = [];
    const complete = pack("complete", completeMaterializer("complete", calls));

    expect(
      canMaterializeAcrossProviderPacks({
        bindingRef: EDGE_OBJECTS_BINDING_REF,
        consumerPack: complete,
        targetPack: complete,
      }),
    ).toBe(true);
    const bindings = await materializeProviderRuntimeBindings({
      ...baseInput,
      consumerPack: complete,
      packs: new Map([[complete.id, complete]]),
      relations: [relation("complete")],
    });

    expect(calls).toEqual(["complete.export", "complete.import"]);
    expect(bindings).toEqual([
      {
        name: "OBJECTS",
        targetUid: "uid-bucket",
        bindingRef: EDGE_OBJECTS_BINDING_REF,
        material: { kind: "private-test" },
      },
    ]);
  });

  test("crosses Provider Packs only through one exact binding and material-kind route", async () => {
    const calls: string[] = [];
    const exporter = pack("target", {
      id: "target-runtime-bindings",
      exporter: {
        routes: [route()],
        async exportTarget() {
          calls.push("target.export");
          return Object.freeze({ opaque: "target-capability" });
        },
      },
    });
    const importer = pack("consumer", {
      id: "consumer-runtime-bindings",
      importer: {
        routes: [route()],
        async importBinding({ route: selected, exported }) {
          calls.push("consumer.import");
          return selected.materialKind === TEST_MATERIAL_KIND &&
            exported.providerPackRef === "target"
            ? { kind: "private-test" }
            : null;
        },
      },
    });

    expect(
      canMaterializeAcrossProviderPacks({
        bindingRef: EDGE_OBJECTS_BINDING_REF,
        consumerPack: importer,
        targetPack: exporter,
      }),
    ).toBe(true);
    const bindings = await materializeProviderRuntimeBindings({
      ...baseInput,
      consumerPack: importer,
      packs: new Map([
        [importer.id, importer],
        [exporter.id, exporter],
      ]),
      relations: [relation("target")],
    });
    expect(calls).toEqual(["target.export", "consumer.import"]);
    expect(bindings[0]?.material).toEqual({ kind: "private-test" });
  });

  test("rejects material-kind mismatch and same-pack directional omission with 422", async () => {
    const exporterOnly = pack("target", {
      id: "target-runtime-bindings",
      exporter: {
        routes: [route("test.export@v1")],
        async exportTarget() {
          return Object.freeze({ opaque: true });
        },
      },
    });
    const mismatchedImporter = pack("consumer", {
      id: "consumer-runtime-bindings",
      importer: {
        routes: [route("test.import@v1")],
        async importBinding() {
          return { kind: "must-not-run" };
        },
      },
    });

    expect(
      canMaterializeAcrossProviderPacks({
        bindingRef: EDGE_OBJECTS_BINDING_REF,
        consumerPack: mismatchedImporter,
        targetPack: exporterOnly,
      }),
    ).toBe(false);
    await expect(
      materializeProviderRuntimeBindings({
        ...baseInput,
        consumerPack: mismatchedImporter,
        packs: new Map([
          [mismatchedImporter.id, mismatchedImporter],
          [exporterOnly.id, exporterOnly],
        ]),
        relations: [relation("target")],
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability", status: 422 });

    await expect(
      materializeProviderRuntimeBindings({
        ...baseInput,
        consumerPack: exporterOnly,
        packs: new Map([[exporterOnly.id, exporterOnly]]),
        relations: [relation("target")],
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability", status: 422 });
  });

  test("Cloudflare exports and imports R2 on one route (ADR 0007)", async () => {
    const cloudflare = pack("cloudflare", createCloudflareRuntimeBindingMaterializer("cloudflare"));
    const materializer = cloudflare.runtimeBindingMaterializer;
    const expected = [
      {
        bindingRef: EDGE_OBJECTS_BINDING_REF,
        materialKind: CLOUDFLARE_R2_EDGE_OBJECTS_MATERIAL_KIND,
      },
    ];

    expect(materializer?.exporter?.routes).toEqual(expected);
    expect(materializer?.importer?.routes).toEqual(expected);
    expect(
      canMaterializeAcrossProviderPacks({
        bindingRef: EDGE_OBJECTS_BINDING_REF,
        consumerPack: cloudflare,
        targetPack: cloudflare,
      }),
    ).toBe(true);
    const bindings = await materializeProviderRuntimeBindings({
      ...baseInput,
      consumerPack: cloudflare,
      packs: new Map([[cloudflare.id, cloudflare]]),
      relations: [relation()],
    });
    expect(bindings).toEqual([
      {
        name: "OBJECTS",
        targetUid: "uid-bucket",
        bindingRef: EDGE_OBJECTS_BINDING_REF,
        material: {
          kind: CLOUDFLARE_R2_EDGE_OBJECTS_MATERIAL_KIND,
          bucketName: `ts-${"a".repeat(40)}`,
        },
      },
    ]);
  });

  test("refuses to import an edge.objects capability this Cloudflare pack did not export", async () => {
    const cloudflare = pack("cloudflare", createCloudflareRuntimeBindingMaterializer("cloudflare"));
    // A foreign pack that claims the same Binding and material kind still
    // cannot mint the private export token, so the import returns null and the
    // driver refuses before any provider mutation.
    const forger = pack("forger", {
      id: "forger-runtime-bindings",
      exporter: {
        routes: [
          {
            bindingRef: EDGE_OBJECTS_BINDING_REF,
            materialKind: CLOUDFLARE_R2_EDGE_OBJECTS_MATERIAL_KIND,
          },
        ],
        async exportTarget() {
          return Object.freeze({
            providerPackRef: "cloudflare",
            bucketName: `ts-${"a".repeat(40)}`,
          });
        },
      },
    });
    await expect(
      materializeProviderRuntimeBindings({
        ...baseInput,
        consumerPack: cloudflare,
        packs: new Map([
          [cloudflare.id, cloudflare],
          [forger.id, forger],
        ]),
        relations: [relation("forger")],
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability", status: 422 });
  });

  test("refuses to export a bucket Deployment whose native identity disagrees", async () => {
    const cloudflare = pack("cloudflare", createCloudflareRuntimeBindingMaterializer("cloudflare"));
    const drifted = relation();
    await expect(
      materializeProviderRuntimeBindings({
        ...baseInput,
        consumerPack: cloudflare,
        packs: new Map([[cloudflare.id, cloudflare]]),
        relations: [
          {
            ...drifted,
            deployment: {
              ...(drifted.deployment as NonNullable<ProviderRelation["deployment"]>),
              nativeId: `r2:ts-${"b".repeat(40)}`,
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability", status: 422 });
  });

  test("a remote-style pack without sideband materializer routes fails before provider mutation", async () => {
    const remote = pack("remote");
    await expect(
      materializeProviderRuntimeBindings({
        ...baseInput,
        consumerPack: remote,
        packs: new Map([[remote.id, remote]]),
        relations: [relation("remote")],
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability", status: 422 });
  });

  test("the Provider driver returns 422 before a remote provisioner RPC when sideband is absent", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-09-01T00:00:00.000Z");
    const deployments = createResourceDeploymentStore(sql, clock);
    const forms = stableProductionTakoformCatalog().forms;
    const worker = forms.find((form) => form.identity.formRef.kind === "ModuleWorker");
    const version = forms.find((form) => form.identity.formRef.kind === "WorkerVersion");
    const bucket = forms.find((form) => form.identity.formRef.kind === "ObjectBucket");
    if (!worker || !version || !bucket) throw new Error("stable runtime Binding fixtures missing");
    const versionOffering = edgeProviderOffering(version, { id: "remote.worker-version" });
    let remoteCalls = 0;
    const remote = createRemoteProvider({
      id: "remote",
      origin: "https://provisioner.test",
      offerings: [versionOffering],
      authorize: () => "Bearer provider-private",
      async fetch() {
        remoteCalls += 1;
        return Response.json({ ticket: { phase: "failed", failure: { code: "invalid_spec" } } });
      },
    });
    const remotePack = createProviderPack({
      id: remote.id,
      providerType: "remote",
      provisioners: [remote],
      attachmentFactories: [],
      transferEndpoints: [],
      credentialIssuers: [],
      meterSources: [],
      costEstimators: [],
    });
    await deployments.create({
      tenantId: "org-remote",
      id: "dep-worker",
      resourceUid: "uid-worker",
      offeringId: "remote.module-worker",
      providerPackRef: remote.id,
      providerInstallationRef: "remote.primary",
      nativeId: "worker:remote",
      state: "active",
      observed: {},
      outputs: {},
    });
    await deployments.create({
      tenantId: "org-remote",
      id: "dep-bucket",
      resourceUid: "uid-bucket",
      offeringId: "remote.object-bucket",
      providerPackRef: remote.id,
      providerInstallationRef: "remote.primary",
      nativeId: "bucket:remote",
      state: "active",
      observed: {},
      outputs: {},
    });
    const resource = (form: typeof worker, name: string, uid: string) => ({
      apiVersion: form.identity.formRef.apiVersion,
      kind: form.identity.formRef.kind,
      form: form.identity,
      metadata: {
        name,
        space: "default",
        uid,
        generation: "1",
        revision: "1",
      },
      spec: {},
      status: { observedGeneration: "1", conditions: [] },
    });
    const driver = createProviderDriver({
      providers: [remote],
      providerPacks: [remotePack],
      catalog: createCatalog([]),
      ledger: createLedger(sql, clock),
      deployments,
    });

    await expect(
      driver.apply({
        operationId: "op-remote-version",
        operationKey: "key-remote-version",
        tenantId: "org-remote",
        resourceUid: "uid-version",
        form: version,
        name: "version",
        space: "default",
        spec: {
          bucketBindings: [
            {
              name: "OBJECTS",
              resource: {
                apiVersion: bucket.identity.formRef.apiVersion,
                kind: bucket.identity.formRef.kind,
                name: "media",
              },
            },
          ],
        },
        relations: [
          {
            pointer: "/worker",
            relation: "/worker",
            targetUid: "uid-worker",
            resource: resource(worker, "worker", "uid-worker"),
          },
          {
            pointer: "/bucketBindings/0/resource",
            relation: "/bucketBindings/*/resource",
            targetUid: "uid-bucket",
            resource: resource(bucket, "media", "uid-bucket"),
            bindingRef: EDGE_OBJECTS_BINDING_REF,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability", status: 422 });
    expect(remoteCalls).toBe(0);
    expect(await deployments.active("org-remote", "uid-version")).toBeNull();
  });

  /**
   * The whole chain in one place: a Host relation with a Binding, an already
   * realized bucket Deployment, the Cloudflare pack materializing it, and the
   * ordinary-workers backend turning it into the upload. Each half is unit
   * tested elsewhere; this proves they meet.
   */
  test("materializes a Cloudflare bucket relation into the Worker Version upload", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-09-01T00:00:00.000Z");
    const deployments = createResourceDeploymentStore(sql, clock);
    const forms = stableProductionTakoformCatalog().forms;
    const worker = forms.find((form) => form.identity.formRef.kind === "ModuleWorker");
    const version = forms.find((form) => form.identity.formRef.kind === "WorkerVersion");
    const bundleForm = forms.find((form) => form.identity.formRef.kind === "WorkerBundle");
    const bucket = forms.find((form) => form.identity.formRef.kind === "ObjectBucket");
    if (!worker || !version || !bundleForm || !bucket) {
      throw new Error("stable runtime Binding fixtures missing");
    }
    const bucketName = `ts-${"a".repeat(40)}`;
    const manifestDigest = `sha256:${"d".repeat(64)}`;
    const moduleDigest = `sha256:${"e".repeat(64)}`;
    const uploads: string[] = [];
    const cloudflare = new CloudflareProvider({
      accountId: "acct_1",
      offerings: [edgeProviderOffering(version, { id: "cloudflare.edge.stable-v1.workerversion" })],
      authorize: () => "Bearer secret-account-token",
      apiOrigin: "https://api.cloudflare.test/client/v4",
      artifacts: {
        async manifest(_tenant, digest) {
          return digest === manifestDigest
            ? {
                kind: "WorkerBundle" as const,
                mainModule: "index.js",
                modules: [
                  {
                    name: "index.js",
                    mediaType: "application/javascript+module",
                    digest: moduleDigest,
                  },
                ],
              }
            : null;
        },
        async blob(digest) {
          return digest === moduleDigest ? new TextEncoder().encode("export default {}") : null;
        },
      },
      async fetch(request) {
        uploads.push(await request.clone().text());
        return Response.json({ success: true, errors: [], result: { id: "version-chain" } });
      },
    });
    const cloudflarePack = createProviderPack({
      id: cloudflare.id,
      providerType: "cloudflare",
      provisioners: [cloudflare],
      attachmentFactories: [],
      transferEndpoints: [],
      credentialIssuers: [],
      meterSources: [],
      costEstimators: [],
      runtimeBindingMaterializer: createCloudflareRuntimeBindingMaterializer(cloudflare.id),
    });
    for (const entry of [
      {
        id: "dep-worker",
        resourceUid: "uid-worker",
        offeringId: "cloudflare.edge.stable-v1.moduleworker",
        nativeId: "worker:script-name",
        outputs: { scriptName: "script-name" },
      },
      {
        id: "dep-bucket",
        resourceUid: "uid-bucket",
        offeringId: "storage.object.standard",
        nativeId: `r2:${bucketName}`,
        outputs: { protocol: "s3", bucketName },
      },
    ]) {
      await deployments.create({
        tenantId: "org-chain",
        providerPackRef: cloudflare.id,
        providerInstallationRef: "cloudflare.primary",
        state: "active",
        observed: {},
        ...entry,
      });
    }
    const resource = (form: typeof worker, name: string, uid: string, spec = {}) => ({
      apiVersion: form.identity.formRef.apiVersion,
      kind: form.identity.formRef.kind,
      form: form.identity,
      metadata: { name, space: "default", uid, generation: "1", revision: "1" },
      spec,
      status: { observedGeneration: "1", conditions: [] },
    });
    const driver = createProviderDriver({
      providers: [cloudflare],
      providerPacks: [cloudflarePack],
      catalog: createCatalog([]),
      ledger: createLedger(sql, clock),
      deployments,
    });

    const applied = await driver.apply({
      operationId: "op-chain-version",
      operationKey: "key-chain-version",
      operationMode: "initial",
      tenantId: "org-chain",
      resourceUid: "uid-version",
      form: version,
      name: "version",
      space: "default",
      spec: {
        handlers: ["fetch"],
        bucketBindings: [
          {
            name: "MEDIA",
            resource: {
              apiVersion: bucket.identity.formRef.apiVersion,
              kind: bucket.identity.formRef.kind,
              name: "media",
            },
          },
        ],
      },
      relations: [
        {
          pointer: "/worker",
          relation: "/worker",
          targetUid: "uid-worker",
          resource: resource(worker, "worker", "uid-worker"),
        },
        {
          pointer: "/bundle",
          relation: "/bundle",
          targetUid: "uid-bundle",
          resource: resource(bundleForm, "bundle", "uid-bundle", { manifestDigest }),
        },
        {
          pointer: "/bucketBindings/0/resource",
          relation: "/bucketBindings/*/resource",
          targetUid: "uid-bucket",
          resource: resource(bucket, "media", "uid-bucket"),
          bindingRef: EDGE_OBJECTS_BINDING_REF,
        },
      ],
    });

    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toContain(
      `{"type":"r2_bucket","name":"MEDIA","bucket_name":"${bucketName}"}`,
    );
    expect(await deployments.active("org-chain", "uid-version")).toMatchObject({
      state: "active",
      nativeId: "version:script-name:version-chain",
    });
    // The receipt the Host records names no provider bucket.
    expect(JSON.stringify(applied)).not.toContain(bucketName);
  });
});
