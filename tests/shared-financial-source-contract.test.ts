import { expect, test } from "bun:test";
import {
  canonicalFinancialSourceJson,
  FINANCIAL_SOURCE_MAX_PAGE,
  FINANCIAL_SOURCE_MAX_RECEIVERS,
  FINANCIAL_SOURCE_MAX_WIRE_BYTES,
  type FinancialSourceEvent,
  type FinancialSourceRegistration,
  financialReceiptMatches,
  financialSourceDigest,
  financialSourceEventDigest,
  financialSourceRef,
  hashFinancialSourceValue,
  materializeFinancialSourceEvent,
  parseFinancialIdentityChallenge,
  parseFinancialSourceEvent,
  parseFinancialSourceMaterialization,
  parseFinancialSourceRawEvent,
  parseFinancialSourceReceipt,
  parseFinancialSourceReceiptRecord,
  parseFinancialSourceRegistration,
} from "../src/shared-financial-source-contract.ts";

const GENESIS = `sha256:${"1".repeat(64)}` as const;
const EVENT: FinancialSourceEvent = {
  v: 1,
  eventRef: "event:one",
  registrationRef: "source:accounts",
  incarnation: "incarnation:one",
  sequence: 1,
  previousDigest: GENESIS,
  kind: "close",
  affectedRef: "grant:one",
  evidenceRef: "evidence:one",
};

test("version1 event matches the frozen Accounts digest independently of key insertion order", async () => {
  expect(await financialSourceEventDigest(EVENT)).toBe(
    "sha256:85dfc950d869c729357ad56b76bc83275053ea0b037f117649932a36d5924b93",
  );
  expect(
    await financialSourceEventDigest(
      parseFinancialSourceEvent(Object.fromEntries(Object.entries(EVENT).reverse())),
    ),
  ).toBe("sha256:85dfc950d869c729357ad56b76bc83275053ea0b037f117649932a36d5924b93");
});

