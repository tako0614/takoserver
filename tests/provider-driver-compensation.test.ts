import { expect, test } from "bun:test";
import { createCatalog } from "../src/catalog.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { createLedger } from "../src/ledger.ts";
import * as Driver from "../src/provider-driver.ts";
import {
  failed,
  failedAfterProviderOperationCompensation,
  failedWithoutProviderMutation,
  failedWithoutProviderOperationMutation,
  type Provider,
  type ProviderApplyCompensationInput,
  type ProviderApplyCompensationResult,
  type ProviderOffering,
  running,
  succeeded,
} from "../src/provider-port.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import { TAKOFORM_APPLY_SELECTION_VERSION } from "../src/takoform/apply-selection.ts";
import type { InstalledTakoformForm, TakoformResourceDriver } from "../src/takoform/types.ts";

const formRef = {
  apiVersion: "example.forms.invalid",
  kind: "CompensationProbe",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
} as const;
const form: InstalledTakoformForm = {
  identity: { formRef },
  role: "attachment",
  desiredSchema: { type: "object", additionalProperties: false },
  operations: ["create", "delete"],
};
const offering: ProviderOffering = {
  id: "compensation-probe",
  kind: "compensation_probe",
  displayName: "Compensation probe",
  form: formRef,
  providedInterfaces: [],
  bindingRefs: [],
  capabilities: ["create", "delete", "observe"],
};
type Input = Parameters<NonNullable<TakoformResourceDriver["compensateApply"]>>[0];
const operationId = "compensation-driver-operation";

function fixture(
  compensate: (input: ProviderApplyCompensationInput) => Promise<ProviderApplyCompensationResult>,
  amountMinor = 0,
) {
  const sql = createEphemeralSql();
  const clock = () => new Date("2026-09-23T10:00:00.000Z");
  const ledger = createLedger(sql, clock);
  const calls: ProviderApplyCompensationInput[] = [];
  const provider: Provider = {
    id: "compensation-probe-provider",
    offerings: [offering],
    async apply() {
      throw new Error("apply must not run");
    },
    async observe() {
      throw new Error("observe must not run");
    },
    async delete() {
      throw new Error("delete must not run");
    },
    async compensateApply(input) {
      calls.push(structuredClone(input));
      return compensate(input);
    },
  };
  const input: Input = {
    operationId,
    executionAuthority: {
      tenantId: "tenant-a",
      resourceUid: "uid-compensation-probe",
      leaseToken: "lease-compensation-probe",
      fingerprint: "fingerprint-compensation-probe",
    },
    tenantId: "tenant-a",
    resourceUid: "uid-compensation-probe",
    form,
    name: "probe",
    space: "main",
    selection: {
      version: TAKOFORM_APPLY_SELECTION_VERSION,
      kind: "provider",
      providerPackRef: provider.id,
      providerInstallationRef: "compensation-probe-provider.primary",
      technicalOffering: offering,
      relations: [],
      ...(amountMinor > 0
        ? {
            sold: {
              offeringId: offering.id,
              offeringDigest: formRef.schemaDigest,
              pricePlanRef: "compensation.price",
              pricePlan: {
                id: "compensation.price",
                currency: "USD" as const,
                provisioning: { meter: "compensation.create", amountMinor },
                meters: [],
              },
            },
          }
        : {}),
    },
  };
  const driver = Driver.createProviderDriver({
    providers: [provider],
    catalog: createCatalog([]),
    ledger,
    deployments: createResourceDeploymentStore(sql, clock),
  });
  return { driver, input, calls, ledger, provider };
}

test("compensation carries the exact hold to distinct atomic settlement without releasing it", async () => {
  const f = fixture(async (input) => {
    Object.assign(input.executionAuthority, { leaseToken: "changed-by-provider" });
    return failedAfterProviderOperationCompensation(operationId, "conflict", "compensated");
  }, 25);
  await f.ledger.fund({ organizationId: "tenant-a", fundingRef: "fund", amountMinor: 100 });
  const error = await f.driver.compensateApply?.(f.input).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(Driver.ProviderMutationCompensatedFailureError);
  expect(error).not.toBeInstanceOf(Driver.ProviderMutationWholeOperationRefusalError);
  expect(error).toMatchObject({
    action: "compensateApply",
    heldCharge: { reference: operationId, amountMinor: 25 },
  });
  expect(await f.ledger.wallet("tenant-a")).toMatchObject({
    settledMinor: 100,
    heldMinor: 25,
    availableMinor: 75,
  });
  expect(f.calls).toHaveLength(1);
  expect(Object.keys(f.calls[0] ?? {}).sort()).toEqual([
    "executionAuthority",
    "identity",
    "offering",
    "operationId",
    "providerInstallationRef",
  ]);
  expect(f.input.executionAuthority.leaseToken).toBe("lease-compensation-probe");
});

