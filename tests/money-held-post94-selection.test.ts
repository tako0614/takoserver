import { expect, test } from "bun:test";

import {
  assertMoneyUnitHeldPost94DispatchSelection,
  assertMoneyUnitHeldPost94SelectionCurrent,
  assertMoneyUnitHeldPost94SelectionOrigin,
  readMoneyUnitHeldPost94Selection,
  type MoneyUnitHeldConvertContext,
  type MoneyUnitHeldPost94Selection,
} from "../scripts/deploy/schema-money-unit-owner.ts";
import {
  moneyCutoverBindingDigest,
  type MoneyPost94SelectionReviewBinding,
} from "../scripts/deploy/schema-money-unit-cutover.ts";

const EPOCH = `sha256:${"a".repeat(64)}`;

test("caller selection DTO and copies cannot trigger a protected or native read", async () => {
  let getterReads = 0;
  const dto = {
    kind: "takoserver.money-held-post94-selection@v1",
    get selectedStripeMode() {
      getterReads++;
      throw new Error("caller mode getter");
    },
  };
  await expect(assertMoneyUnitHeldPost94SelectionCurrent(dto)).rejects.toThrow(
    "not the original owner selection",
  );
  const copy = Object.defineProperties({}, Object.getOwnPropertyDescriptors(dto));
  await expect(assertMoneyUnitHeldPost94SelectionCurrent(copy)).rejects.toThrow(
    "not the original owner selection",
  );
  await expect(assertMoneyUnitHeldPost94SelectionCurrent(Object.create(dto))).rejects.toThrow(
    "not the original owner selection",
  );
  expect(getterReads).toBe(0);
});

test("a fake held context cannot select a suffix declaration", async () => {
  let getterReads = 0;
  const fake = {
    kind: "takoserver.money-held-convert-context@v1",
    get facts() {
      getterReads++;
      throw new Error("caller facts getter");
    },
  } as unknown as MoneyUnitHeldConvertContext;
  await expect(
    readMoneyUnitHeldPost94Selection(fake, "/nonexistent/held-suffix.json"),
  ).rejects.toThrow("context or source request differs");
  expect(getterReads).toBe(0);
});

test("same-context assertion rejects caller selections without reading foreign getters", async () => {
  let selectionGetterReads = 0;
  let contextGetterReads = 0;
  const fakeSelection = {
    kind: "takoserver.money-held-post94-selection@v1",
    get phase() {
      selectionGetterReads++;
      throw new Error("caller phase getter");
    },
  };
  const copiedSelection = Object.defineProperties(
    {},
    Object.getOwnPropertyDescriptors(fakeSelection),
  );
  const foreignContext = {
    get facts() {
      contextGetterReads++;
      throw new Error("foreign context getter");
    },
  };
  for (const selection of [fakeSelection, copiedSelection, Object.create(fakeSelection)]) {
    await expect(
      assertMoneyUnitHeldPost94SelectionOrigin(selection, foreignContext),
    ).rejects.toThrow("not the original owner selection");
  }
  expect(selectionGetterReads).toBe(0);
  expect(contextGetterReads).toBe(0);
  // A genuine selection/context mismatch requires a native original-owner
  // fixture; these negatives do not exercise that positive path.
});

test("missing or wrong TEST data cannot bypass absent original selection", async () => {
  const fake = {
    kind: "takoserver.money-held-post94-selection@v1",
    phase: "suffix98",
  } as unknown as MoneyUnitHeldPost94Selection;
  for (const selectedStripeMode of [undefined, "live"]) {
    let getterReads = 0;
    const binding = {
      kind: "takoserver.money-cutover-dispatch@v2",
      phase: "suffix98",
      selectedStripeMode,
      get selectionReviewDigest() {
        getterReads++;
        throw new Error("caller review getter");
      },
    };
    await expect(assertMoneyUnitHeldPost94DispatchSelection(fake, binding)).rejects.toThrow(
      "not the original owner selection",
    );
    expect(getterReads).toBe(0);
  }
});

test("post94 selection review digest commits the explicit TEST value", () => {
  const binding: MoneyPost94SelectionReviewBinding = {
    kind: "takoserver.money-post94-selection-review@v1",
    phase: "suffix98",
    accountId: "a".repeat(32),
    databaseId: "00000000-0000-0000-0000-000000000000",
    databaseName: "integration-ts-" + "a".repeat(32),
    previousWriterEpoch: EPOCH,
    nextWriterEpoch: `sha256:${"b".repeat(64)}`,
    original92BackupDigest: EPOCH,
    converted94BackupDigest: EPOCH,
    convertBindingDigest: EPOCH,
    selectedStripeMode: "test",
    declarationDigest: EPOCH,
  };
  const selectedDigest = moneyCutoverBindingDigest(binding);
  const missing = { ...binding } as Partial<MoneyPost94SelectionReviewBinding>;
  delete missing.selectedStripeMode;
  expect(
    moneyCutoverBindingDigest(missing as MoneyPost94SelectionReviewBinding),
  ).not.toBe(selectedDigest);
  expect(
    moneyCutoverBindingDigest({
      ...binding,
      selectedStripeMode: "live",
    } as unknown as MoneyPost94SelectionReviewBinding),
  ).not.toBe(selectedDigest);
});