test("an event rejects unsafe sequence, unknown facts and incompatible versions", () => {
  for (const patch of [
    { sequence: 0 },
    { sequence: 1.5 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { v: 2 },
    { ready: true },
  ])
    expect(() => parseFinancialSourceEvent({ ...EVENT, ...patch })).toThrow(
      "invalid_financial_source_record",
    );
});

const REGISTRATION: FinancialSourceRegistration = {
  registrationRef: EVENT.registrationRef,
  incarnation: EVENT.incarnation,
  genesisDigest: GENESIS,
  receivers: [{ receiverRef: "receiver:financial", targetRef: "target:qualified" }],
};
const RAW = {
  v: 1 as const,
  eventRef: EVENT.eventRef,
  registrationRef: EVENT.registrationRef,
  incarnation: EVENT.incarnation,
  sequence: 1,
  previousEventRef: null,
  kind: "advance" as const,
  affectedRef: EVENT.affectedRef,
  evidenceRef: EVENT.evidenceRef,
};
const RECEIPT = {
  v: 1 as const,
  eventRef: EVENT.eventRef,
  eventDigest: "sha256:85dfc950d869c729357ad56b76bc83275053ea0b037f117649932a36d5924b93" as const,
  receiptRef: "receipt:one",
  incarnation: EVENT.incarnation,
  sequence: 1,
  state: "admission-closed" as const,
};
const CHALLENGE = {
  v: 1 as const,
  challengeRef: "challenge:one",
  registrationRef: EVENT.registrationRef,
  clientId: "client:owned",
  workspaceId: "workspace:one",
  organizationId: "org:retained",
  workspaceRef: "workspace-ref:retained",
  requestFingerprint: GENESIS,
  createdAt: 1_000,
  expiresAt: 61_000,
};

test("the raw metadata digest uses the value envelope rather than the event envelope", async () => {
  // Independent Python sorted JSON/SHA256 vector over this literal raw wire.
  expect(await hashFinancialSourceValue("takosumi.financial-source-raw@v1", RAW)).toBe(
    "sha256:881767e94dd5a0facbc689538be6ef1b30fd84f66b68ca0350f22a73587fb5c5",
  );
  const caller = { ...RAW };
  const pending = hashFinancialSourceValue("takosumi.financial-source-raw@v1", caller);
  caller.evidenceRef = "evidence:changed";
  expect(await pending).toBe(
    "sha256:881767e94dd5a0facbc689538be6ef1b30fd84f66b68ca0350f22a73587fb5c5",
  );
});

test("ASCII references accept256 bytes and reject aliases and malformed digests", () => {
  expect(financialSourceRef("a".repeat(256))).toBe(true);
  expect(financialSourceRef("a._:/-0")).toBe(true);
  for (const value of ["", "a".repeat(257), "/a", ":a", "a b", "a\n", "a\0", "a雪", null, 1])
    expect(financialSourceRef(value)).toBe(false);
  expect(financialSourceDigest(GENESIS)).toBe(true);
  for (const value of [
    `sha256:${"A".repeat(64)}`,
    `sha256:${"a".repeat(63)}`,
    `sha256:${"a".repeat(65)}`,
    `SHA256:${"a".repeat(64)}`,
    "opaque:evidence",
    null,
  ])
    expect(financialSourceDigest(value)).toBe(false);
  expect(parseFinancialSourceEvent({ ...EVENT, sequence: Number.MAX_SAFE_INTEGER }).sequence).toBe(
    Number.MAX_SAFE_INTEGER,
  );
});

test("registration keeps the complete bounded receiver set and returns detached records", () => {
  const receivers = Array.from({ length: 8 }, (_, i) => ({
    receiverRef: `receiver:${i}`,
    targetRef: "target:same-qualified",
  }));
  const parsed = parseFinancialSourceRegistration({ ...REGISTRATION, receivers });
  expect(parsed.receivers).toEqual(receivers);
  expect(parsed.receivers).not.toBe(receivers);
  const first = receivers[0];
  if (!first) throw new Error("receiver fixture missing");
  first.targetRef = "target:changed";
  expect(parsed.receivers[0]?.targetRef).toBe("target:same-qualified");
  for (const receivers of [
    [],
    new Array(1),
    new Array(9),
    [...REGISTRATION.receivers, ...REGISTRATION.receivers],
  ])
    expect(() => parseFinancialSourceRegistration({ ...REGISTRATION, receivers })).toThrow(
      "invalid_financial_source_record",
    );
  expect(FINANCIAL_SOURCE_MAX_RECEIVERS).toBe(8);
  expect(FINANCIAL_SOURCE_MAX_PAGE).toBe(100);
});

test("sparse inherited accessor and extra array properties cannot disguise receiver completeness", () => {
  const inherited = new Array(1);
  Object.setPrototypeOf(
    inherited,
    Object.assign(Object.create(Array.prototype), { 0: REGISTRATION.receivers[0] }),
  );
  const accessor = [REGISTRATION.receivers[0]];
  let reads = 0;
  Object.defineProperty(accessor, "0", {
    get() {
      reads++;
      return REGISTRATION.receivers[0];
    },
  });
  const symbol = [...REGISTRATION.receivers];
  Object.defineProperty(symbol, Symbol("extra"), { value: true });
  for (const receivers of [
    inherited,
    accessor,
    symbol,
    Object.assign([...REGISTRATION.receivers], { extra: true }),
  ])
    expect(() => parseFinancialSourceRegistration({ ...REGISTRATION, receivers })).toThrow(
      "invalid_financial_source_record",
    );
  expect(reads).toBe(0);
});

test("closed wire parsers reject unknown keys, missing fields and null non-nullable values", () => {
  for (const [parse, sample] of [
    [parseFinancialSourceRegistration, REGISTRATION],
    [parseFinancialSourceEvent, EVENT],
    [parseFinancialSourceRawEvent, RAW],
    [parseFinancialSourceReceipt, RECEIPT],
    [parseFinancialIdentityChallenge, CHALLENGE],
  ] as const) {
    expect(() => parse({ ...sample, authority: true })).toThrow("invalid_financial_source_record");
    expect(() => parse(null)).toThrow("invalid_financial_source_record");
    for (const key of Object.keys(sample)) {
      const missing: Record<string, unknown> = { ...sample };
      delete missing[key];
      expect(() => parse(missing)).toThrow("invalid_financial_source_record");
      if (key !== "previousEventRef")
        expect(() => parse({ ...sample, [key]: null })).toThrow("invalid_financial_source_record");
    }
  }
});

test("object accessors, symbol keys and foreign prototypes are rejected without evaluation", () => {
  let reads = 0;
  const accessor = { ...EVENT };
  Object.defineProperty(accessor, "eventRef", {
    enumerable: true,
    get() {
      reads++;
      return EVENT.eventRef;
    },
  });
  const symbol = { ...EVENT };
  Object.defineProperty(symbol, Symbol("authority"), { value: true });
  const hidden = { ...EVENT };
  Object.defineProperty(hidden, "authority", { value: true });
  for (const value of [
    accessor,
    symbol,
    hidden,
    Object.assign(Object.create({ inherited: true }), EVENT),
  ])
    expect(() => parseFinancialSourceEvent(value)).toThrow("invalid_financial_source_record");
  expect(reads).toBe(0);
  expect(parseFinancialSourceEvent(Object.assign(Object.create(null), EVENT))).toEqual(EVENT);
});

test("raw first-event nullability and retained predecessor are exact and closure is terminal", async () => {
  const first = await materializeFinancialSourceEvent({ registration: REGISTRATION, raw: RAW });
  expect(first.event.previousDigest).toBe(GENESIS);
  expect(first.rawEventDigest).toBe(
    "sha256:881767e94dd5a0facbc689538be6ef1b30fd84f66b68ca0350f22a73587fb5c5",
  );
  const secondRaw = {
    ...RAW,
    eventRef: "event:two",
    sequence: 2,
    previousEventRef: RAW.eventRef,
    kind: "close" as const,
  };
  const second = await materializeFinancialSourceEvent({
    registration: REGISTRATION,
    raw: secondRaw,
    predecessor: first,
  });
  expect(second.event.previousDigest).toBe(first.eventDigest);
  for (const patch of [
    { sequence: 0 },
    { sequence: 2 },
    { previousEventRef: "event:prior" },
    { previousDigest: GENESIS },
  ])
    expect(() => parseFinancialSourceRawEvent({ ...RAW, ...patch })).toThrow(
      "invalid_financial_source_record",
    );
  await expect(
    materializeFinancialSourceEvent({ registration: REGISTRATION, raw: secondRaw }),
  ).rejects.toThrow("invalid_financial_source_record");
  for (const predecessor of [
    { ...first, eventDigest: GENESIS },
    { ...first, event: { ...first.event, kind: "close" as const } },
    { ...first, event: { ...first.event, affectedRef: "grant:other" } },
    { ...first, event: { ...first.event, registrationRef: "source:other" } },
    { ...first, event: { ...first.event, incarnation: "incarnation:other" } },
  ])
    await expect(
      materializeFinancialSourceEvent({ registration: REGISTRATION, raw: secondRaw, predecessor }),
    ).rejects.toThrow("invalid_financial_source_record");
  await expect(
    materializeFinancialSourceEvent({ registration: REGISTRATION, raw: RAW, predecessor: first }),
  ).rejects.toThrow("invalid_financial_source_record");
  await expect(
    materializeFinancialSourceEvent({
      registration: { ...REGISTRATION, incarnation: "incarnation:other" },
      raw: RAW,
    }),
  ).rejects.toThrow("invalid_financial_source_record");
  await expect(
    materializeFinancialSourceEvent({
      registration: REGISTRATION,
      raw: {
        ...secondRaw,
        eventRef: "event:three",
        previousEventRef: second.event.eventRef,
        sequence: 3,
      },
      predecessor: second,
    }),
  ).rejects.toThrow("invalid_financial_source_record");
});

test("a receipt binds exact event digest, incarnation, sequence and operation outcome", async () => {
  const eventDigest = await financialSourceEventDigest(EVENT);
  expect(financialReceiptMatches(EVENT, eventDigest, parseFinancialSourceReceipt(RECEIPT))).toBe(
    true,
  );
  for (const patch of [
    { eventRef: "event:other" },
    { eventDigest: GENESIS },
    { incarnation: "incarnation:other" },
    { sequence: 2 },
    { state: "advanced" as const },
  ])
    expect(
      financialReceiptMatches(
        EVENT,
        eventDigest,
        parseFinancialSourceReceipt({ ...RECEIPT, ...patch }),
      ),
    ).toBe(false);
  const advance = parseFinancialSourceEvent({ ...EVENT, kind: "advance" });
  const advanceDigest = await financialSourceEventDigest(advance);
  expect(
    financialReceiptMatches(
      advance,
      advanceDigest,
      parseFinancialSourceReceipt({ ...RECEIPT, eventDigest: advanceDigest, state: "advanced" }),
    ),
  ).toBe(true);
  expect(() => parseFinancialSourceReceipt({ ...RECEIPT, state: "provider-drained" })).toThrow();
});

test("local receipt custody and materialization have closed nested metadata", async () => {
  const record = {
    registrationRef: EVENT.registrationRef,
    receiverRef: "receiver:financial",
    targetRef: "target:qualified",
    receipt: RECEIPT,
  };
  expect(parseFinancialSourceReceiptRecord(record)).toEqual(record);
  expect(() =>
    parseFinancialSourceReceiptRecord({ ...record, receipt: { ...RECEIPT, qualified: true } }),
  ).toThrow();
  expect(() => parseFinancialSourceReceiptRecord({ ...record, targetRef: null })).toThrow();
  expect(() => parseFinancialSourceReceiptRecord({ ...record, ready: true })).toThrow();
  const materialization = await materializeFinancialSourceEvent({
    registration: REGISTRATION,
    raw: RAW,
  });
  expect(parseFinancialSourceMaterialization(materialization)).toEqual(materialization);
  expect(() =>
    parseFinancialSourceMaterialization({ ...materialization, rawEventDigest: null }),
  ).toThrow();
  expect(() =>
    parseFinancialSourceMaterialization({
      ...materialization,
      event: { ...materialization.event, authority: true },
    }),
  ).toThrow();
  expect(() => parseFinancialSourceMaterialization({ ...materialization, ready: true })).toThrow();
});

test("identity challenge has a five-minute safe-integer lifetime and no payer assertions", () => {
  expect(parseFinancialIdentityChallenge(CHALLENGE)).toEqual(CHALLENGE);
  expect(
    parseFinancialIdentityChallenge({ ...CHALLENGE, createdAt: 0, expiresAt: 300_000 }).expiresAt,
  ).toBe(300_000);
  expect(
    parseFinancialIdentityChallenge({
      ...CHALLENGE,
      createdAt: Number.MAX_SAFE_INTEGER - 300_000,
      expiresAt: Number.MAX_SAFE_INTEGER,
    }).expiresAt,
  ).toBe(Number.MAX_SAFE_INTEGER);
  for (const patch of [
    { createdAt: -1 },
    { createdAt: 1.5 },
    { expiresAt: 1_000 },
    { expiresAt: 301_001 },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { payer: true },
    { principalId: "claimed" },
    { requestFingerprint: "base64url-evidence" },
  ])
    expect(() => parseFinancialIdentityChallenge({ ...CHALLENGE, ...patch })).toThrow(
      "invalid_financial_source_record",
    );
});

test("canonical supported JSON preserves Unicode bytes without normalization or ignored slots", () => {
  expect(canonicalFinancialSourceJson({ z: "雪", a: [true, null, 1] })).toBe(
    '{"a":[true,null,1],"z":"雪"}',
  );
  expect(canonicalFinancialSourceJson({ b: -1, a: -0 })).toBe('{"a":0,"b":-1}');
  expect(canonicalFinancialSourceJson("é")).not.toBe(canonicalFinancialSourceJson("e\u0301"));
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1.5,
    1n,
    new Date(),
    "\ud800",
    { secret: undefined },
    { "\ud800": true },
    new Array(1),
    Object.assign([1], { extra: true }),
  ])
    expect(() => canonicalFinancialSourceJson(value)).toThrow("invalid_financial_source_record");
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(() => canonicalFinancialSourceJson(cycle)).toThrow();
  const shared = { v: 1 };
  expect(canonicalFinancialSourceJson([shared, shared])).toBe('[{"v":1},{"v":1}]');
});

