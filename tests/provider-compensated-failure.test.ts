import { expect, test } from "bun:test";
import {
  CLOUDFLARE_PROVIDER_EXECUTOR_APPLY_COMPENSATION_SCHEMA,
  type CloudflareProviderApplyCompensationResult,
  type CloudflareProviderExecutorApplyCompensationEvidence,
  type CloudflareProviderExecutorApplyCompensationUnsupportedEvidence,
  failed,
  failedAfterProviderOperationCompensation,
  failedWithoutProviderMutation,
  failedWithoutProviderOperationMutation,
  providerFailureProvesNoMutation,
  providerFailureProvesWholeOperationCompensated,
  providerFailureProvesWholeOperationNoMutation,
} from "../src/provider-extension.ts";

test("provider extension exports the closed compensation wire contract", () => {
  const proof: CloudflareProviderExecutorApplyCompensationEvidence = {
    schema: CLOUDFLARE_PROVIDER_EXECUTOR_APPLY_COMPENSATION_SCHEMA,
    action: "compensateApply",
    operationId: "operation-1",
    providerInstallationRef: "cloudflare.primary",
    executionAuthority: {
      tenantId: "tenant-1",
      resourceUid: "resource-1",
      leaseToken: "lease-1",
      fingerprint: "fingerprint-1",
    },
  };
  const unsupported: CloudflareProviderExecutorApplyCompensationUnsupportedEvidence = {
    ...proof,
    action: "unsupported",
  };
  const result: CloudflareProviderApplyCompensationResult = {
    phase: "unsupported",
    executorApplyCompensationUnsupported: unsupported,
  };
  expect(proof.schema).toBe("takoserver.cloudflare-provider-executor-apply-compensation@v1");
  expect(result.phase).toBe("unsupported");
});

test("compensated failure proves only the exact terminated operation", () => {
  const ticket = failedAfterProviderOperationCompensation(
    "operation-1",
    "conflict",
    "the accepted create was compensated",
  );
  expect(ticket).toEqual({
    phase: "failed",
    failure: {
      code: "conflict",
      message: "the accepted create was compensated",
      retryable: false,
    },
  });
  expect(providerFailureProvesWholeOperationCompensated(ticket, "operation-1")).toBe(true);
  expect(providerFailureProvesWholeOperationCompensated(ticket, "operation-2")).toBe(false);
  expect(providerFailureProvesNoMutation(ticket, "operation-1")).toBe(false);
  expect(providerFailureProvesWholeOperationNoMutation(ticket, "operation-1")).toBe(false);
});

test("ordinary and no-effect failures cannot masquerade as compensation", () => {
  for (const ticket of [
    failed("conflict", "ordinary failure"),
    failedWithoutProviderMutation("operation-1", "conflict", "invocation had no effect"),
    failedWithoutProviderOperationMutation("operation-1", "conflict", "operation had no effect"),
  ]) {
    expect(providerFailureProvesWholeOperationCompensated(ticket, "operation-1")).toBe(false);
  }
});

test("compensation proof does not survive cloning or serialization", () => {
  const ticket = failedAfterProviderOperationCompensation(
    "operation-1",
    "conflict",
    "the accepted create was compensated",
  );
  expect(
    providerFailureProvesWholeOperationCompensated(structuredClone(ticket), "operation-1"),
  ).toBe(false);
  expect(providerFailureProvesWholeOperationCompensated({ ...ticket }, "operation-1")).toBe(false);
  expect(
    providerFailureProvesWholeOperationCompensated(
      JSON.parse(JSON.stringify(ticket)),
      "operation-1",
    ),
  ).toBe(false);
});
