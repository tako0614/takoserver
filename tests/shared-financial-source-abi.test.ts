import { expect, test } from "bun:test";
import {
  FinancialSourceAbiError,
  type FinancialSourceAbiErrorCode,
  type FinancialSourceApplyRequest,
  type FinancialSourceReadRequest,
  type FinancialSourceReceiptRefInput,
  financialSourceReceiptRecordDigest,
  financialSourceReceiptRef,
  type MakeFinancialSourceReceiptInput,
  makeFinancialSourceReceipt,
  parseFinancialSourceApplyRequest,
  parseFinancialSourceReadRequest,
  verifyFinancialSourceApplyRequest,
} from "../src/shared-financial-source-abi.ts";
import {
  type FinancialSourceEvent,
  type FinancialSourceReceipt,
  type FinancialSourceReceiptRecord,
  financialSourceEventDigest,
} from "../src/shared-financial-source-contract.ts";

const EVENT: FinancialSourceEvent = {
  v: 1,
  eventRef: "event:one",
  registrationRef: "source:accounts",
  incarnation: "incarnation:one",
  sequence: 1,
  previousDigest: `sha256:${"1".repeat(64)}`,
  kind: "close",
  affectedRef: "grant:one",
  evidenceRef: "evidence:one",
};
// Accounts component-r1 owner vectors, independently retained as literal data.
const EVENT_DIGEST = "sha256:85dfc950d869c729357ad56b76bc83275053ea0b037f117649932a36d5924b93";
const RECEIPT_REF = "fsr_df35120d968c92051da0398de4d68fd0efc718f3302e671af09c09663b74c192";
const RECORD_DIGEST = "sha256:2a3fc7ee808cff8bbbc8805a20a06faff28b045628ae63b65b743f48f97751d9";
const APPLY: FinancialSourceApplyRequest = { v: 1, event: EVENT, eventDigest: EVENT_DIGEST };
const READ: FinancialSourceReadRequest = {
  v: 1,
  registrationRef: EVENT.registrationRef,
  eventRef: EVENT.eventRef,
  eventDigest: EVENT_DIGEST,
};
const REF: FinancialSourceReceiptRefInput = {
  registrationRef: EVENT.registrationRef,
  receiverRef: "receiver:financial",
  targetRef: "target:qualified",
  eventRef: EVENT.eventRef,
  eventDigest: EVENT_DIGEST,
  incarnation: EVENT.incarnation,
  sequence: EVENT.sequence,
  state: "admission-closed",
};
const RECEIPT: FinancialSourceReceipt = {
  v: 1,
  eventRef: EVENT.eventRef,
  eventDigest: EVENT_DIGEST,
  receiptRef: RECEIPT_REF,
  incarnation: EVENT.incarnation,
  sequence: 1,
  state: "admission-closed",
};
const RECORD: FinancialSourceReceiptRecord = {
  registrationRef: REF.registrationRef,
  receiverRef: REF.receiverRef,
  targetRef: REF.targetRef,
  receipt: RECEIPT,
};
const MAKE: MakeFinancialSourceReceiptInput = {
  registrationRef: REF.registrationRef,
  receiverRef: REF.receiverRef,
  targetRef: REF.targetRef,
  event: EVENT,
  eventDigest: EVENT_DIGEST,
};

function invalid(operation: () => unknown): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(FinancialSourceAbiError);
    expect(error).toMatchObject({ code: "invalid-request", message: "invalid-request" });
    return;
  }
  throw new Error("invalid request was accepted");
}
async function invalidAsync(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(FinancialSourceAbiError);
    expect(error).toMatchObject({ code: "invalid-request", message: "invalid-request" });
    return;
  }
  throw new Error("invalid request was accepted");
}

test("external apply/read envelopes preserve the frozen v1 wire and event digest", async () => {
  expect(await financialSourceEventDigest(EVENT)).toBe(EVENT_DIGEST);
  expect(await verifyFinancialSourceApplyRequest(APPLY)).toEqual(APPLY);
  expect(parseFinancialSourceReadRequest(READ)).toEqual(READ);
  expect(
    await verifyFinancialSourceApplyRequest(Object.fromEntries(Object.entries(APPLY).reverse())),
  ).toEqual(APPLY);
  expect(parseFinancialSourceReadRequest(Object.assign(Object.create(null), READ))).toEqual(READ);
});