test("owner canonical100-element,100-field and16-depth bounds remain distinct from page custody", () => {
  expect(canonicalFinancialSourceJson(Array(100).fill(null))).toBe(
    `[${Array(100).fill("null").join(",")}]`,
  );
  expect(() => canonicalFinancialSourceJson(Array(101).fill(null))).toThrow();
  expect(() =>
    canonicalFinancialSourceJson(
      Object.fromEntries(Array.from({ length: 101 }, (_, i) => [String(i), 0])),
    ),
  ).toThrow();
  let nested: unknown = 0;
  for (let depth = 0; depth < 16; depth++) nested = [nested];
  expect(() => canonicalFinancialSourceJson(nested)).not.toThrow();
  expect(() => canonicalFinancialSourceJson([nested])).toThrow();
});

test("16KiB digest envelope limits count UTF8 bytes including the domain", async () => {
  expect(FINANCIAL_SOURCE_MAX_WIRE_BYTES).toBe(16_384);
  // The independently counted ASCII wrapper {"domain":"test","value":""} is28 bytes.
  expect(financialSourceDigest(await hashFinancialSourceValue("test", "x".repeat(16_356)))).toBe(
    true,
  );
  await expect(hashFinancialSourceValue("test", "x".repeat(16_357))).rejects.toThrow(
    "invalid_financial_source_record",
  );
  await expect(hashFinancialSourceValue("test", "雪".repeat(8_000))).rejects.toThrow(
    "invalid_financial_source_record",
  );
});
