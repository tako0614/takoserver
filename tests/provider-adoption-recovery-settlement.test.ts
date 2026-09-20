import { describe, expect, test } from "bun:test";
import {
  createCatalog,
  createEphemeralSql,
  createLedger,
  createMemoryObjectStore,
  createResourceDeploymentStore,
  type Offering,
} from "../src/index.ts";
import {
  createProviderDriver,
  ProviderMutationRecoveryError,
  ProviderMutationWholeOperationRefusalError,
} from "../src/provider-driver.ts";
import {
  failed,
  failedWithoutProviderMutation,
  failedWithoutProviderOperationMutation,
  type Provider,
  type ProviderOffering,
  providerFailureProvesNoMutation,
  providerFailureProvesWholeOperationNoMutation,
  succeeded,
} from "../src/provider-port.ts";
import type { InstalledTakoformForm, TakoformResourceDriver } from "../src/takoform/types.ts";
import { createConfiguredHistoricalTakoformHost } from "./helpers/historical-takoform-host.ts";

const lane = "/apis/forms.takoform.com/v1beta4";
const tenantId = "tenant-adoption-recovery";
const form: InstalledTakoformForm = {
  identity: {
    formRef: {
      apiVersion: "example.forms.invalid",
      kind: "AdoptedThing",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"a".repeat(64)}`,
    },
  },
  desiredSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  operations: ["create", "read", "update", "delete", "import"],
};
const providerOffering: ProviderOffering = {
  id: "adopted.thing.standard",
  kind: "adopted_thing",
  displayName: "Adopted thing",
  form: form.identity.formRef,
  providedInterfaces: [],
  bindingRefs: [],
  capabilities: ["create", "update", "delete", "import", "observe"],
};
const soldOffering: Offering = {
  id: providerOffering.id,
  providerPackRef: "recovery-provider",
  providerInstallationRef: "recovery-provider.primary",
  supplyContractRef: "recovery-provider.test-contract",
  pricePlanRef: "adopted.thing.standard.price-v1",
  resourceClass: "adopted.thing",
  deliveryMode: "managed-endpoint",
  supportPolicyRef: "support:test",
  abusePolicyRef: "abuse:test",
  kind: providerOffering.kind,
  displayName: providerOffering.displayName,
  form: form.identity.formRef,
  pricePlan: {
    id: "adopted.thing.standard.price-v1",
    currency: "USD",
    provisioning: { meter: "resource.create", amountMinor: 0 },
    meters: [],
  },
  providedInterfaces: [],
  bindingRefs: [],
  regions: ["test"],
  portability: {
    api: "portable",
    exportFormats: [],
    importFormats: [],
    migrationModes: ["offline"],
  },
  isolation: "dedicated-resource",
  available: true,
};

describe("provider adoption recovery settlement", () => {
  test("keeps invocation-only and whole-operation proof identities separate", () => {
    const wholeOperation = failedWithoutProviderOperationMutation(
      "operation-1",
      "not_found",
      "the exact adoption reservation is absent",
    );
    const invocationOnly = failedWithoutProviderMutation(
      "operation-1",
      "not_found",
      "this invocation did not mutate",
    );

    expect(providerFailureProvesWholeOperationNoMutation(wholeOperation, "operation-1")).toBe(true);
    expect(providerFailureProvesWholeOperationNoMutation(wholeOperation, "operation-2")).toBe(
      false,
    );
    expect(providerFailureProvesNoMutation(wholeOperation, "operation-1")).toBe(false);
    expect(providerFailureProvesWholeOperationNoMutation(invocationOnly, "operation-1")).toBe(
      false,
    );
    expect(
      providerFailureProvesWholeOperationNoMutation(structuredClone(wholeOperation), "operation-1"),
    ).toBe(false);
  });

  test("the real driver recognizes whole-operation proof only from direct adoption recovery", async () => {
    const direct = await rejectedImport(
      providerWith({
        recoverAdopt: async (input) =>
          failedWithoutProviderOperationMutation(
            input.operationId,
            "not_found",
            "the exact adoption reservation is absent",
          ),
      }),
      { operationMode: "recovery" },
    );
    expect(direct).toBeInstanceOf(ProviderMutationWholeOperationRefusalError);
    expect(direct).toMatchObject({
      code: "resource_not_found",
      status: 404,
      publicMessage: "the exact adoption reservation is absent",
    });

    const invocationOnly = await rejectedImport(
      providerWith({
        recoverAdopt: async (input) =>
          failedWithoutProviderMutation(
            input.operationId,
            "not_found",
            "only this recovery invocation was idle",
          ),
      }),
      { operationMode: "recovery" },
    );
    expect(invocationOnly).toBeInstanceOf(ProviderMutationRecoveryError);

    const wrongOperation = await rejectedImport(
      providerWith({
        recoverAdopt: async () =>
          failedWithoutProviderOperationMutation(
            "another-operation",
            "not_found",
            "proof belongs to another operation",
          ),
      }),
      { operationMode: "recovery" },
    );
    expect(wrongOperation).toBeInstanceOf(ProviderMutationRecoveryError);

    const initialAdopt = await rejectedImport(
      providerWith({
        adopt: async (input) =>
          failedWithoutProviderOperationMutation(
            input.operationId,
            "not_found",
            "initial adoption cannot prove the whole operation",
          ),
      }),
      { operationMode: "initial" },
    );
    expect(initialAdopt).toBeInstanceOf(ProviderMutationRecoveryError);

    const polled = await rejectedImport(
      providerWith({
        poll: async (input) =>
          failedWithoutProviderOperationMutation(
            input.operationId,
            "not_found",
            "poll cannot prove the whole operation",
          ),
      }),
      { operationMode: "recovery", providerHandle: "adoption-handle" },
    );
    expect(polled).toBeInstanceOf(ProviderMutationRecoveryError);

    const ordinaryFailure = await rejectedImport(
      providerWith({
        recoverAdopt: async () =>
          failed("not_found", "an ordinary nonretryable recovery failure", false),
      }),
      { operationMode: "recovery" },
    );
    expect(ordinaryFailure).toBeInstanceOf(ProviderMutationRecoveryError);

    const genericApply = await rejectedApply(
      providerWith({
        convergeApply: async (input) =>
          failedWithoutProviderOperationMutation(
            input.operationId,
            "not_found",
            "apply cannot use adoption proof",
          ),
      }),
    );
    expect(genericApply).toBeInstanceOf(ProviderMutationRecoveryError);

    const genericDelete = await rejectedDelete(
      providerWith({
        recoverDelete: async (input) =>
          failedWithoutProviderOperationMutation(
            input.operationId,
            "not_found",
            "delete cannot use adoption proof",
          ),
      }),
    );
    expect(genericDelete).toBeInstanceOf(ProviderMutationRecoveryError);
  });

  test("a lost initial response followed by a definitive recovery abort retires the import plan", async () => {
    const sql = createEphemeralSql();
    const clock = () => new Date("2026-09-20T00:00:00.000Z");
    let initialMode: "lost" | "succeed" = "lost";
    const initialOperationIds: string[] = [];
    const recoveryOperationIds: string[] = [];
    const provider = providerWith({
      adopt: async (input) => {
        initialOperationIds.push(input.operationId);
        return initialMode === "lost"
          ? failed("unavailable", "the initial adoption response was lost", true)
          : succeeded({ nativeId: input.nativeId, observed: input.spec, outputs: {} });
      },
      recoverAdopt: async (input) => {
        recoveryOperationIds.push(input.operationId);
        return failedWithoutProviderOperationMutation(
          input.operationId,
          "not_found",
          "the exact adoption reservation was durably closed without provider effects",
        );
      },
    });
    const driver = createProviderDriver({
      providers: [provider],
      catalog: createCatalog([soldOffering]),
      ledger: createLedger(sql, clock),
      deployments: createResourceDeploymentStore(sql, clock),
    });
    let ids = 0;
    const host = createConfiguredHistoricalTakoformHost({
      sql,
      objects: createMemoryObjectStore(),
      forms: [form],
      driver,
      authenticate: async () => ({ tenantId, principalId: "principal-adoption-recovery" }),
      routes: {
        hostApiVersion: "forms.takoform.com/v1beta4",
        apiPath: lane,
        supportProfileApiVersion: "support.takoform.com/v1alpha2",
        reviewSpecDigest: true,
      },
      clock,
      randomId: () => `adoption-recovery-${++ids}`,
    });
    const requestImport = () =>
      host.handle(
        new Request(
          `https://host.invalid${lane}/resources/example.forms.invalid/AdoptedThing/imported/import`,
          {
            method: "POST",
            headers: {
              authorization: "Bearer test",
              "content-type": "application/json",
              "idempotency-key": "adoption-recovery-import-0001",
              "if-none-match": "*",
            },
            body: JSON.stringify({
              apiVersion: form.identity.formRef.apiVersion,
              kind: form.identity.formRef.kind,
              form: { formRef: form.identity.formRef },
              metadata: { name: "imported", space: "main" },
              spec: { value: "existing" },
              nativeId: "native-existing",
            }),
          },
        ),
      );

    const lost = await requestImport();
    expect(lost?.status).toBe(503);
    const pending = await sql.query(
      `SELECT operation_id, provider_outcome FROM tf_provider_mutation_sagas`,
    );
    expect(pending).toEqual([
      { operation_id: expect.any(String), provider_outcome: "indeterminate" },
    ]);
    const operationId = String(pending[0]?.operation_id);
    expect(initialOperationIds).toEqual([operationId]);

    const aborted = await requestImport();
    expect(aborted?.status).toBe(404);
    expect(await aborted?.json()).toMatchObject({
      error: {
        code: "resource_not_found",
        message: "the exact adoption reservation was durably closed without provider effects",
      },
    });
    expect(recoveryOperationIds).toEqual([operationId]);
    expect(await sql.query(`SELECT operation_id FROM tf_provider_mutation_sagas`)).toEqual([]);
    expect(await sql.query(`SELECT uid FROM tf_resources`)).toEqual([]);
    expect(await sql.query(`SELECT resource_uid FROM tf_resource_deletion_attestations`)).toEqual(
      [],
    );
    expect(await sql.query(`SELECT effect_id FROM tf_resource_provider_effects`)).toEqual([]);

    initialMode = "succeed";
    const retried = await requestImport();
    expect(retried?.status).toBe(201);
    expect(initialOperationIds).toHaveLength(2);
    expect(initialOperationIds[1]).not.toBe(operationId);
  });
});

