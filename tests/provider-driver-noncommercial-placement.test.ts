import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createCatalog, type Offering } from "../src/catalog.ts";
import { createLedger } from "../src/ledger.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { type CreateProviderDriverOptions, createProviderDriver } from "../src/provider-driver.ts";
import { type Provider, succeeded } from "../src/provider-port.ts";
import type { CloudflareProviderExecutorRpc } from "../src/providers/cloudflare-provider-executor-port.ts";
import { CloudflareProviderProxy } from "../src/providers/cloudflare-provider-proxy.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import type { InstalledTakoformForm, TakoformStoredResource } from "../src/takoform/types.ts";
import { createStaticStableTestTakoformHost } from "./helpers/historical-takoform-host.ts";

const formRef = {
  apiVersion: "example.forms.invalid",
  kind: "NoncommercialProbe",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}` as const,
};
const form: InstalledTakoformForm = {
  identity: {
    formRef,
    packageDigest: `sha256:${"b".repeat(64)}`,
    implementationDigest: `sha256:${"e".repeat(64)}`,
  },
  role: "identity",
  desiredSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  operations: ["create", "read", "update", "delete", "observe"],
};
const offering = {
  id: "probe.technical",
  kind: "noncommercial_probe",
  displayName: "Noncommercial probe",
  form: formRef,
  providedInterfaces: [],
  bindingRefs: [],
  capabilities: ["create", "update", "delete", "observe"],
} as const;
const placement = {
  tenantId: "tenant-a",
  space: "dev",
  form: form.identity,
  providerPackRef: "probe-provider",
  providerInstallationRef: "probe-provider.dev",
  offeringId: offering.id,
};
const soldOffering: Offering = {
  id: offering.id,
  providerPackRef: placement.providerPackRef,
  providerInstallationRef: placement.providerInstallationRef,
  supplyContractRef: "probe.supply",
  pricePlanRef: "probe.price",
  resourceClass: "probe",
  deliveryMode: "managed-endpoint",
  supportPolicyRef: "probe.support",
  abusePolicyRef: "probe.abuse",
  kind: offering.kind,
  displayName: offering.displayName,
  form: formRef,
  pricePlan: {
    id: "probe.price",
    currency: "USD",
    provisioning: { meter: "probe.create", amountMinor: 100 },
    meters: [],
  },
  providedInterfaces: [],
  bindingRefs: [],
  regions: [],
  portability: { api: "portable", exportFormats: [], importFormats: [], migrationModes: [] },
  isolation: "dedicated-resource",
  available: true,
};

function setup(
  resolve?: NonNullable<CreateProviderDriverOptions["noncommercialPlacement"]>["resolve"],
  sold?: Offering,
) {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  const clock = () => new Date("2026-09-28T00:00:00.000Z");
  const calls: string[] = [];
  const provider: Provider = {
    id: "probe-provider",
    installedProviderInstallationRef: placement.providerInstallationRef,
    offerings: [offering],
    async apply(input) {
      calls.push(`apply:${input.identity.space}:${input.offering.id}`);
      return succeeded({
        nativeId: `native:${input.identity.uid}`,
        observed: input.spec,
        outputs: {},
      });
    },
    async observe(input) {
      calls.push(`observe:${input.identity.space}:${input.offering.id}`);
      return succeeded({ nativeId: input.nativeId, observed: input.spec, outputs: {} });
    },
    async delete(input) {
      calls.push(`delete:${input.identity.space}:${input.offering.id}`);
      return succeeded({
        nativeId: input.nativeId,
        observed: {},
        outputs: {},
        disposition: "deleted",
      });
    },
  };
  const ledger = createLedger(sql, clock);
  const deployments = createResourceDeploymentStore(sql, clock);
  const driver = createProviderDriver({
    providers: [provider],
    catalog: createCatalog(sold ? [sold] : []),
    ledger,
    deployments,
    ...(resolve
      ? {
          noncommercialPlacement: {
            installations: [
              { provider, providerInstallationRef: placement.providerInstallationRef },
            ],
            resolve,
          },
        }
      : {}),
  });
  return { database, sql, clock, driver, deployments, ledger, provider, calls };
}

function selectionInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant-a",
    resourceUid: "resource-probe",
    form,
    name: "probe",
    space: "dev",
    spec: { value: "first" },
    relations: [],
    ...overrides,
  };
}

test("identity without a sold Offering still refuses by default", async () => {
  const fixture = setup();
  try {
    await expect(fixture.driver.selectApply(selectionInput())).rejects.toMatchObject({
      code: "unsupported_capability",
      status: 422,
    });
    expect(fixture.calls).toEqual([]);
  } finally {
    fixture.database.close();
  }
});

test("noncommercial authority is exact and cannot replace a sold selection", async () => {
  for (const wrong of [
    { tenantId: "other-tenant" },
    { space: "other-space" },
    { form: { ...form.identity, packageDigest: `sha256:${"c".repeat(64)}` as const } },
    { form: { ...form.identity, formRef: { ...formRef, kind: "OtherKind" } } },
    { providerPackRef: "other-provider" },
    { providerInstallationRef: "" },
    { providerInstallationRef: "probe-provider.other" },
    { offeringId: "other-offering" },
  ]) {
    const fixture = setup(async () => ({ ...placement, ...wrong }));
    try {
      await expect(fixture.driver.selectApply(selectionInput())).rejects.toMatchObject({
        code: "unsupported_capability",
        status: 422,
      });
      expect(fixture.calls).toEqual([]);
    } finally {
      fixture.database.close();
    }
  }
  for (const wrongInput of [
    { tenantId: "other-tenant" },
    { space: "other-space" },
    {
      form: {
        ...form,
        identity: { ...form.identity, packageDigest: `sha256:${"c".repeat(64)}` as const },
      },
    },
    {
      form: {
        ...form,
        identity: { ...form.identity, formRef: { ...formRef, kind: "OtherKind" } },
      },
    },
    { form: { ...form, identity: { formRef } } },
  ]) {
    const scoped = setup(async () => placement);
    try {
      await expect(scoped.driver.selectApply(selectionInput(wrongInput))).rejects.toMatchObject({
        code: "unsupported_capability",
        status: 422,
      });
      expect(scoped.calls).toEqual([]);
    } finally {
      scoped.database.close();
    }
  }
  const missingIdentity = setup(async () => placement);
  try {
    Object.defineProperty(missingIdentity.provider, "installedProviderInstallationRef", {
      value: undefined,
    });
    await expect(missingIdentity.driver.selectApply(selectionInput())).rejects.toMatchObject({
      code: "unsupported_capability",
      status: 422,
    });
  } finally {
    missingIdentity.database.close();
  }
  const fixture = setup(async () => placement);
  try {
    await expect(
      fixture.driver.selectApply(
        selectionInput({
          commercialAuthority: {
            reservationId: "reservation",
            offeringId: offering.id,
            offeringDigest: `sha256:${"d".repeat(64)}`,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "unsupported_capability", status: 422 });
  } finally {
    fixture.database.close();
  }
});

test("an existing sold Offering keeps commercial selection and never consults the hook", async () => {
  let consulted = false;
  const fixture = setup(async () => {
    consulted = true;
    return placement;
  }, soldOffering);
  try {
    const selected = await fixture.driver.selectApply(selectionInput());
    expect(selected).toMatchObject({
      kind: "provider",
      sold: { offeringId: soldOffering.id, pricePlan: soldOffering.pricePlan },
    });
    expect(consulted).toBe(false);
    await expect(
      fixture.driver.selectApply(
        selectionInput({
          commercialAuthority: {
            reservationId: "reservation",
            offeringId: "wrong-offering",
            offeringDigest: `sha256:${"d".repeat(64)}`,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "unsupported_capability", status: 422 });
    expect(consulted).toBe(false);
  } finally {
    fixture.database.close();
  }
});

test("an unavailable commercial Offering ID cannot be repurposed as noncommercial supply", async () => {
  for (const withdrawn of [
    { ...soldOffering, available: false },
    { ...soldOffering, retired: true },
  ]) {
    const fixture = setup(async () => placement, withdrawn);
    try {
      await expect(fixture.driver.selectApply(selectionInput())).rejects.toMatchObject({
        code: "unsupported_capability",
        status: 422,
      });
      expect(fixture.calls).toEqual([]);
    } finally {
      fixture.database.close();
    }
  }
});

test("exact noncommercial placement uses canonical Host create/read/update/delete without a sale", async () => {
  const fixture = setup(async () => placement);
  try {
    const selected = await fixture.driver.selectApply(selectionInput());
    expect(selected).toMatchObject({
      kind: "provider",
      providerPackRef: placement.providerPackRef,
      providerInstallationRef: placement.providerInstallationRef,
      technicalOffering: offering,
    });
    expect("sold" in selected).toBe(false);
    const host = createStaticStableTestTakoformHost({
      sql: fixture.sql,
      objects: createMemoryObjectStore(),
      clock: fixture.clock,
      authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
      forms: [form],
      driver: fixture.driver,
    });
    const lane = "/apis/forms.takoform.com/v1";
    const path = `${lane}/resources/${formRef.apiVersion}/${formRef.kind}/probe`;
    const request = async (path: string, init: RequestInit) => {
      const response = await host.handle(
        new Request(`https://host.test${path}`, {
          ...init,
          headers: {
            authorization: "Bearer test",
            ...(init.body ? { "content-type": "application/json" } : {}),
            ...init.headers,
          },
        }),
      );
      if (!response) throw new Error("Host did not handle request");
      return response;
    };
    const desired = (value: string) => ({
      apiVersion: formRef.apiVersion,
      kind: formRef.kind,
      form: { formRef },
      metadata: { name: "probe", space: "dev" },
      spec: { value },
    });
    const createPrepare = await request(`${lane}/resources/prepare`, {
      method: "POST",
      body: JSON.stringify(desired("first")),
    });
    expect(createPrepare.status).toBe(200);
    const createReview = ((await createPrepare.json()) as { review: unknown }).review;
    const createdResponse = await request(path, {
      method: "PUT",
      headers: { "if-none-match": "*", "idempotency-key": "noncommercial-create" },
      body: JSON.stringify({ ...desired("first"), review: createReview }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as TakoformStoredResource;
    expect(await fixture.deployments.active("tenant-a", created.metadata.uid)).toMatchObject({
      offeringId: offering.id,
      providerPackRef: placement.providerPackRef,
      providerInstallationRef: placement.providerInstallationRef,
    });
    const query = new URLSearchParams({
      space: "dev",
      definitionVersion: formRef.definitionVersion,
      schemaDigest: formRef.schemaDigest,
    });
    const read = await request(`${path}?${query}`, { method: "GET" });
    expect(read.status).toBe(200);
    const observed = await request(`${path}/observe?${query}`, {
      method: "POST",
      headers: { "takoform-expected-generation": created.metadata.generation },
    });
    expect(observed.status).toBe(200);
    const updatePrepare = await request(`${lane}/resources/prepare`, {
      method: "POST",
      headers: { "takoform-expected-generation": created.metadata.generation },
      body: JSON.stringify(desired("second")),
    });
    expect(updatePrepare.status).toBe(200);
    const updateReview = ((await updatePrepare.json()) as { review: unknown }).review;
    const updateResponse = await request(path, {
      method: "PUT",
      headers: {
        "if-match": `"${created.metadata.revision}"`,
        "takoform-expected-generation": created.metadata.generation,
        "idempotency-key": "noncommercial-update",
      },
      body: JSON.stringify({ ...desired("second"), review: updateReview }),
    });
    expect(updateResponse.status).toBe(200);
    const updated = (await updateResponse.json()) as TakoformStoredResource;
    const deleted = await request(`${path}?${query}`, {
      method: "DELETE",
      headers: {
        "idempotency-key": "noncommercial-delete",
        "takoform-expected-generation": updated.metadata.generation,
      },
    });
    expect(deleted.status).toBe(204);
    expect(fixture.calls).toEqual([
      "apply:dev:probe.technical",
      "observe:dev:probe.technical",
      "apply:dev:probe.technical",
      "delete:dev:probe.technical",
    ]);
    expect(await fixture.deployments.active("tenant-a", created.metadata.uid)).toBeNull();
    expect((await fixture.ledger.wallet("tenant-a")).entries).toEqual([]);
  } finally {
    fixture.database.close();
  }
});