test("parsing describes data while verification rejects an altered event before admission", async () => {
  const altered = { ...APPLY, event: { ...EVENT, evidenceRef: "evidence:other" } };
  expect(parseFinancialSourceApplyRequest(altered)).toEqual(altered);
  await invalidAsync(() => verifyFinancialSourceApplyRequest(altered));
  const otherDigest = `sha256:${"0".repeat(64)}` as const;
  await invalidAsync(() =>
    verifyFinancialSourceApplyRequest({ ...APPLY, eventDigest: otherDigest }),
  );
  // A read request alone cannot determine if this digest has a retained receipt.
  expect(parseFinancialSourceReadRequest({ ...READ, eventDigest: otherDigest }).eventDigest).toBe(
    otherDigest,
  );
});

test("closed envelopes reject old local calls and extra missing or null fields", () => {
  for (const value of [
    EVENT,
    null,
    undefined,
    [],
    { ...APPLY, v: 2 },
    { ...APPLY, event: null },
    { ...APPLY, eventDigest: null },
    { ...APPLY, eventDigest: EVENT_DIGEST.toUpperCase() },
    { ...APPLY, ready: true },
    { v: 1, event: EVENT },
  ])
    invalid(() => parseFinancialSourceApplyRequest(value));
  for (const value of [
    EVENT.eventRef,
    null,
    { ...READ, v: 2 },
    { ...READ, registrationRef: null },
    { ...READ, eventRef: null },
    { ...READ, eventDigest: null },
    { ...READ, event: EVENT },
    { v: 1, eventRef: EVENT.eventRef, eventDigest: EVENT_DIGEST },
  ])
    invalid(() => parseFinancialSourceReadRequest(value));
});