const inconclusive = [
  ["ordinary refusal", () => failed("conflict", "held")],
  ["invocation no-effect", () => failedWithoutProviderMutation(operationId, "conflict", "held")],
  [
    "operation no-effect",
    () => failedWithoutProviderOperationMutation(operationId, "conflict", "held"),
  ],
  [
    "wrong operation",
    () => failedAfterProviderOperationCompensation("another-operation", "conflict", "held"),
  ],
  [
    "cloned proof",
    () =>
      structuredClone(failedAfterProviderOperationCompensation(operationId, "conflict", "held")),
  ],
  [
    "handled proof",
    () =>
      Object.assign(failedAfterProviderOperationCompensation(operationId, "conflict", "held"), {
        handle: "compensation-handle",
      }),
  ],
  ["running", () => running("compensation-handle")],
  ["success", () => succeeded({ nativeId: "not-an-apply", observed: {}, outputs: {} })],
] as const;
for (const [label, ticket] of inconclusive) {
  test(`compensation keeps ${label} held without promoting a compensation handle`, async () => {
    const f = fixture(async () => ticket());
    const error = await f.driver.compensateApply?.(f.input).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Driver.ProviderMutationRecoveryError);
    expect(error).toMatchObject({ providerOutcome: "indeterminate" });
    expect((error as Driver.ProviderMutationRecoveryError).providerHandle).toBeUndefined();
  });
}

test("prewrite unsupported is distinct from failure and missing selected provider", async () => {
  const f = fixture(async () => ({ phase: "unsupported" }));
  await expect(f.driver.compensateApply?.(f.input)).rejects.toBeInstanceOf(
    Driver.ProviderApplyCompensationUnsupportedError,
  );
  const mismatched = structuredClone(f.input);
  if (mismatched.selection.kind !== "provider") throw new Error("fixture selection");
  Object.assign(mismatched.selection, { providerPackRef: "missing-provider" });
  await expect(f.driver.compensateApply?.(mismatched)).rejects.toBeInstanceOf(
    Driver.ProviderMutationRecoveryError,
  );
  expect(f.calls).toHaveLength(1);
});

test("wrong lease identity is rejected before compensation", async () => {
  const f = fixture(async () =>
    failedAfterProviderOperationCompensation(operationId, "conflict", "bad"),
  );
  const wrong = structuredClone(f.input);
  Object.assign(wrong.executionAuthority, { tenantId: "other-tenant" });
  await expect(f.driver.compensateApply?.(wrong)).rejects.toBeInstanceOf(
    Driver.ProviderMutationRecoveryError,
  );
  expect(f.calls).toHaveLength(0);
});

test("provider-thrown terminal errors cannot manufacture compensation proof", async () => {
  const f = fixture(async () => {
    throw new Driver.ProviderMutationCompensatedFailureError("resource_busy", 409);
  });
  await expect(f.driver.compensateApply?.(f.input)).rejects.toBeInstanceOf(
    Driver.ProviderMutationRecoveryError,
  );
});

test("missing capability is unsupported before provider entry or wallet hold", async () => {
  const f = fixture(async () => {
    throw new Error("must not run");
  }, 25);
  delete f.provider.compensateApply;
  await expect(f.driver.compensateApply?.(f.input)).rejects.toBeInstanceOf(
    Driver.ProviderApplyCompensationUnsupportedError,
  );
  expect(f.calls).toHaveLength(0);
  expect(await f.ledger.wallet("tenant-a")).toMatchObject({ heldMinor: 0 });
});

test("thrown compensation progress is not stored as an original apply handle", async () => {
  const f = fixture(async () => {
    throw new Driver.ProviderMutationRecoveryError("running", "compensation-handle");
  });
  const error = await f.driver.compensateApply?.(f.input).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(Driver.ProviderMutationRecoveryError);
  expect(error).toMatchObject({ providerOutcome: "indeterminate" });
  expect((error as Driver.ProviderMutationRecoveryError).providerHandle).toBeUndefined();
});
