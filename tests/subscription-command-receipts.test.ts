import { expect, test } from "bun:test";
import {
  createSubscriptionCommandReceipts,
  type SubscriptionCancellationCommandDescriptor,
  type SubscriptionPlanCommandDescriptor,
  type SubscriptionStartCommandDescriptor,
} from "../src/subscription-command-receipts.ts";

const organizationId = "org_receipts";
const reference = "original-command";
const subscriptionRef = `sra_${"a".repeat(64)}`;
const input = { organizationId, reference };
const cancellation: SubscriptionCancellationCommandDescriptor = {
  ...input,
  kind: "cancel",
  state: "verified",
  subscriptionRef,
  planKey: "usage-10",
  pricingRevision: "original-revision",
  effectiveAt: "2026-11-01T00:00:00.000Z",
  lifecycle: "scheduled",
};

test("original receipt captures only its history reader and falls back only for cancellation", async () => {
  const calls: string[] = [];
  const readers = {
    async readStart(): Promise<SubscriptionStartCommandDescriptor | null> {
      calls.push("start");
      return null;
    },
    async readNativeCancel() {
      calls.push("native-cancel");
      return cancellation;
    },
    async readExtension(_org: string, _ref: string, kind: "cancel" | "plan-change") {
      calls.push(kind);
      return null;
    },
  };
  const receipts = createSubscriptionCommandReceipts(readers);
  readers.readExtension = async () => {
    throw new Error("replacement reader must not run");
  };
  expect(await receipts.read({ ...input, kind: "start" })).toBeNull();
  expect(await receipts.read({ ...input, kind: "plan-change" })).toBeNull();
  expect(await receipts.read({ ...input, kind: "cancel" })).toEqual({
    ...cancellation,
    contractVersion: "hosted-subscription-command-v1",
    checkout: null,
    pendingChange: null,
  });
  expect(calls).toEqual(["start", "plan-change", "cancel", "native-cancel"]);
});

test("receipt exposes only the original public tuple after activation", async () => {
  const change = {
    planKey: "usage-50",
    pricingRevision: "future-revision",
    effectiveAt: "2026-11-01T00:00:00.000Z",
    processorObjectId: "internal-schedule-placeholder",
  };
  const plan: SubscriptionPlanCommandDescriptor = {
    ...input,
    kind: "plan-change",
    state: "verified",
    subscriptionRef,
    ...change,
    pendingChange: change,
    lifecycle: "activated",
  };
  const receipts = createSubscriptionCommandReceipts({
    readStart: async () => null,
    readNativeCancel: async () => null,
    readExtension: async () => plan,
  });
  const receipt = await receipts.read({ ...input, kind: "plan-change" });
  expect(receipt?.pendingChange).toEqual({
    planKey: change.planKey,
    pricingRevision: change.pricingRevision,
    effectiveAt: change.effectiveAt,
  });
  expect(receipt?.lifecycle).toBe("activated");
  expect(receipt?.subscriptionRef).toBe(subscriptionRef);
  expect(JSON.stringify(receipt)).not.toContain("internal-schedule-placeholder");
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(Object.isFrozen(receipt?.pendingChange)).toBe(true);
});

test("wrong original scope and corrupt proof remain unavailable without another lookup", async () => {
  let nativeReads = 0;
  for (const original of [
    { ...cancellation, organizationId: "foreign-org" },
    { ...cancellation, reference: "another-reference" },
    { ...cancellation, subscriptionRef: "provider-native-subscription" },
    { ...cancellation, effectiveAt: "2026-02-30T00:00:00.000Z" },
  ]) {
    const receipts = createSubscriptionCommandReceipts({
      readStart: async () => null,
      readNativeCancel: async () => {
        nativeReads++;
        return cancellation;
      },
      readExtension: async () => original,
    });
    await expect(receipts.read({ ...input, kind: "cancel" })).rejects.toMatchObject({
      code: "unavailable",
      message: "unavailable",
    });
  }
  const failed = createSubscriptionCommandReceipts({
    readStart: async () => null,
    readNativeCancel: async () => {
      nativeReads++;
      return cancellation;
    },
    readExtension: async () => {
      throw new Error("private processor context placeholder");
    },
  });
  await expect(failed.read({ ...input, kind: "cancel" })).rejects.toMatchObject({
    code: "unavailable",
    message: "unavailable",
  });
  expect(nativeReads).toBe(0);
});

test("malformed references cannot reach any history source", async () => {
  let reads = 0;
  const absent = async () => {
    reads++;
    return null;
  };
  const receipts = createSubscriptionCommandReceipts({
    readStart: absent,
    readNativeCancel: absent,
    readExtension: absent,
  });
  for (const candidate of [
    { ...input, reference: "../reference", kind: "start" as const },
    { ...input, organizationId: "", kind: "cancel" as const },
    { ...input, reference: "r".repeat(129), kind: "plan-change" as const },
  ]) {
    await expect(receipts.read(candidate)).rejects.toMatchObject({ code: "invalid_argument" });
  }
  expect(reads).toBe(0);
});

test("a phase cancellation cannot replace another native original target", async () => {
  for (const state of ["pending", "verified"] as const) {
    const phase: SubscriptionCancellationCommandDescriptor = {
      ...cancellation,
      subscriptionRef: `sra_${"b".repeat(64)}`,
      state,
      effectiveAt: state === "verified" ? cancellation.effectiveAt : null,
      lifecycle: state === "verified" ? "scheduled" : "pending",
    };
    const receipts = createSubscriptionCommandReceipts({
      readStart: async () => null,
      readNativeCancel: async () => cancellation,
      readExtension: async () => phase,
    });
    await expect(receipts.read({ ...input, kind: "cancel" })).rejects.toMatchObject({
      code: "unavailable",
    });
  }
});

test("phase cancellation requires its native proof but never promotes an incomplete saga", async () => {
  const phase: SubscriptionCancellationCommandDescriptor = {
    ...cancellation,
    planKey: "usage-50",
    pricingRevision: "phase-revision",
  };
  for (const native of [
    null,
    { ...cancellation, effectiveAt: "2026-12-01T00:00:00.000Z" },
    { ...cancellation, organizationId: "foreign-org" },
    {
      ...cancellation,
      state: "pending" as const,
      lifecycle: "pending" as const,
      effectiveAt: null,
    },
  ]) {
    const receipts = createSubscriptionCommandReceipts({
      readStart: async () => null,
      readNativeCancel: async () => native,
      readExtension: async () => phase,
    });
    await expect(receipts.read({ ...input, kind: "cancel" })).rejects.toMatchObject({
      code: "unavailable",
    });
  }
  const acknowledged = createSubscriptionCommandReceipts({
    readStart: async () => null,
    readNativeCancel: async () => cancellation,
    readExtension: async () => phase,
  });
  expect(await acknowledged.read({ ...input, kind: "cancel" })).toMatchObject({
    state: "verified",
    subscriptionRef,
    planKey: phase.planKey,
    pricingRevision: phase.pricingRevision,
    effectiveAt: cancellation.effectiveAt,
  });
  const pending = createSubscriptionCommandReceipts({
    readStart: async () => null,
    readNativeCancel: async () => cancellation,
    readExtension: async () => ({
      ...phase,
      state: "pending" as const,
      lifecycle: "pending" as const,
      effectiveAt: null,
    }),
  });
  expect(await pending.read({ ...input, kind: "cancel" })).toMatchObject({
    state: "pending",
    subscriptionRef,
    effectiveAt: null,
    lifecycle: "pending",
  });
});
