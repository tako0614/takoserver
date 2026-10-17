import { expect, test } from "bun:test";
import type {
  MoneyHeldNormalWorkerModeFacts as CuratedNormalFacts,
  MoneyUnitHeldNormalWorkerModePreparation as CuratedNormalPreparation,
} from "@takoserver/core/deploy-extension";
import * as deployExtension from "@takoserver/core/deploy-extension";
import {
  assertMoneyUnitHeldConvertCurrent as assertCuratedHeldConvertCurrent,
  assertMoneyUnitHeldNormalWorkerModePreparationCurrent as assertCuratedNormalCurrent,
} from "@takoserver/core/deploy-extension";
import type { MoneyHeldNormalWorkerModeFacts } from "../scripts/deploy/schema-money-unit-cutover.ts";

import {
  assertMoneyUnitHeldConvertCurrent,
  assertMoneyUnitHeldNormalWorkerModePreparationCurrent,
  loadMoneyUnitOriginalCutoverOptions,
  type MoneyUnitHeldNormalWorkerModePreparation,
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

test("the curated held-convert assertion retains the original owner's identity check", async () => {
  expect(assertCuratedHeldConvertCurrent).toBe(assertMoneyUnitHeldConvertCurrent);
  let factReads = 0;
  const supplied = {
    kind: "takoserver.money-held-convert-context@v1",
    get facts() {
      factReads++;
      throw new Error("caller facts were read");
    },
  };
  await expect(assertCuratedHeldConvertCurrent(supplied)).rejects.toThrow(
    "context or source request differs",
  );
  expect(factReads).toBe(0);
});

test("the curated normal mode port exports exact aliases and the original assertion only", () => {
  // Compile-time bidirectional alias checks only; no preparation/context
  // instance or genuine owner is manufactured by these boolean DATA values.
  const typeContract: [
    CuratedNormalPreparation extends MoneyUnitHeldNormalWorkerModePreparation ? true : never,
    MoneyUnitHeldNormalWorkerModePreparation extends CuratedNormalPreparation ? true : never,
    CuratedNormalFacts extends MoneyHeldNormalWorkerModeFacts ? true : never,
    MoneyHeldNormalWorkerModeFacts extends CuratedNormalFacts ? true : never,
  ] = [true, true, true, true];
  expect(typeContract).toEqual([true, true, true, true]);
  expect(assertCuratedNormalCurrent).toBe(assertMoneyUnitHeldNormalWorkerModePreparationCurrent);
  for (const forbidden of [
    "MoneyUnitHeldNormalWorkerModePreparation",
    "MoneyHeldNormalWorkerModeFacts",
    "loadMoneyUnitOriginalCutoverOptions",
    "readMoneyUnitHeldConvertContext",
    "readMoneyUnitHeldNormalWorkerModePreparation",
    "captureMoneyNativeBuildClosure",
    "inspectMoneyNormalWorkerModeFunctionSource",
    "inspectMoneyNativeBuildDependencyTree",
    "inspectMoneyNativeBuildSourceTree",
  ])
    expect(forbidden in deployExtension).toBe(false);
});

test("the curated normal assertion rejects caller/copy/inherited origins before fact getters", async () => {
  let factReads = 0;
  const supplied = {
    kind: "takoserver.money-held-normal-worker-mode-preparation@v1",
    get facts() {
      factReads++;
      throw new Error("caller preparation getter");
    },
  };
  for (const preparation of [
    supplied,
    { kind: supplied.kind, facts: {} },
    Object.create(supplied),
  ]) {
    await expect(assertCuratedNormalCurrent(preparation, {})).rejects.toThrow(
      "preparation origin differs",
    );
  }
  expect(factReads).toBe(0);
});
