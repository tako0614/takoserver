import { expect, test } from "bun:test";
import {
  assertFinancialAuthConsumerPort,
  captureWorkerRequestFinancialAuthRpRequest,
  createWorkerRequestConsumersWithFinancialAuth,
  createWorkerRequestConsumersWithFinancialAuthSourceClock,
  createWorkerRequestFinancialAuthConsumerPort,
  type FinancialAuthConsumerContext,
  type FinancialAuthConsumerPort,
  FinancialAuthConsumerUnavailable,
  financialAuthConsumerSourceCurrentness,
} from "../src/financial-auth-consumer.ts";
import type { WorkerRequestSql } from "../src/worker-request-composition.ts";

// False-accept mechanics only. Native owner tests must supply genuine original
// platform/schema/source qualification; this file does not mock that qualifier.
const fakeContext = () =>
  ({
    sql: {},
    realm: {},
    writerEpoch: `sha256:${"a".repeat(64)}`,
    authSchemaRef: "synthetic-unqualified-auth103",
    targetRef: "synthetic-unqualified-target",
  }) as unknown as FinancialAuthConsumerContext;

test("matching port DTO and self assertion cannot enter the owning port origin", () => {
  let calls = 0;
  const port = {
    readValidatedCredential() {
      calls++;
      return {};
    },
    readValidatedPrincipalBinding() {
      calls++;
      return {};
    },
    assertFinancialAuthConsumerPort() {
      calls++;
      return true;
    },
  };
  expect(() => assertFinancialAuthConsumerPort(port, fakeContext())).toThrow(
    FinancialAuthConsumerUnavailable,
  );
  expect(calls).toBe(0);
});

test("unknown port rejects before alleged context or reader getters are evaluated", () => {
  let getters = 0;
  const bad = new Proxy(
    {},
    {
      get() {
        getters++;
        throw new Error("credential leak");
      },
      getOwnPropertyDescriptor() {
        getters++;
        throw new Error("untrusted descriptor");
      },
    },
  );
  expect(() => assertFinancialAuthConsumerPort(bad, bad as FinancialAuthConsumerContext)).toThrow(
    FinancialAuthConsumerUnavailable,
  );
  expect(getters).toBe(0);
});

test("schema and target strings cannot turn a forged Sql graph into a qualified port", async () => {
  let calls = 0;
  const fake = Object.freeze({
    moneyGuard: "ready",
    get sql(): never {
      calls++;
      throw new Error("fake primary");
    },
  });
  await expect(
    createWorkerRequestFinancialAuthConsumerPort(fake as WorkerRequestSql),
  ).rejects.toBeInstanceOf(FinancialAuthConsumerUnavailable);
  expect(calls).toBe(0);
});

test("explicit factory never evaluates a caller Clock or external principal getter before native origin", async () => {
  let calls = 0;
  const selected = {
    connection: {} as WorkerRequestSql,
    sql: {},
    client: {},
    realm: {},
    identity: {},
    randomId: () => "not-authority",
    publicOrigin: "https://unqualified.invalid",
    consoleOrigin: undefined,
    sharedAuth: Object.defineProperty({}, "principals", {
      get() {
        calls++;
        throw new Error("external principal");
      },
    }),
    get clock() {
      calls++;
      throw new Error("caller clock");
    },
  };
  await expect(
    createWorkerRequestConsumersWithFinancialAuth(selected as never),
  ).rejects.toBeInstanceOf(FinancialAuthConsumerUnavailable);
  expect(calls).toBe(0);
});

test("failure is finite unavailable and reveals no alleged credential or native detail", async () => {
  const credentialSentinel = "private-credential-value-never-log";
  let error: unknown;
  try {
    await createWorkerRequestFinancialAuthConsumerPort({
      get sql(): never {
        throw new Error(credentialSentinel);
      },
      moneyGuard: "ready",
    } as WorkerRequestSql);
  } catch (value) {
    error = value;
  }
  expect(error).toBeInstanceOf(FinancialAuthConsumerUnavailable);
  expect((error as FinancialAuthConsumerUnavailable).code).toBe("unavailable");
  expect((error as Error).message).toBe("financial_auth_consumer_unavailable");
  expect(String(error)).not.toContain(credentialSentinel);
});

test("request callsite rejects a matching port DTO before touching the request or selected workspace", async () => {
  let calls = 0;
  const fake = {
    readValidatedCredential() {
      calls++;
      throw new Error("forged credential");
    },
    readValidatedPrincipalBinding() {
      calls++;
      throw new Error("forged user");
    },
  } as FinancialAuthConsumerPort;
  const request = new Proxy({} as Request, {
    get() {
      calls++;
      throw new Error("forged request");
    },
  });
  await expect(
    captureWorkerRequestFinancialAuthRpRequest(fake, request, "synthetic-workspace"),
  ).rejects.toBeInstanceOf(FinancialAuthConsumerUnavailable);
  expect(calls).toBe(0);
});

test("source-currentness cannot be minted by a matching port DTO or caller SQL", () => {
  let calls = 0;
  const port = {
    readValidatedCredential() {
      calls++;
      return {};
    },
    readValidatedPrincipalBinding() {
      calls++;
      return {};
    },
    sourceCurrentness() {
      calls++;
      return { sql: "SELECT 1", params: [] };
    },
  } as unknown as FinancialAuthConsumerPort;
  expect(() => financialAuthConsumerSourceCurrentness(port, fakeContext())).toThrow(
    FinancialAuthConsumerUnavailable,
  );
  expect(calls).toBe(0);
});

test("entry graph factory rejects an unowned Clock before reading alleged constructor inputs", async () => {
  let calls = 0;
  const options = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        calls++;
        throw new Error("untrusted constructor descriptor");
      },
    },
  );
  const clock = () => new Date();
  await expect(
    createWorkerRequestConsumersWithFinancialAuthSourceClock(options as never, clock),
  ).rejects.toBeInstanceOf(FinancialAuthConsumerUnavailable);
  expect(calls).toBe(0);
});
