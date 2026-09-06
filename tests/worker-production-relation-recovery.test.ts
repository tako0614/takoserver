import { describe, expect, test } from "bun:test";
import { createCatalog } from "../src/catalog.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { buildEdgeForms } from "../src/edge-forms.ts";
import type { HostedEdgeSupplies } from "../src/hosted-edge-supplies.ts";
import { createLedger } from "../src/ledger.ts";
import type { JsonObject } from "../src/ports.ts";
import { createProviderDriver } from "../src/provider-driver.ts";
import type {
  ProviderArtifactConsumptionInput,
  ProviderNativeAbsence,
  ProviderOffering,
} from "../src/provider-port.ts";
import { CloudflareProvider } from "../src/providers/cloudflare.ts";
import type { CloudflareProviderExecutorRpc } from "../src/providers/cloudflare-provider-executor-rpc.ts";
import { ManagedWorkerState } from "../src/providers/managed-worker-state.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import { stableProductionTakoformCatalog } from "../src/takoform/stable-production-catalog.ts";
import { createTakoformStore } from "../src/takoform/store.ts";
import type { InstalledTakoformForm } from "../src/takoform/types.ts";
import { createWorkerProductionComposition } from "../src/worker-production-composition.ts";
import { edgeSuppliesFixture } from "./helpers/hosted-supply-fixtures.ts";

const NOW = new Date("2026-09-06T10:00:00.000Z");
const RELATION_OFFERING_ID = "cloudflare.edge.stable-v1.workerversion";
const INSTALLATION_ID = "cloudflare.staging";
const WFP_DESCRIPTOR_DIGEST = `sha256:${"c".repeat(64)}` as const;
const WFP_MANIFEST_DIGEST = `sha256:${"d".repeat(64)}` as const;
const WFP_NATIVE_ID = `version:logical-worker:tsr-${WFP_DESCRIPTOR_DIGEST.slice("sha256:".length)}`;

