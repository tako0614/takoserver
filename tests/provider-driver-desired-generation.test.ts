import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createCatalog, type Offering } from "../src/catalog.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { createLedger } from "../src/ledger.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createProviderDriver } from "../src/provider-driver.ts";
import { failed, type Provider, type ProviderOffering, succeeded } from "../src/provider-port.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import type { InstalledTakoformForm, TakoformStoredResource } from "../src/takoform/types.ts";
import { applyWithSelection } from "./helpers/apply-with-selection.ts";
import { createStaticStableTestTakoformHost } from "./helpers/historical-takoform-host.ts";

const formRef = {
  apiVersion: "example.forms.invalid",
  kind: "GenerationProbe",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
} as const;

const form: InstalledTakoformForm = {
  identity: { formRef },
  role: "deployment",
  desiredSchema: { type: "object", additionalProperties: false },
  operations: ["create", "update", "delete"],
};

const technicalOffering: ProviderOffering = {
  id: "generation-probe",
  kind: "generation_probe",
  displayName: "Generation probe",
  form: formRef,
  providedInterfaces: [],
  bindingRefs: [],
  capabilities: ["create", "update", "delete", "observe"],
};

const soldOffering: Offering = {
  id: technicalOffering.id,
  providerPackRef: "generation-probe-provider",
  providerInstallationRef: "generation-probe-provider.primary",
  supplyContractRef: "generation-probe.supply",
  pricePlanRef: "generation-probe.price",
  resourceClass: "generation-probe",
  deliveryMode: "managed-endpoint",
  supportPolicyRef: "generation-probe.support",
  abusePolicyRef: "generation-probe.abuse",
  kind: technicalOffering.kind,
  displayName: technicalOffering.displayName,
  form: formRef,
  pricePlan: {
    id: "generation-probe.price",
    currency: "USD",
    provisioning: { meter: "generation-probe.create", amountMinor: 0 },
    meters: [],
  },
  providedInterfaces: [],
  bindingRefs: [],
  regions: [],
  portability: {
    api: "portable",
    exportFormats: [],
    importFormats: [],
    migrationModes: [],
  },
  isolation: "dedicated-resource",
  available: true,
};