test("an accepted selection cannot dispatch after noncommercial authority changes", async () => {
  let allowed = true;
  const fixture = setup(async () => (allowed ? placement : null));
  try {
    const input = selectionInput();
    const selection = await fixture.driver.selectApply(input);
    allowed = false;
    await expect(
      fixture.driver.apply({
        ...input,
        operationId: "noncommercial-revoked",
        operationKey: "noncommercial-revoked",
        operationMode: "initial",
        executionAuthority: {
          tenantId: input.tenantId,
          resourceUid: input.resourceUid,
          leaseToken: "noncommercial-revoked-lease",
          fingerprint: `sha256:${"f".repeat(64)}`,
        },
        selection,
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability", status: 422 });
    expect(fixture.calls).toEqual([]);
  } finally {
    fixture.database.close();
  }
});

test("a replacement proxy on another installation cannot observe, delete, recover, or repair", async () => {
  const fixture = setup(async () => placement);
  try {
    const input = selectionInput();
    const selection = await fixture.driver.selectApply(input);
    await fixture.deployments.create({
      tenantId: input.tenantId,
      id: "dep_resource-probe",
      resourceUid: input.resourceUid,
      offeringId: offering.id,
      providerPackRef: placement.providerPackRef,
      providerInstallationRef: placement.providerInstallationRef,
      nativeId: "native:resource-probe",
      state: "active",
      observed: input.spec,
      outputs: {},
    });
    const resource: TakoformStoredResource = {
      apiVersion: formRef.apiVersion,
      kind: formRef.kind,
      form: form.identity,
      metadata: {
        name: input.name,
        space: input.space,
        uid: input.resourceUid,
        generation: "1",
        revision: "1",
      },
      spec: input.spec,
      status: { observedGeneration: "1", conditions: [] },
    };
    const wrongProxy = new CloudflareProviderProxy({
      id: placement.providerPackRef,
      providerInstallationId: "probe-provider.other",
      offerings: [offering],
      managedBaseDomain: "example.invalid",
      binding: {} as CloudflareProviderExecutorRpc,
    });
    expect(wrongProxy.installedProviderInstallationRef).toBe("probe-provider.other");
    const driver = createProviderDriver({
      providers: [wrongProxy],
      catalog: createCatalog([]),
      ledger: fixture.ledger,
      deployments: fixture.deployments,
      noncommercialPlacement: {
        installations: [
          { provider: wrongProxy, providerInstallationRef: placement.providerInstallationRef },
        ],
        resolve: async () => placement,
      },
    });
    await expect(
      driver.observe({
        tenantId: input.tenantId,
        resourceUid: input.resourceUid,
        resource,
        relations: [],
      }),
    ).rejects.toMatchObject({ code: "backend_unavailable", status: 503 });
    const executionAuthority = {
      tenantId: input.tenantId,
      resourceUid: input.resourceUid,
      leaseToken: "wrong-installation-lease",
      fingerprint: `sha256:${"f".repeat(64)}`,
    };
    await expect(
      driver.delete({
        operationId: "wrong-installation-delete",
        operationMode: "recovery",
        executionAuthority,
        tenantId: input.tenantId,
        resourceUid: input.resourceUid,
        resource,
        relations: [],
      }),
    ).rejects.toMatchObject({ code: "backend_unavailable", status: 503 });
    await expect(
      driver.apply({
        ...input,
        operationId: "wrong-installation-apply",
        operationKey: "wrong-installation-apply",
        operationMode: "recovery",
        executionAuthority,
        selection,
      }),
    ).rejects.toMatchObject({ code: "unsupported_capability", status: 422 });
    expect(
      await driver.artifactConsumerRepair.verifyNativeAbsence({
        deployment: {
          tenantId: input.tenantId,
          deploymentId: "dep_resource-probe",
          resourceUid: input.resourceUid,
          offeringId: offering.id,
          providerPackRef: placement.providerPackRef,
          providerInstallationRef: placement.providerInstallationRef,
          nativeId: "native:resource-probe",
          state: "active",
          createdAt: Date.parse("2026-09-28T00:00:00.000Z"),
          updatedAt: Date.parse("2026-09-28T00:00:00.000Z"),
          observed: input.spec,
          outputs: {},
        },
        address: {
          space: input.space,
          apiVersion: formRef.apiVersion,
          kind: formRef.kind,
          name: input.name,
        },
        formRef,
      }),
    ).toMatchObject({ outcome: "indeterminate", reason: "authority_unavailable" });
    const { installedProviderInstallationRef: _removed, ...noIdentity } = fixture.provider;
    const noIdentityDriver = createProviderDriver({
      providers: [noIdentity],
      catalog: createCatalog([]),
      ledger: fixture.ledger,
      deployments: fixture.deployments,
      noncommercialPlacement: {
        installations: [{ provider: noIdentity, providerInstallationRef: "probe-provider.other" }],
        resolve: async () => placement,
      },
    });
    await expect(
      noIdentityDriver.observe({
        tenantId: input.tenantId,
        resourceUid: input.resourceUid,
        resource,
        relations: [],
      }),
    ).rejects.toMatchObject({ code: "backend_unavailable", status: 503 });
    const withoutHook = createProviderDriver({
      providers: [wrongProxy],
      catalog: createCatalog([]),
      ledger: fixture.ledger,
      deployments: fixture.deployments,
    });
    await expect(
      withoutHook.observe({
        tenantId: input.tenantId,
        resourceUid: input.resourceUid,
        resource,
        relations: [],
      }),
    ).rejects.toMatchObject({ code: "backend_unavailable", status: 503 });
  } finally {
    fixture.database.close();
  }
});