describe("Worker production retained relation recovery", () => {
  test("uses the exact composed technical relation authority for native absence readback", async () => {
    const { calls, composition, driver, input, version } = await retainedRelationFixture({
      proof: { outcome: "absent", evidence: { provider: "fixture" } },
    });
    const retail = createCatalog(composition.offerings);
    expect(retail.list().some((offering) => offering.id === RELATION_OFFERING_ID)).toBe(false);
    expect(retail.findOffering(RELATION_OFFERING_ID)).toBeUndefined();
    expect(retail.offeringsFor(version.identity.formRef)).toEqual([]);
    expect(await driver.verifyNativeAbsence?.(input)).toMatchObject({
      status: "absent",
      source: "provider",
      effectCount: 3,
      deploymentCount: 1,
    });
    expect(calls).toEqual([
      expect.objectContaining({
        offering: expect.objectContaining({
          id: RELATION_OFFERING_ID,
          form: version.identity.formRef,
        }),
        descriptor: expect.objectContaining({
          provider: "cloudflare",
          kind: "WorkerVersion",
          nativeId: "version:logical-worker:version-id",
          data: { resourceUid: input.resourceUid },
        }),
        target: {
          tenantId: input.tenantId,
          resourceUid: input.resourceUid,
          incarnationId: "dep_relation_version",
          generation: "1",
        },
      }),
    ]);
  });

  test("preserves a positive native presence result for the exact relation tuple", async () => {
    const { calls, driver, input } = await retainedRelationFixture({
      proof: { outcome: "present", evidence: { provider: "fixture" } },
    });
    expect(await driver.verifyNativeAbsence?.(input)).toMatchObject({
      status: "present",
      source: "provider",
      effectCount: 3,
      deploymentCount: 1,
    });
    expect(calls).toHaveLength(1);
  });

  test("refuses a current WfP namespace read without exact managed-release provenance", async () => {
    const fixture = await retainedRelationFixture();
    const wfp = wfpReadbackFixture(fixture, 404);

    expect(await wfp.driver.verifyNativeAbsence?.(fixture.input)).toMatchObject({
      status: "indeterminate",
      source: "provider",
      reason: "provider_readback_failed",
    });
    expect(
      await wfp.provider.verifyArtifactConsumption?.(
        artifactConsumptionInput(fixture, wfp.offering),
      ),
    ).toEqual({ outcome: "unknown", reason: "authority_unavailable", retryable: false });
    expect(wfp.namespaceReads()).toBe(0);
  });

  test("reads a WfP version only behind an exact stable managed receipt", async () => {
    for (const [receiptState, providerStatus, expectedAbsence, expectedConsumption] of [
      ["committed", 404, "absent", "absent"],
      ["committed", 200, "present", "identified"],
      ["deleted", 404, "absent", "absent"],
      ["deleted", 200, "present", "authority_unavailable"],
      ["committed", "metadata-null", "absent", "absent"],
      ["deleted", "metadata-null", "absent", "absent"],
    ] as const) {
      const fixture = await retainedRelationFixture({ nativeId: WFP_NATIVE_ID });
      await seedManagedVersionReceipt(fixture, receiptState);
      const wfp = wfpReadbackFixture(fixture, providerStatus);

      expect(await wfp.driver.verifyNativeAbsence?.(fixture.input)).toMatchObject({
        status: expectedAbsence,
        source: "provider",
      });
      const consumption = await wfp.provider.verifyArtifactConsumption?.(
        artifactConsumptionInput(fixture, wfp.offering),
      );
      const consumptionSummary =
        consumption?.outcome === "present"
          ? consumption.consumption
          : consumption?.outcome === "unknown"
            ? consumption.reason
            : consumption?.outcome;
      expect(consumptionSummary).toBe(expectedConsumption);
      expect(wfp.namespaceReads()).toBe(providerStatus === "metadata-null" ? 4 : 2);
    }
  });

  test("refuses mismatched and transitional managed receipts before a WfP read", async () => {
    for (const receiptCase of [
      "native-mismatch",
      "parent-mismatch",
      "pending",
      "deleting",
      "corrupt",
    ] as const) {
      const fixture = await retainedRelationFixture({ nativeId: WFP_NATIVE_ID });
      await seedManagedVersionReceipt(
        fixture,
        receiptCase === "deleting" || receiptCase === "corrupt"
          ? "deleting"
          : receiptCase === "pending"
            ? "pending"
            : "committed",
        receiptCase,
      );
      const wfp = wfpReadbackFixture(fixture, 404);

      expect(await wfp.driver.verifyNativeAbsence?.(fixture.input)).toMatchObject({
        status: "indeterminate",
        source: "provider",
        reason: "provider_readback_failed",
      });
      expect(
        await wfp.provider.verifyArtifactConsumption?.(
          artifactConsumptionInput(fixture, wfp.offering),
        ),
      ).toMatchObject({ outcome: "unknown" });
      expect(wfp.namespaceReads()).toBe(0);
    }
  });

  test("refuses mismatched offering, installation, and Form identities before provider readback", async () => {
    const current = stableProductionTakoformCatalog();
    const deploymentForm = current.forms.find(
      (form) => form.identity.formRef.kind === "WorkerDeployment",
    );
    if (!deploymentForm) throw new Error("stable WorkerDeployment fixture is unavailable");
    for (const options of [
      { offeringId: "cloudflare.edge.stable-v1.workerdeployment" },
      { installationId: "cloudflare.other" },
      { form: deploymentForm },
    ]) {
      const { calls, driver, input } = await retainedRelationFixture(options);
      expect(await driver.verifyNativeAbsence?.(input)).toMatchObject({
        status: "indeterminate",
        source: "provider",
        reason: "provider_unavailable",
      });
      expect(calls).toEqual([]);
    }
  });

  test("keeps current and retained Form identities as distinct readback authorities", async () => {
    const retained = await buildEdgeForms();
    const currentVersion = stableProductionTakoformCatalog().forms.find(
      (form) => form.identity.formRef.kind === "WorkerVersion",
    );
    const historicalVersion = retained.forms.find(
      (form) => form.identity.formRef.kind === "WorkerVersion",
    );
    if (!currentVersion || !historicalVersion) {
      throw new Error("current and retained WorkerVersion fixtures are required");
    }
    expect(historicalVersion.identity.formRef).not.toEqual(currentVersion.identity.formRef);

    const historical = await retainedRelationFixture({
      retainedForms: retained.forms,
      form: historicalVersion,
      offeringId: "cloudflare.edge.workerversion",
    });
    expect(await historical.driver.verifyNativeAbsence?.(historical.input)).toMatchObject({
      status: "absent",
      source: "provider",
    });
    expect(historical.calls).toHaveLength(1);

    const crossed = await retainedRelationFixture({
      retainedForms: retained.forms,
      form: historicalVersion,
      offeringId: RELATION_OFFERING_ID,
    });
    expect(await crossed.driver.verifyNativeAbsence?.(crossed.input)).toMatchObject({
      status: "indeterminate",
      reason: "provider_unavailable",
    });
    expect(crossed.calls).toEqual([]);

    const reverseCrossed = await retainedRelationFixture({
      retainedForms: retained.forms,
      form: currentVersion,
      offeringId: "cloudflare.edge.workerversion",
    });
    expect(await reverseCrossed.driver.verifyNativeAbsence?.(reverseCrossed.input)).toMatchObject({
      status: "indeterminate",
      reason: "provider_unavailable",
    });
    expect(reverseCrossed.calls).toEqual([]);
  });

  test("does not turn retained readback authority into an independent create path", async () => {
    const { calls, driver, input, version } = await retainedRelationFixture();
    await expect(
      driver.apply({
        operationId: "op_independent_relation_create",
        operationKey: "key_independent_relation_create",
        executionAuthority: {
          tenantId: input.tenantId,
          resourceUid: "uid_independent_relation",
          leaseToken: "lease_independent_relation",
          fingerprint: "fingerprint_independent_relation",
        },
        tenantId: input.tenantId,
        resourceUid: "uid_independent_relation",
        form: version,
        name: "independent-version",
        space: "default",
        spec: {},
        relations: [],
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability", status: 422 });
    expect(calls).toEqual([]);
  });

  test("requires a closed tombstone and valid Host deployment provenance", async () => {
    for (const options of [
      { tombstone: "missing" as const },
      { outputs: {} },
      {
        outputs: {
          __takoserver: {
            resourceUid: "uid_relation_version",
            space: "default",
            name: "retained-version",
            generation: "not-a-generation",
          },
        },
      },
    ]) {
      const { calls, driver, input } = await retainedRelationFixture(options);
      expect(await driver.verifyNativeAbsence?.(input)).toMatchObject({
        status: "indeterminate",
        source: "provider",
        reason: options.tombstone === "missing" ? "legacy_unattested" : "deployment_unmarked",
      });
      expect(calls).toEqual([]);
    }
  });

  test("rejects malformed or address-mismatched deletion FormRef provenance", async () => {
    const differentAddressForm = stableProductionTakoformCatalog().forms.find(
      (form) => form.identity.formRef.kind === "WorkerDeployment",
    );
    if (!differentAddressForm) throw new Error("stable WorkerDeployment fixture is unavailable");
    for (const storedFormRefJson of [
      JSON.stringify({}),
      JSON.stringify(differentAddressForm.identity.formRef),
    ]) {
      const { calls, driver, input } = await retainedRelationFixture({ storedFormRefJson });
      await expect(driver.verifyNativeAbsence?.(input)).rejects.toMatchObject({
        code: "backend_unavailable",
        status: 503,
      });
      expect(calls).toEqual([]);
    }
  });

  test("refuses an inactive supply contract before exposing readback authority", () => {
    const current = stableProductionTakoformCatalog();
    const calls: unknown[] = [];
    const supplies = edgeSuppliesFixture();
    expect(() =>
      createWorkerProductionComposition({
        env: {
          TAKOSERVER_EDGE_SUPPLIES: JSON.stringify({
            ...supplies,
            supplyContract: {
              ...supplies.supplyContract,
              validUntil: "2026-09-06T09:59:59.999Z",
            },
          }),
          TAKOSERVER_MANAGED_BASE_DOMAIN: "workers.example.test",
          CLOUDFLARE_PROVIDER_EXECUTOR: executorBinding(async (input) => {
            calls.push(input);
            return { outcome: "absent", evidence: { provider: "fixture" } };
          }),
        },
        forms: current.forms,
        now: NOW,
      }),
    ).toThrow("supply_contract_inactive");
    expect(calls).toEqual([]);
  });

  test("does not infer WorkerVersion readback authority from an unrelated logical supply", async () => {
    const supplies = edgeSuppliesFixture();
    const sqliteOnly: HostedEdgeSupplies = {
      ...supplies,
      supplyContract: {
        ...supplies.supplyContract,
        permittedResourceClasses: ["database.sqlite"],
      },
      offerings: supplies.offerings.filter((offering) => offering.formKind === "SQLiteDatabase"),
    };
    const { calls, composition, driver, input } = await retainedRelationFixture({
      edgeSupplies: sqliteOnly,
    });
    expect(
      composition.providers[0]?.offerings.some((offering) => offering.id === RELATION_OFFERING_ID),
    ).toBe(true);
    expect(
      composition.providers[0]?.nativeReadbackAuthorities?.some(
        (authority) => authority.offeringId === RELATION_OFFERING_ID,
      ),
    ).toBe(false);
    expect(await driver.verifyNativeAbsence?.(input)).toMatchObject({
      status: "indeterminate",
      source: "provider",
      reason: "provider_unavailable",
    });
    expect(calls).toEqual([]);
  });

  test("requires both logical anchors for QueueConsumer readback authority", () => {
    const supplies = edgeSuppliesFixture();
    const current = stableProductionTakoformCatalog();
    const relationOfferingId = "cloudflare.edge.stable-v1.queueconsumer";
    for (const [formKinds, permittedResourceClasses, expected] of [
      [["ModuleWorker"], ["compute.edge"], false],
      [["AtLeastOnceQueue"], ["messaging.queue"], false],
      [["ModuleWorker", "AtLeastOnceQueue"], ["compute.edge", "messaging.queue"], true],
    ] as const) {
      const selected: HostedEdgeSupplies = {
        ...supplies,
        supplyContract: {
          ...supplies.supplyContract,
          permittedResourceClasses: [...permittedResourceClasses],
        },
        offerings: supplies.offerings.filter((offering) =>
          formKinds.some((kind) => kind === offering.formKind),
        ),
      };
      const composition = createWorkerProductionComposition({
        env: {
          TAKOSERVER_EDGE_SUPPLIES: JSON.stringify(selected),
          TAKOSERVER_MANAGED_BASE_DOMAIN: "workers.example.test",
          CLOUDFLARE_PROVIDER_EXECUTOR: executorBinding(async () => ({
            outcome: "absent",
            evidence: { provider: "fixture" },
          })),
        },
        forms: current.forms,
        now: NOW,
      });
      expect(
        composition.providers[0]?.nativeReadbackAuthorities?.some(
          (authority) => authority.offeringId === relationOfferingId,
        ),
      ).toBe(expected);
    }
  });
});

function executorBinding(
  verifyNativeAbsence: (
    input: Parameters<CloudflareProviderExecutorRpc["verifyNativeAbsence"]>[0],
  ) => Promise<ProviderNativeAbsence>,
): CloudflareProviderExecutorRpc {
  return { verifyNativeAbsence } as CloudflareProviderExecutorRpc;
}

async function retainedRelationFixture(
  options: {
    readonly proof?: ProviderNativeAbsence;
    readonly offeringId?: string;
    readonly installationId?: string;
    readonly nativeId?: string;
    readonly form?: InstalledTakoformForm;
    readonly outputs?: JsonObject;
    readonly storedFormRefJson?: string;
    readonly tombstone?: "closed" | "missing";
    readonly retainedForms?: readonly InstalledTakoformForm[];
    readonly edgeSupplies?: HostedEdgeSupplies;
  } = {},
) {
  const proof = options.proof ?? { outcome: "absent", evidence: { provider: "fixture" } };
  const calls: Parameters<CloudflareProviderExecutorRpc["verifyNativeAbsence"]>[0][] = [];
  const binding = executorBinding(async (input) => {
    calls.push(structuredClone(input));
    return proof;
  });
  const current = stableProductionTakoformCatalog();
  const version =
    options.form ??
    current.forms.find(
      (form) =>
        form.identity.formRef.apiVersion === "edge.forms.takoform.com" &&
        form.identity.formRef.kind === "WorkerVersion",
    );
  if (!version) throw new Error("stable WorkerVersion fixture is unavailable");
  const composition = createWorkerProductionComposition({
    env: {
      TAKOSERVER_EDGE_SUPPLIES: JSON.stringify(options.edgeSupplies ?? edgeSuppliesFixture()),
      TAKOSERVER_MANAGED_BASE_DOMAIN: "workers.example.test",
      CLOUDFLARE_PROVIDER_EXECUTOR: binding,
    },
    forms: current.forms,
    ...(options.retainedForms ? { retainedForms: options.retainedForms } : {}),
    now: NOW,
  });
  const sql = createEphemeralSql();
  const clock = () => new Date(NOW);
  const deployments = createResourceDeploymentStore(sql, clock);
  const deletions = createTakoformStore(sql, clock);
  const tenantId = "org_relation_recovery";
  const resourceUid = "uid_relation_version";
  const operationId = "op_relation_version_delete";
  const name = "retained-version";
  const installationId = options.installationId ?? INSTALLATION_ID;
  const nativeId = options.nativeId ?? "version:logical-worker:version-id";
  if (options.tombstone !== "missing") {
    await deletions.prepareResourceDeletion({
      tenantId,
      resourceUid,
      address: {
        tenantId,
        space: "default",
        apiVersion: version.identity.formRef.apiVersion,
        kind: version.identity.formRef.kind,
        name,
      },
      formRef: version.identity.formRef,
      operationId,
    });
    for (const phase of ["dispatched", "succeeded"] as const) {
      await deletions.recordResourceEffect({
        tenantId,
        resourceUid,
        effectId: operationId,
        kind: "delete",
        phase,
        operationMode: "initial",
        providerPackRef: "cloudflare",
        providerInstallationRef: installationId,
        nativeId,
      });
    }
    await sql.run(
      `UPDATE tf_resource_deletion_attestations
       SET state = 'closed', updated_at = ?
       WHERE tenant_id = ? AND resource_uid = ?`,
      [clock().getTime(), tenantId, resourceUid],
    );
    if (options.storedFormRefJson !== undefined) {
      await sql.run(
        `UPDATE tf_resource_deletion_attestations
         SET form_ref_json = ?
         WHERE tenant_id = ? AND resource_uid = ?`,
        [options.storedFormRefJson, tenantId, resourceUid],
      );
    }
  }
  await deployments.create({
    tenantId,
    id: "dep_relation_version",
    resourceUid,
    offeringId: options.offeringId ?? RELATION_OFFERING_ID,
    providerPackRef: "cloudflare",
    providerInstallationRef: installationId,
    nativeId,
    state: "retained",
    observed: {},
    outputs: options.outputs ?? {
      __takoserver: {
        resourceUid,
        space: "default",
        name,
        generation: "1",
        deleteOperationId: operationId,
      },
    },
  });
  const driver = createProviderDriver({
    providers: composition.providers,
    providerPacks: composition.providerPacks,
    catalog: createCatalog(composition.offerings),
    ledger: createLedger(sql, clock),
    deployments,
    deletions,
  });
  return {
    calls,
    composition,
    deletions,
    deployments,
    driver,
    input: { tenantId, resourceUid, space: "default", name },
    nativeId,
    sql,
    version,
  };
}

type RetainedRelationFixture = Awaited<ReturnType<typeof retainedRelationFixture>>;

function wfpReadbackFixture(
  fixture: RetainedRelationFixture,
  providerStatus: 200 | 404 | "metadata-null",
) {
  const productionProvider = fixture.composition.providers[0];
  if (!productionProvider) {
    throw new Error("Cloudflare production provider fixture is unavailable");
  }
  const offering = productionProvider.offerings.find(
    (candidate) => candidate.id === RELATION_OFFERING_ID,
  );
  if (!offering) throw new Error("WorkerVersion relation fixture is unavailable");
  const nativeReadbackAuthorities = productionProvider.nativeReadbackAuthorities;
  if (!nativeReadbackAuthorities) {
    throw new Error("Cloudflare relation readback authority fixture is unavailable");
  }
  let reads = 0;
  const provider = Object.assign(
    new CloudflareProvider({
      accountId: "account-fixture",
      offerings: productionProvider.offerings,
      ...(productionProvider.recoveryOfferings
        ? { recoveryOfferings: productionProvider.recoveryOfferings }
        : {}),
      artifacts: {
        async manifest() {
          return null;
        },
        async blob() {
          return null;
        },
      },
      authorize: () => "Bearer fixture-only",
      async fetch(request) {
        reads += 1;
        if (providerStatus === "metadata-null") {
          return new URL(request.url).pathname.endsWith("/settings")
            ? new Response(null, { status: 404 })
            : Response.json({
                success: true,
                result: { dispatch_namespace: "dispatch-fixture", script: null },
              });
        }
        return providerStatus === 404
          ? new Response(null, { status: 404 })
          : Response.json({
              success: true,
              result: {
                dispatch_namespace: "dispatch-fixture",
                script: { id: WFP_NATIVE_ID.split(":")[2], etag: "fixture-etag" },
              },
            });
      },
      workerBackend: {
        kind: "workers-for-platforms",
        dispatchNamespace: "dispatch-fixture",
        gatewayWorkerName: "gateway-fixture",
        providerInstallationId: INSTALLATION_ID,
        managedBaseDomain: "workers.example.test",
        sql: fixture.sql,
        inspectRelease: async (input) => ({
          ok: true,
          ...input,
          handlers: input.declaredHandlers,
        }),
        deriveSqliteInstanceName: async () => "sqlite-fixture",
        sealSqliteAdminProof: async () => "proof-fixture",
        sqliteNamespace: {
          getByName() {
            throw new Error("unused fixture capability");
          },
        },
      },
    }),
    { nativeReadbackAuthorities },
  );
  return {
    driver: createProviderDriver({
      providers: [provider],
      providerPacks: fixture.composition.providerPacks,
      catalog: createCatalog(fixture.composition.offerings),
      ledger: createLedger(fixture.sql, () => new Date(NOW)),
      deployments: fixture.deployments,
      deletions: fixture.deletions,
    }),
    namespaceReads: () => reads,
    offering,
    provider,
  };
}

function artifactConsumptionInput(
  fixture: RetainedRelationFixture,
  offering: ProviderOffering,
): ProviderArtifactConsumptionInput {
  return {
    offering,
    nativeId: fixture.nativeId,
    target: {
      tenantId: fixture.input.tenantId,
      resourceUid: fixture.input.resourceUid,
      incarnationId: "dep_relation_version",
      state: "retained",
      updatedAt: NOW.getTime(),
    },
    identity: {
      tenantRef: fixture.input.tenantId,
      resourceUid: fixture.input.resourceUid,
      address: { space: fixture.input.space, name: fixture.input.name },
    },
    candidateManifestDigests: [WFP_MANIFEST_DIGEST],
  };
}

async function seedManagedVersionReceipt(
  fixture: RetainedRelationFixture,
  receiptState: "pending" | "committed" | "deleting" | "deleted",
  receiptCase:
    | "exact"
    | "native-mismatch"
    | "parent-mismatch"
    | "pending"
    | "deleting"
    | "corrupt" = "exact",
): Promise<void> {
  const descriptorDigest =
    receiptCase === "native-mismatch"
      ? (`sha256:${"e".repeat(64)}` as const)
      : WFP_DESCRIPTOR_DIGEST;
  const nativeId =
    receiptCase === "native-mismatch"
      ? `version:logical-worker:tsr-${descriptorDigest.slice("sha256:".length)}`
      : fixture.nativeId;
  const state = new ManagedWorkerState("cloudflare", fixture.sql);
  const operationId = `op_wfp_release_${receiptCase}`;
  const claimed = await state.claimReceipt({
    resourceUid: fixture.input.resourceUid,
    nativeId,
    kind: "version",
    logicalWorkerId: receiptCase === "parent-mismatch" ? "other-worker" : "logical-worker",
    operationId,
    descriptorDigest,
    observed: { manifestDigest: WFP_MANIFEST_DIGEST },
  });
  if (claimed.outcome !== "claimed") throw new Error("managed receipt fixture claim failed");
  if (receiptState === "pending") return;
  if (
    !(await state.commitReceipt({
      resourceUid: fixture.input.resourceUid,
      operationId,
      descriptorDigest,
      observed: { manifestDigest: WFP_MANIFEST_DIGEST },
    }))
  ) {
    throw new Error("managed receipt fixture commit failed");
  }
  if (receiptState === "committed") return;
  const deleteOperationId = `op_wfp_delete_${receiptCase}`;
  if (
    !(await state.beginReceiptDelete({
      resourceUid: fixture.input.resourceUid,
      nativeId,
      operationId: deleteOperationId,
    }))
  ) {
    throw new Error("managed receipt fixture delete claim failed");
  }
  if (receiptCase === "corrupt") {
    await fixture.sql.run(
      `UPDATE cloudflare_managed_worker_receipts
       SET previous_json = '{}'
       WHERE provider_id = 'cloudflare' AND resource_uid = ?`,
      [fixture.input.resourceUid],
    );
  }
  if (receiptState === "deleting") return;
  if (
    !(await state.commitReceiptDelete({
      resourceUid: fixture.input.resourceUid,
      nativeId,
      operationId: deleteOperationId,
      observed: { manifestDigest: WFP_MANIFEST_DIGEST },
    }))
  ) {
    throw new Error("managed receipt fixture delete commit failed");
  }
}
