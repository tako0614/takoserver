import { expect, test } from "bun:test";

import {
  assertMoneyUnitHeldConvertCurrent,
  loadMoneyUnitOriginalCutoverOptions,
  type MoneyUnitOriginalCutoverOptions,
  type MoneyUnitOriginalCutoverRequest,
  readMoneyUnitHeldConvertContext,
} from "../scripts/deploy/schema-money-unit-owner.ts";

const EPOCH = `sha256:${"a".repeat(64)}`;
const NEXT_EPOCH = `sha256:${"b".repeat(64)}`;

test("caller dependency Proxy shape traps are ignored before request validation", async () => {
  let shapeReads = 0;
  let portReads = 0;
  const injected = new Proxy(
    {},
    {
      getPrototypeOf() {
        shapeReads++;
        return Object.prototype;
      },
      ownKeys() {
        shapeReads++;
        return [];
      },
      get() {
        portReads++;
        throw new Error("injected port read");
      },
    },
  );
  // Invalid request stops before the original owner touches a provider or a
  // port. This tests removal of the former shape probe; it does not qualify
  // the native owner or exercise a successful authorization route.
  await expect(
    loadMoneyUnitOriginalCutoverOptions({} as MoneyUnitOriginalCutoverRequest, injected),
  ).rejects.toThrow("fresh money writer requires only target and original custody locators");
  expect(shapeReads).toBe(0);
  expect(portReads).toBe(0);
});

test("a caller DTO cannot enter the original held-convert owner", async () => {
  let methodReads = 0;
  const component = {
    get stageOriginProof() {
      methodReads++;
      throw new Error("caller port was read");
    },
  } as unknown as MoneyUnitOriginalCutoverOptions;
  await expect(
    readMoneyUnitHeldConvertContext(component, {
      previousWriterEpoch: EPOCH,
      nextWriterEpoch: NEXT_EPOCH,
      convertedBackupPath: "/nonexistent/protected94.sql",
      selectedStripeMode: "test",
    }),
  ).rejects.toThrow("unchanged native original owner methods");
  expect(methodReads).toBe(0);
});

test("a copied or inherited context shape cannot trigger a currentness read", async () => {
  let factReads = 0;
  const supplied = {
    kind: "takoserver.money-held-convert-context@v1",
    get facts() {
      factReads++;
      throw new Error("caller facts were read");
    },
  };
  await expect(assertMoneyUnitHeldConvertCurrent(supplied)).rejects.toThrow(
    "context or source request differs",
  );
  const copied = { kind: supplied.kind, facts: {} };
  await expect(assertMoneyUnitHeldConvertCurrent(copied)).rejects.toThrow(
    "context or source request differs",
  );
  const inherited = Object.create(copied);
  await expect(assertMoneyUnitHeldConvertCurrent(inherited)).rejects.toThrow(
    "context or source request differs",
  );
  expect(factReads).toBe(0);
});
