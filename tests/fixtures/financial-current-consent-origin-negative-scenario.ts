import { expect, mock, test } from "bun:test";
import type { Sql } from "../../src/ports.ts";
import { fixture as customerFixture } from "./financial-customer-five-action-fixture.ts";

// Isolated negative source test. The Root/RP modules here are synthetic; this
// does not qualify a positive request origin or native D1 execution.
const connection = Object.freeze({}) as never;
const heldConsentRef = "held:foreign-consent-proof";
const realm = Object.freeze({ financialRealm: "held-realm" });
const observed = { queries: 0, batches: 0, parsed: 0, definitions: 0 };
const sql: Sql = Object.freeze({
  async query() {
    observed.queries++;
    return [];
  },
  async run() {
    throw new Error("unexpected write");
  },
  async batch() {
    observed.batches++;
    return [];
  },
});
let inputs: object = Object.freeze({ sql, realm, writerEpoch: `sha256:${"a".repeat(64)}` });
let consentReads = 0;
const graph = Object.freeze({ sql, realm });
const record = Object.freeze({});
const currentSession = Object.freeze({});
const retained = Object.freeze({ record, current: currentSession });
const port = Object.freeze({
  readValidatedCredential: () => ({
    backend: "shared-rp-session",
    record,
    current: currentSession,
  }),
  readValidatedPrincipalBinding: () => ({ binding: {} }),
});
const context = Object.freeze({ sql, realm });
const captures = Object.freeze({ credential: Object.freeze({}), userBinding: Object.freeze({}) });
const selected = Object.freeze({
  selectedTerms: {
    ref: "held-terms",
    digest: "held-digest",
    mediaType: "text/plain",
    locale: "en",
    bodyByteLength: 1,
    digestRecipe: "held-recipe",
  },
  original: { c0: { selection: { customer: {} } } },
});

const originalWorker = await import("../../src/worker-request-composition.ts");
const originalAuth = await import("../../src/financial-auth-consumer.ts");
const originalR1 = await import("../../src/shared-financial-retained-r1.ts");
const originalConsent = await import("../../src/shared-auth-financial-consent.ts");
const originalConsentContract = await import("../../src/shared-auth-financial-consent-contract.ts");
const originalCustomer = await import("../../src/stripe-customer-custody.ts");

mock.module("../../src/worker-request-composition.ts", () => ({
  ...originalWorker,
  readWorkerRequestConsumers: (actual: unknown) => {
    if (actual !== connection) throw new Error("foreign connection");
    return graph;
  },
  readWorkerRequestFinancialInputs: (actual: unknown) => {
    if (actual !== connection) throw new Error("foreign connection");
    return inputs;
  },
  readWorkerRequestRetainedRpCapture: (actual: unknown) => {
    if (actual !== connection) throw new Error("foreign connection");
    return retained;
  },
}));
mock.module("../../src/financial-auth-consumer.ts", () => ({
  ...originalAuth,
  readWorkerRequestFinancialAuthConsumerPort: () => port,
  readWorkerRequestFinancialAuthConsumerContext: () => context,
  assertFinancialAuthConsumerPort: () => undefined,
  financialAuthConsumerSourceCurrentness: () => {
    throw new Error("unexpected write currentness");
  },
}));
mock.module("../../src/shared-financial-retained-r1.ts", () => ({
  ...originalR1,
  readFinancialActionConsentR1RequestCaptures: () => captures,
}));
mock.module("../../src/shared-auth-financial-consent.ts", () => ({
  ...originalConsent,
  readSharedAuthFinancialConsentCurrentOriginalData: () => {
    consentReads++;
    return {
      original: {
        originalBytes: new ArrayBuffer(0),
        command: { key: { consentRef: heldConsentRef } },
      },
      sampledAt: 1,
    };
  },
}));
mock.module("../../src/shared-auth-financial-consent-contract.ts", () => ({
  ...originalConsentContract,
  parseSharedAuthFinancialActionConsentOriginal: async () => {
    observed.parsed++;
    return { consentRef: heldConsentRef };
  },
}));
mock.module("../../src/stripe-customer-custody.ts", () => ({
  ...originalCustomer,
  createStripeCustomerOriginalDefinition: async () => {
    observed.definitions++;
    return {};
  },
}));

const { createFinancialCurrentConsentCustomerExecutor } = await import(
  "../../src/financial-current-consent-customer.ts"
);

test("selected consent proof mismatch mints no fixed read or batch operation", async () => {
  const f = await customerFixture(true);
  try {
    const phase = {
      phase: "L1" as const,
      admission: f.admission,
      history: f.journal,
      writerEpoch: `sha256:${"e".repeat(64)}`,
      couplingAttemptRef: "foreign:attempt",
      entryRef: "foreign:entry",
      historyReceiptRef: "foreign:history",
    };
    expect(phase.admission.input.consent.consentProofRef).not.toBe(heldConsentRef);
    const executor = createFinancialCurrentConsentCustomerExecutor(
      connection,
      {},
      new Request("https://fixture.invalid/foreign"),
      "held-workspace",
      {},
      {},
      selected as never,
    );
    const result = await executor.executePhase(phase);
    expect(result.status).toBe("get-only");
    expect(result.observation.status).toBe("unavailable");
    expect(observed).toEqual({ queries: 0, batches: 0, parsed: 1, definitions: 1 });
    const recovery = await executor.readOriginal(phase);
    expect(recovery.status).toBe("get-only");
    expect(observed).toEqual({ queries: 0, batches: 0, parsed: 2, definitions: 2 });
  } finally {
    f.close();
  }
});

test("an unselected Money epoch refuses the Customer executor before consent or SQL", () => {
  const originalInputs = inputs;
  const before = { ...observed, consentReads };
  try {
    for (const writerEpoch of [undefined, "not-an-epoch"]) {
      inputs = Object.freeze({ sql, realm, writerEpoch });
      expect(() =>
        createFinancialCurrentConsentCustomerExecutor(
          connection,
          {},
          new Request("https://fixture.invalid/ordinary"),
          "held-workspace",
          {},
          {},
          selected as never,
        ),
      ).toThrow("financial current consent customer unavailable");
      expect({ ...observed, consentReads }).toEqual(before);
    }
  } finally {
    inputs = originalInputs;
  }
});
