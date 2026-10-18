import { expect, test } from "bun:test";
import type { FinancialCurrentConsentCustomerOperation } from "../src/financial-current-consent-customer.ts";
import {
  batchWorkerRequestFinancialCurrentConsentOriginal,
  queryWorkerRequestFinancialCurrentConsentOriginal,
  type WorkerRequestSql,
} from "../src/worker-request-composition.ts";

test("Financial internal native receiver refuses copied connections and fabricated operations", async () => {
  let inspected = 0;
  const fakeOperation = Object.defineProperty(Object.create(null), "kind", {
    get() {
      inspected++;
      throw new Error("untrusted operation inspected");
    },
  }) as FinancialCurrentConsentCustomerOperation;
  const copiedConnection = Object.freeze({}) as WorkerRequestSql;

  await expect(
    queryWorkerRequestFinancialCurrentConsentOriginal(copiedConnection, fakeOperation),
  ).rejects.toThrow("not been constructed");
  await expect(
    batchWorkerRequestFinancialCurrentConsentOriginal(copiedConnection, fakeOperation),
  ).rejects.toThrow("not been constructed");
  expect(inspected).toBe(0);
});
