import { expect, test } from "bun:test";
import {
  auth103NativeSourceCodeSelected,
  createWorkerEntry,
  hostedBrowserBillingPorts,
  type WorkerEnv,
} from "../src/entry-worker.ts";
import type { HostedBrowserBillingRpcSupplier } from "../src/financial-hosted-browser-rpc.ts";
import type { Row, SqlParam } from "../src/ports.ts";
import { migratedDatabase } from "./helpers/migrated-database.ts";

const supplier: HostedBrowserBillingRpcSupplier = {
  async readBrowserBillingContinuation() {
    throw new Error("mechanics test never calls Hosted");
  },
  async claimBrowserBillingContinuation() {
    throw new Error("mechanics test never calls Hosted");
  },
  async recordBrowserBillingContinuationOutcome() {
    throw new Error("mechanics test never calls Hosted");
  },
};

test("selected Entry port passes the exact Hosted binding object and omits a missing binding", () => {
  const selected = hostedBrowserBillingPorts(true, { HOSTED_BROWSER_BILLING_RPC: supplier });
  expect(Object.keys(selected)).toEqual(["hostedBrowserBillingRpc"]);
  expect(selected.hostedBrowserBillingRpc).toBe(supplier);
  expect(hostedBrowserBillingPorts(true, {})).toEqual({});
});

test("ordinary code selection never reads or passes a Hosted binding", () => {
  expect(auth103NativeSourceCodeSelected()).toBe(false);
  let reads = 0;
  const env = Object.defineProperty({}, "HOSTED_BROWSER_BILLING_RPC", {
    get(): never {
      reads++;
      throw new Error("ordinary Entry inspected Hosted binding");
    },
  }) as Pick<WorkerEnv, "HOSTED_BROWSER_BILLING_RPC">;
  expect(hostedBrowserBillingPorts(false, env)).toEqual({});
  expect(reads).toBe(0);
});

test("ordinary Worker request leaves an unrelated Hosted binding untouched", async () => {
  const database = migratedDatabase(98);
  database.exec(
    "INSERT INTO stripe_mode_realm (singleton, mode, pinned_at) VALUES (1, 'test', '2026-10-14T00:00:00.000Z')",
  );
  let reads = 0;
  try {
    const env: WorkerEnv = {
      PUBLIC_ORIGIN: "https://api.integration.example.test",
      STATE_DB: {
        prepare(sql) {
          let values: readonly SqlParam[] = [];
          return {
            bind(...params) {
              values = params;
              return this;
            },
            async all() {
              return {
                results: database
                  .query(sql)
                  .all(
                    ...values.map((value) =>
                      value instanceof ArrayBuffer ? new Uint8Array(value) : value,
                    ),
                  ) as Row[],
              };
            },
          };
        },
        async batch(statements) {
          return await Promise.all(statements.map((statement) => statement.all()));
        },
      },
      OBJECTS: {
        async put() {
          return null;
        },
        async get() {
          return null;
        },
        async head() {
          return null;
        },
        async delete() {},
        async list() {
          return { objects: [], truncated: false };
        },
      },
      WORKER_VERSION: { id: "00000000-0000-4000-8000-0000000000a1" },
      TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
        documentation: "https://docs.example.invalid/takoform-v2",
        authenticationDocumentation: "https://docs.example.invalid/takoform-v2/authentication",
      }),
      TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: "A".repeat(43),
    };
    Object.defineProperty(env, "HOSTED_BROWSER_BILLING_RPC", {
      get(): never {
        reads++;
        throw new Error("ordinary request inspected Hosted binding");
      },
    });
    const response = await createWorkerEntry().fetch(
      new Request(`${env.PUBLIC_ORIGIN}/healthz`),
      env,
    );
    // The ordinary App handles this unknown route; startup refusal would be 503.
    expect(response.status).toBe(404);
    expect(reads).toBe(0);
  } finally {
    database.close();
  }
});