test("provider driver forwards desiredGeneration to apply and convergence, omitting it when absent", async () => {
  const sql = createEphemeralSql();
  const deployments = createResourceDeploymentStore(
    sql,
    () => new Date("2026-09-01T00:00:00.000Z"),
  );
  const calls: Array<{
    readonly method: "apply" | "convergeApply";
    readonly input: Parameters<Provider["apply"]>[0];
  }> = [];
  const result = (input: Parameters<Provider["apply"]>[0]) =>
    succeeded({ nativeId: `native:${input.identity.uid}`, observed: input.spec, outputs: {} });
  const provider: Provider = {
    id: soldOffering.providerPackRef,
    offerings: [technicalOffering],
    async apply(input) {
      calls.push({ method: "apply", input: structuredClone(input) });
      return result(input);
    },
    async convergeApply(input) {
      calls.push({ method: "convergeApply", input: structuredClone(input) });
      return result(input);
    },
    async observe(input) {
      return result({
        operationId: "observe",
        offering: input.offering,
        identity: input.identity,
        spec: input.spec,
      });
    },
    async delete(input) {
      return result({
        operationId: input.operationId,
        offering: input.offering,
        identity: input.identity,
        spec: input.spec ?? {},
      });
    },
  };
  const driver = createProviderDriver({
    providers: [provider],
    catalog: createCatalog([soldOffering]),
    ledger: createLedger(sql, () => new Date("2026-09-01T00:00:00.000Z")),
    deployments,
  });
  const baseInput = {
    operationId: "generation-driver-0001",
    operationKey: "generation-driver-key-0001",
    operationMode: "initial" as const,
    tenantId: "tenant-a",
    resourceUid: "uid-generation-driver",
    executionAuthority: {
      tenantId: "tenant-a",
      resourceUid: "uid-generation-driver",
      leaseToken: "lease-generation-driver",
      fingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    form,
    name: "probe",
    space: "main",
    spec: { value: "first" },
    relations: [],
  };

  await applyWithSelection(driver, { ...baseInput, desiredGeneration: "9223372036854775807" });
  await applyWithSelection(driver, {
    ...baseInput,
    operationMode: "recovery",
    desiredGeneration: "9223372036854775807",
  });
  await applyWithSelection(driver, {
    ...baseInput,
    operationId: "generation-driver-0002",
    operationKey: "generation-driver-key-0002",
    resourceUid: "uid-generation-driver-2",
    executionAuthority: {
      ...baseInput.executionAuthority,
      resourceUid: "uid-generation-driver-2",
      leaseToken: "lease-generation-driver-2",
    },
  });

  expect(calls.map(({ method }) => method)).toEqual(["apply", "convergeApply", "apply"]);
  expect(calls[0]?.input.desiredGeneration).toBe("9223372036854775807");
  expect(calls[1]?.input.desiredGeneration).toBe("9223372036854775807");
  expect(calls[2]?.input.desiredGeneration).toBeUndefined();
  expect(Object.hasOwn(calls[1]?.input ?? {}, "desiredGeneration")).toBe(true);
  expect(Object.hasOwn(calls[2]?.input ?? {}, "desiredGeneration")).toBe(false);
});

test("atomic generation updates keep same-id refreshes but never replace an imported native claim", async () => {
  const sql = createEphemeralSql();
  const clock = () => new Date("2026-09-21T00:00:00.000Z");
  const deployments = createResourceDeploymentStore(sql, clock);
  const resourceUid = "uid-claimed-generation-driver";
  await deployments.create({
    tenantId: "tenant-a",
    id: "dep_claimed_generation_driver",
    resourceUid,
    offeringId: soldOffering.id,
    providerPackRef: soldOffering.providerPackRef,
    providerInstallationRef: soldOffering.providerInstallationRef,
    nativeId: "native:g1-claimed",
    nativeClaimed: true,
    state: "active",
    observed: { value: "first" },
    outputs: {},
  });
  let returnedNativeId = "native:g1-claimed";
  const provider: Provider = {
    id: soldOffering.providerPackRef,
    offerings: [technicalOffering],
    async apply(input) {
      return succeeded({ nativeId: returnedNativeId, observed: input.spec, outputs: {} });
    },
    async observe(input) {
      return succeeded({ nativeId: input.nativeId, observed: input.spec, outputs: {} });
    },
    async delete(input) {
      return succeeded({ nativeId: input.nativeId, observed: {}, outputs: {} });
    },
  };
  const driver = createProviderDriver({
    providers: [provider],
    catalog: createCatalog([soldOffering]),
    ledger: createLedger(sql, clock),
    deployments,
  });
  const previous: TakoformStoredResource = {
    apiVersion: formRef.apiVersion,
    kind: formRef.kind,
    form: { formRef },
    metadata: {
      name: "probe",
      space: "main",
      uid: resourceUid,
      generation: "1",
      revision: "1",
    },
    spec: { value: "first" },
    status: { observedGeneration: "1", conditions: [] },
  };

  const updateInput = {
    operationId: "generation-driver-claimed-refresh",
    operationKey: "generation-driver-claimed-refresh-key",
    tenantId: "tenant-a",
    resourceUid,
    executionAuthority: {
      tenantId: "tenant-a",
      resourceUid,
      leaseToken: "lease-generation-driver-claimed-refresh",
      fingerprint: `sha256:${"c".repeat(64)}`,
    },
    form,
    name: "probe",
    space: "main",
    spec: { value: "second" },
    desiredGeneration: "2",
    relations: [],
    previous,
    atomicDeploymentCommit: true as const,
  };
  expect(await applyWithSelection(driver, updateInput)).toMatchObject({
    deploymentMutation: {
      kind: "refresh",
      expectedNativeId: "native:g1-claimed",
    },
  });

  returnedNativeId = "native:g2";
  await expect(
    applyWithSelection(driver, {
      ...updateInput,
      operationId: "generation-driver-claimed-replacement",
      operationKey: "generation-driver-claimed-replacement-key",
      executionAuthority: {
        ...updateInput.executionAuthority,
        leaseToken: "lease-generation-driver-claimed-replacement",
      },
    }),
  ).rejects.toMatchObject({ code: "resource_busy", status: 409 });
  expect(await deployments.active("tenant-a", resourceUid)).toMatchObject({
    nativeId: "native:g1-claimed",
    nativeClaimed: true,
    observed: { value: "first" },
  });
});

test("atomic generation updates replace an unclaimed native realization used by later delete", async () => {
  const database = new Database(":memory:");
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    let now = Date.parse("2026-09-21T00:00:00.000Z");
    const clock = () => new Date(now);
    const deployments = createResourceDeploymentStore(sql, clock);
    let providerNativeId: string | null = null;
    const deletedNativeIds: string[] = [];
    const provider: Provider = {
      id: soldOffering.providerPackRef,
      offerings: [technicalOffering],
      async apply(input) {
        const nativeId = `native:g${input.desiredGeneration ?? "missing"}`;
        providerNativeId = nativeId;
        return succeeded({ nativeId, observed: input.spec, outputs: {} });
      },
      async observe(input) {
        return succeeded({ nativeId: input.nativeId, observed: input.spec, outputs: {} });
      },
      async delete(input) {
        deletedNativeIds.push(input.nativeId);
        if (input.nativeId !== providerNativeId) {
          return failed("occupied", "the managed Worker Deployment delete is stale");
        }
        providerNativeId = null;
        return succeeded({
          nativeId: input.nativeId,
          observed: { deleted: true },
          outputs: {},
          disposition: "deleted",
        });
      },
    };
    const driver = createProviderDriver({
      providers: [provider],
      catalog: createCatalog([soldOffering]),
      ledger: createLedger(sql, clock),
      deployments,
    });
    const host = createStaticStableTestTakoformHost({
      sql,
      objects: createMemoryObjectStore(),
      clock,
      authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
      forms: [
        {
          ...form,
          desiredSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ],
      driver,
    });
    const lane = "/apis/forms.takoform.com/v1";
    const resourcePath = `${lane}/resources/${formRef.apiVersion}/${formRef.kind}/probe`;
    const formQuery = new URLSearchParams({
      space: "main",
      definitionVersion: formRef.definitionVersion,
      schemaDigest: formRef.schemaDigest,
    }).toString();
    const request = async (path: string, init: RequestInit): Promise<Response> => {
      const response = await host.handle(
        new Request(`https://host.test${path}`, {
          ...init,
          headers: {
            authorization: "Bearer test",
            ...(init.body === undefined ? {} : { "content-type": "application/json" }),
            ...init.headers,
          },
        }),
      );
      if (!response) throw new Error("Host did not handle request");
      return response;
    };
    const apply = async (
      value: string,
      key: string,
      current?: TakoformStoredResource,
    ): Promise<TakoformStoredResource> => {
      const desired = {
        apiVersion: formRef.apiVersion,
        kind: formRef.kind,
        form: { formRef },
        metadata: { name: "probe", space: "main" },
        spec: { value },
      };
      const generationFence = current
        ? { "takoform-expected-generation": current.metadata.generation }
        : {};
      const prepared = await request(`${lane}/resources/prepare`, {
        method: "POST",
        headers: generationFence,
        body: JSON.stringify(desired),
      });
      expect(prepared.status).toBe(200);
      const { review } = (await prepared.json()) as { review: unknown };
      const applied = await request(resourcePath, {
        method: "PUT",
        headers: {
          ...generationFence,
          "idempotency-key": `native-replacement-${key}`,
          ...(current
            ? { "if-match": `"${current.metadata.revision}"` }
            : { "if-none-match": "*" }),
        },
        body: JSON.stringify({ ...desired, review }),
      });
      expect(applied.status).toBe(current ? 200 : 201);
      return (await applied.json()) as TakoformStoredResource;
    };

    const first = await apply("first", "create");
    now += 1_000;
    const second = await apply("second", "update", first);
    expect(second.metadata).toMatchObject({
      uid: first.metadata.uid,
      generation: "2",
      revision: "2",
    });
    expect(await deployments.active("tenant-a", first.metadata.uid)).toMatchObject({
      nativeId: "native:g2",
      nativeClaimed: false,
      observed: { value: "second" },
    });
    const replacementEffects = database
      .query(
        `SELECT native_id, target_json FROM tf_resource_provider_effects
         WHERE tenant_id = ? AND resource_uid = ?
           AND effect_kind = 'apply' AND phase = 'succeeded' AND native_id IS NOT NULL
         ORDER BY created_at, event_id`,
      )
      .all("tenant-a", first.metadata.uid) as Array<{
      readonly native_id: string;
      readonly target_json: string;
    }>;
    expect(replacementEffects.map(({ native_id }) => native_id)).toEqual(["native:g2"]);
    expect(JSON.parse(replacementEffects[0]?.target_json ?? "null")).toMatchObject({
      resourceUid: first.metadata.uid,
      nativeId: "native:g2",
    });

    now += 1_000;
    const deleted = await request(`${resourcePath}?${formQuery}`, {
      method: "DELETE",
      headers: {
        "idempotency-key": "native-replacement-delete",
        "takoform-expected-generation": second.metadata.generation,
      },
    });
    expect(deleted.status).toBe(204);
    expect(deletedNativeIds).toEqual(["native:g2"]);
    expect(await deployments.active("tenant-a", first.metadata.uid)).toBeNull();
  } finally {
    database.close();
  }
});