function providerWith(options: {
  readonly adopt?: NonNullable<Provider["adopt"]>;
  readonly recoverAdopt?: NonNullable<Provider["recoverAdopt"]>;
  readonly convergeApply?: NonNullable<Provider["convergeApply"]>;
  readonly recoverDelete?: NonNullable<Provider["recoverDelete"]>;
  readonly poll?: NonNullable<Provider["poll"]>;
}): Provider {
  return {
    id: "recovery-provider",
    offerings: [providerOffering],
    async apply() {
      return failed("unavailable", "not used", true);
    },
    async observe() {
      return failed("not_found", "not used");
    },
    async delete() {
      return failed("not_found", "not used");
    },
    adopt:
      options.adopt ??
      (async (input) => succeeded({ nativeId: input.nativeId, observed: input.spec, outputs: {} })),
    ...(options.recoverAdopt ? { recoverAdopt: options.recoverAdopt } : {}),
    ...(options.convergeApply ? { convergeApply: options.convergeApply } : {}),
    ...(options.recoverDelete ? { recoverDelete: options.recoverDelete } : {}),
    ...(options.poll ? { poll: options.poll } : {}),
  };
}

async function rejectedImport(
  provider: Provider,
  mutation: {
    readonly operationMode: "initial" | "recovery";
    readonly providerHandle?: string;
  },
): Promise<unknown> {
  const { driver } = providerDriver(provider);
  const input: Parameters<NonNullable<TakoformResourceDriver["import"]>>[0] = {
    operationId: "operation-1",
    operationMode: mutation.operationMode,
    ...(mutation.providerHandle ? { providerHandle: mutation.providerHandle } : {}),
    executionAuthority: {
      tenantId,
      resourceUid: "resource-1",
      leaseToken: "lease-1",
      fingerprint: "fingerprint-1",
    },
    tenantId,
    resourceUid: "resource-1",
    form,
    name: "imported",
    space: "main",
    spec: { value: "existing" },
    nativeId: "native-existing",
    relations: [],
  };
  return await rejected(driver.import?.(input), "provider import");
}