test("nested invalid events use the closed invalid-request fault", () => {
  for (const patch of [
    { sequence: 0 },
    { sequence: 1.5 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { incarnation: "a".repeat(257) },
    { registrationRef: "source:雪" },
    { kind: "undo" },
    { evidenceRef: undefined },
    { acknowledged: true },
  ])
    invalid(() => parseFinancialSourceApplyRequest({ ...APPLY, event: { ...EVENT, ...patch } }));
});

test("only own closed data is read without invoking caller accessors", () => {
  let invoked = 0;
  const accessor = {
    ...APPLY,
    get eventDigest() {
      invoked++;
      return EVENT_DIGEST;
    },
  };
  invalid(() => parseFinancialSourceApplyRequest(accessor));
  invalid(() => parseFinancialSourceApplyRequest(Object.create(APPLY)));
  invalid(() => parseFinancialSourceApplyRequest({ ...APPLY, [Symbol("extra")]: true }));
  const hiddenExtra = Object.defineProperty({ ...READ }, "hidden", { value: true });
  invalid(() => parseFinancialSourceReadRequest(hiddenExtra));
  invalid(() => parseFinancialSourceReadRequest(new Date()));
  expect(invoked).toBe(0);
});

test("request verification captures the original envelope and event before awaiting", async () => {
  const caller = { ...APPLY, event: { ...EVENT } };
  const pending = verifyFinancialSourceApplyRequest(caller);
  caller.event.evidenceRef = "evidence:changed";
  caller.eventDigest = `sha256:${"0".repeat(64)}`;
  const verified = await pending;
  expect(verified).toEqual(APPLY);
  expect(verified.event).not.toBe(caller.event);
  const read = { ...READ };
  const parsed = parseFinancialSourceReadRequest(read);
  read.registrationRef = "source:changed";
  expect(parsed).toEqual(READ);
});

test("official eight-field receipt and record recipes match the independent vectors", async () => {
  expect(await financialSourceReceiptRef(REF)).toBe(RECEIPT_REF);
  expect(
    await financialSourceReceiptRef(
      Object.fromEntries(
        Object.entries(REF).reverse(),
      ) as unknown as FinancialSourceReceiptRefInput,
    ),
  ).toBe(RECEIPT_REF);
  expect(await makeFinancialSourceReceipt(MAKE)).toEqual(RECEIPT);
  expect(await financialSourceReceiptRecordDigest(RECORD)).toBe(RECORD_DIGEST);
  expect(RECORD_DIGEST).not.toBe(EVENT_DIGEST);
});

test("every receipt identity field is bound including the actual receiver and target", async () => {
  const variations: readonly Partial<FinancialSourceReceiptRefInput>[] = [
    { registrationRef: "source:other" },
    { receiverRef: "receiver:other" },
    { targetRef: "target:staging" },
    { eventRef: "event:other" },
    { eventDigest: `sha256:${"2".repeat(64)}` },
    { incarnation: "incarnation:other" },
    { sequence: 2 },
    { state: "advanced" },
  ];
  const refs = await Promise.all(
    variations.map((patch) => financialSourceReceiptRef({ ...REF, ...patch })),
  );
  expect(new Set(refs).size).toBe(variations.length);
  for (const value of refs) expect(value).not.toBe(RECEIPT_REF);
});

test("advance receipts retain their original event identity and use advanced state", async () => {
  const event: FinancialSourceEvent = { ...EVENT, eventRef: "event:advance", kind: "advance" };
  const eventDigest = await financialSourceEventDigest(event);
  const receipt = await makeFinancialSourceReceipt({ ...MAKE, event, eventDigest });
  expect(receipt).toMatchObject({
    v: 1,
    eventRef: event.eventRef,
    eventDigest,
    incarnation: event.incarnation,
    sequence: event.sequence,
    state: "advanced",
  });
  expect(receipt.receiptRef).not.toBe(RECEIPT_REF);
  expect(await financialSourceReceiptRecordDigest({ ...RECORD, receipt })).not.toBe(RECORD_DIGEST);
});

test("receipt helpers reject legacy tuples unsafe identities and inconsistent registration", async () => {
  const { receiverRef: _receiver, targetRef: _target, ...legacy } = REF;
  for (const input of [
    legacy,
    { ...REF, affectedRef: EVENT.affectedRef },
    { ...REF, sequence: 0 },
    { ...REF, state: "accepted" },
    { ...REF, eventDigest: "digest:opaque" },
    { ...REF, targetRef: "a".repeat(257) },
    { ...REF, receiverRef: null },
  ])
    await invalidAsync(() => financialSourceReceiptRef(input as FinancialSourceReceiptRefInput));
  await invalidAsync(() =>
    makeFinancialSourceReceipt({ ...MAKE, registrationRef: "source:other" }),
  );
  await invalidAsync(() =>
    makeFinancialSourceReceipt({ ...MAKE, event: { ...EVENT, kind: "advance" } }),
  );
  await invalidAsync(() =>
    makeFinancialSourceReceipt({ ...MAKE, eventDigest: `sha256:${"0".repeat(64)}` }),
  );
});

test("record digests reject a receipt relabelled into a different context", async () => {
  for (const patch of [
    { registrationRef: "source:other" },
    { receiverRef: "receiver:other" },
    { targetRef: "target:staging" },
    { receipt: { ...RECEIPT, eventRef: "event:other" } },
    { receipt: { ...RECEIPT, receiptRef: "receipt:old-local" } },
    { receipt: { ...RECEIPT, sequence: 2 } },
    { receipt: { ...RECEIPT, state: "advanced" as const } },
    { receipt: { ...RECEIPT, acknowledged: true } },
    { authority: true },
  ])
    await invalidAsync(() => financialSourceReceiptRecordDigest({ ...RECORD, ...patch }));
});

test("receipt construction and record hashing capture all caller data before awaiting", async () => {
  const ref = { ...REF };
  const refPromise = financialSourceReceiptRef(ref);
  ref.receiverRef = "receiver:changed";
  const input = { ...MAKE, event: { ...EVENT } };
  const receiptPromise = makeFinancialSourceReceipt(input);
  input.registrationRef = "source:changed";
  input.receiverRef = "receiver:changed";
  input.targetRef = "target:changed";
  input.event.evidenceRef = "evidence:changed";
  const record = { ...RECORD, receipt: { ...RECEIPT } };
  const recordPromise = financialSourceReceiptRecordDigest(record);
  record.targetRef = "target:changed";
  record.receipt.receiptRef = "receipt:changed";
  record.receipt.eventRef = "event:changed";
  expect(await refPromise).toBe(RECEIPT_REF);
  expect(await receiptPromise).toEqual(RECEIPT);
  expect(await recordPromise).toBe(RECORD_DIGEST);
});

test("the closed ABI errors preserve a cause for the actual owning wrapper", () => {
  const cause = new Error("local failure");
  const codes: readonly FinancialSourceAbiErrorCode[] = [
    "invalid-request",
    "unregistered-source",
    "conflict",
    "unavailable",
  ];
  for (const code of codes) {
    const error = new FinancialSourceAbiError(code, { cause });
    expect(error.message).toBe(code);
    expect(error.code).toBe(code);
    expect(error.cause).toBe(cause);
  }
});
