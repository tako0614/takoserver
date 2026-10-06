import { expect, test } from "bun:test";
import { buildApp, createAppResourceStoreBundle } from "../src/app.ts";
import { createEphemeralSql, InMemoryTakoformResourceDriver } from "../src/index.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { TEST_TAKOFORM_V2_CONFIG } from "./helpers/takoform-v2-config.ts";

test("precomposed Actor startup stores are the exact stores used by the app", () => {
  const sql = createEphemeralSql();
  const otherSql = createEphemeralSql();
  const clock = () => new Date("2026-10-03T00:00:00.000Z");
  const stores = createAppResourceStoreBundle(sql, clock);
  let received: unknown;
  const ports = {
    sql,
    clock,
    objects: createMemoryObjectStore(),
    identity: {
      async verify() {
        throw new Error("not configured");
      },
    },
    settlement: {
      async verify() {
        throw new Error("not configured");
      },
    },
    publicOrigin: "https://api.example.test",
    v2: TEST_TAKOFORM_V2_CONFIG,
    forms: [],
    hostForms: [],
    offerings: [],
    driver: new InMemoryTakoformResourceDriver(),
    resourceStores: stores,
    selfhostEndpointIngressFactory(context: unknown) {
      received = context;
      return async () => null;
    },
  };
  buildApp(ports);
  expect(received).toEqual({ store: stores.inventory, deployments: stores.deployments });
  expect(() => buildApp({ ...ports, sql: otherSql })).toThrow(
    "precomposed resource stores do not belong",
  );
  expect(() => buildApp({ ...ports, clock: () => clock() })).toThrow(
    "precomposed resource stores do not belong",
  );
  expect(() =>
    buildApp({
      ...ports,
      resourceStores: { inventory: stores.inventory, deployments: stores.deployments },
    }),
  ).toThrow("precomposed resource stores do not belong");
});
