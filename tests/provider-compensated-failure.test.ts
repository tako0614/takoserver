import { expect, test } from "bun:test";
import {
  failed,
  failedAfterProviderOperationCompensation,
  failedWithoutProviderMutation,
  failedWithoutProviderOperationMutation,
  providerFailureProvesNoMutation,
  providerFailureProvesWholeOperationCompensated,
  providerFailureProvesWholeOperationNoMutation,
} from "../src/provider-extension.ts";

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