async function rejectedApply(provider: Provider): Promise<unknown> {
  const { driver } = providerDriver(provider);
  return await rejected(
    driver.apply({
      operationId: "operation-1",
      operationKey: "operation-key-1",
      operationMode: "recovery",
      executionAuthority: executionAuthority(),
      tenantId,
      resourceUid: "resource-1",
      form,
      name: "created",
      space: "main",
      spec: { value: "created" },
      relations: [],
    }),
    "provider apply",
  );
}

async function rejectedDelete(provider: Provider): Promise<unknown> {
  const { driver, deployments } = providerDriver(provider);
  await deployments.create({
    tenantId,
    id: "deployment-1",
    resourceUid: "resource-1",
    offeringId: soldOffering.id,
    providerPackRef: soldOffering.providerPackRef,
    providerInstallationRef: soldOffering.providerInstallationRef,
    nativeId: "native-existing",
    state: "active",
    observed: {},
    outputs: {},
  });
  return await rejected(
    driver.delete({
      operationId: "operation-1",
      operationMode: "recovery",
      executionAuthority: executionAuthority(),
      tenantId,
      resourceUid: "resource-1",
      resource: {
        apiVersion: form.identity.formRef.apiVersion,
        kind: form.identity.formRef.kind,
        form: form.identity,
        metadata: {
          name: "imported",
          space: "main",
          uid: "resource-1",
          generation: "1",
          revision: "1",
        },
        spec: { value: "existing" },
        status: { observedGeneration: "1", conditions: [] },
      },
      relations: [],
    }),
    "provider delete",
  );
}

function providerDriver(provider: Provider) {
  const sql = createEphemeralSql();
  const clock = () => new Date("2026-09-20T00:00:00.000Z");
  const deployments = createResourceDeploymentStore(sql, clock);
  return {
    deployments,
    driver: createProviderDriver({
      providers: [provider],
      catalog: createCatalog([soldOffering]),
      ledger: createLedger(sql, clock),
      deployments,
    }),
  };
}

function executionAuthority() {
  return {
    tenantId,
    resourceUid: "resource-1",
    leaseToken: "lease-1",
    fingerprint: "fingerprint-1",
  } as const;
}

async function rejected(work: Promise<unknown> | undefined, name: string): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error(`expected ${name} to fail`);
}
