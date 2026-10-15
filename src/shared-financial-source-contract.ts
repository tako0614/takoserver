import { canonicalDigest, canonicalJson } from "./json.ts";

/**
 * Independent Server consumer of the Accounts financial-source wire v1.
 * Parsing or hashing describes data; it never qualifies a source, receiver,
 * payer, session, primary database or admission authority.
 */
export type FinancialSourceDigest = `sha256:${string}`;

export interface FinancialSourceReceiverRegistration {
  readonly receiverRef: string;
  readonly targetRef: string;
}
export interface FinancialSourceRegistration {
  readonly registrationRef: string;
  readonly incarnation: string;
  readonly genesisDigest: FinancialSourceDigest;
  readonly receivers: readonly FinancialSourceReceiverRegistration[];
}
export interface FinancialSourceEvent {
  readonly v: 1;
  readonly eventRef: string;
  readonly registrationRef: string;
  readonly incarnation: string;
  readonly sequence: number;
  readonly previousDigest: FinancialSourceDigest;
  readonly kind: "advance" | "close";
  readonly affectedRef: string;
  readonly evidenceRef: string;
}
export interface FinancialSourceRawEvent extends Omit<FinancialSourceEvent, "previousDigest"> {
  readonly previousEventRef: string | null;
}
export interface FinancialSourceMaterialization {
  readonly rawEventDigest: FinancialSourceDigest;
  readonly event: FinancialSourceEvent;
  readonly eventDigest: FinancialSourceDigest;
}
export interface FinancialSourceReceipt {
  readonly v: 1;
  readonly eventRef: string;
  readonly eventDigest: FinancialSourceDigest;
  readonly receiptRef: string;
  readonly incarnation: string;
  readonly sequence: number;
  readonly state: "admission-closed" | "advanced";
}
export interface FinancialSourceReceiptRecord {
  readonly registrationRef: string;
  readonly receiverRef: string;
  readonly targetRef: string;
  readonly receipt: FinancialSourceReceipt;
}
export interface FinancialIdentityChallenge {
  readonly v: 1;
  readonly challengeRef: string;
  readonly registrationRef: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly organizationId: string;
  readonly workspaceRef: string;
  readonly requestFingerprint: FinancialSourceDigest;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export const FINANCIAL_SOURCE_MAX_PAGE = 100;
export const FINANCIAL_SOURCE_MAX_RECEIVERS = 8;
export const FINANCIAL_SOURCE_MAX_WIRE_BYTES = 16_384;

export function financialSourceRef(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value);
}
export function financialSourceDigest(value: unknown): value is FinancialSourceDigest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}
function invalid(): never {
  throw new TypeError("invalid_financial_source_record");
}
function ref(value: unknown): string {
  return financialSourceRef(value) ? value : invalid();
}
function digest(value: unknown): FinancialSourceDigest {
  return financialSourceDigest(value) ? value : invalid();
}
function integer(value: unknown, minimum: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
    ? value
    : invalid();
}
function version(value: unknown): 1 {
  return value === 1 ? 1 : invalid();
}
function eventKind(value: unknown): FinancialSourceEvent["kind"] {
  return value === "advance" || value === "close" ? value : invalid();
}
function plain(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid();
  return descriptor.value;
}
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!plain(value)) return invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== names.length ||
    keys.some((key) => typeof key !== "string" || !names.includes(key))
  )
    return invalid();
  return Object.fromEntries(names.map((name) => [name, ownData(value, name)]));
}
function items(value: unknown, maximum: number): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return invalid();
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) result.push(ownData(value, String(i)));
  return result;
}

export function parseFinancialSourceRegistration(value: unknown): FinancialSourceRegistration {
  const r = fields(value, ["registrationRef", "incarnation", "genesisDigest", "receivers"]);
  const receivers = items(r.receivers, FINANCIAL_SOURCE_MAX_RECEIVERS).map((value) => {
    const receiver = fields(value, ["receiverRef", "targetRef"]);
    return { receiverRef: ref(receiver.receiverRef), targetRef: ref(receiver.targetRef) };
  });
  if (
    receivers.length === 0 ||
    new Set(receivers.map((receiver) => receiver.receiverRef)).size !== receivers.length
  )
    return invalid();
  return {
    registrationRef: ref(r.registrationRef),
    incarnation: ref(r.incarnation),
    genesisDigest: digest(r.genesisDigest),
    receivers,
  };
}

const EVENT_FIELDS = [
  "v",
  "eventRef",
  "registrationRef",
  "incarnation",
  "sequence",
  "previousDigest",
  "kind",
  "affectedRef",
  "evidenceRef",
] as const;
export function parseFinancialSourceEvent(value: unknown): FinancialSourceEvent {
  const e = fields(value, EVENT_FIELDS);
  return {
    v: version(e.v),
    eventRef: ref(e.eventRef),
    registrationRef: ref(e.registrationRef),
    incarnation: ref(e.incarnation),
    sequence: integer(e.sequence, 1),
    previousDigest: digest(e.previousDigest),
    kind: eventKind(e.kind),
    affectedRef: ref(e.affectedRef),
    evidenceRef: ref(e.evidenceRef),
  };
}

export function parseFinancialSourceRawEvent(value: unknown): FinancialSourceRawEvent {
  const r = fields(value, [
    "v",
    "eventRef",
    "registrationRef",
    "incarnation",
    "sequence",
    "previousEventRef",
    "kind",
    "affectedRef",
    "evidenceRef",
  ]);
  const sequence = integer(r.sequence, 1);
  const previousEventRef = r.previousEventRef === null ? null : ref(r.previousEventRef);
  if ((sequence === 1) !== (previousEventRef === null)) return invalid();
  return {
    v: version(r.v),
    eventRef: ref(r.eventRef),
    registrationRef: ref(r.registrationRef),
    incarnation: ref(r.incarnation),
    sequence,
    previousEventRef,
    kind: eventKind(r.kind),
    affectedRef: ref(r.affectedRef),
    evidenceRef: ref(r.evidenceRef),
  };
}

export function parseFinancialSourceReceipt(value: unknown): FinancialSourceReceipt {
  const r = fields(value, [
    "v",
    "eventRef",
    "eventDigest",
    "receiptRef",
    "incarnation",
    "sequence",
    "state",
  ]);
  if (r.state !== "admission-closed" && r.state !== "advanced") return invalid();
  return {
    v: version(r.v),
    eventRef: ref(r.eventRef),
    eventDigest: digest(r.eventDigest),
    receiptRef: ref(r.receiptRef),
    incarnation: ref(r.incarnation),
    sequence: integer(r.sequence, 1),
    state: r.state,
  };
}

export function parseFinancialSourceReceiptRecord(value: unknown): FinancialSourceReceiptRecord {
  const r = fields(value, ["registrationRef", "receiverRef", "targetRef", "receipt"]);
  return {
    registrationRef: ref(r.registrationRef),
    receiverRef: ref(r.receiverRef),
    targetRef: ref(r.targetRef),
    receipt: parseFinancialSourceReceipt(r.receipt),
  };
}

/** Structural receipt binding, not proof of a qualified receiver's durable commit. */
export function financialReceiptMatches(
  event: FinancialSourceEvent,
  eventDigest: FinancialSourceDigest,
  receipt: FinancialSourceReceipt,
): boolean {
  return (
    receipt.eventRef === event.eventRef &&
    receipt.eventDigest === eventDigest &&
    receipt.incarnation === event.incarnation &&
    receipt.sequence === event.sequence &&
    receipt.state === (event.kind === "close" ? "admission-closed" : "advanced")
  );
}

export function parseFinancialIdentityChallenge(value: unknown): FinancialIdentityChallenge {
  const c = fields(value, [
    "v",
    "challengeRef",
    "registrationRef",
    "clientId",
    "workspaceId",
    "organizationId",
    "workspaceRef",
    "requestFingerprint",
    "createdAt",
    "expiresAt",
  ]);
  const createdAt = integer(c.createdAt, 0);
  const expiresAt = integer(c.expiresAt, 0);
  if (expiresAt <= createdAt || expiresAt - createdAt > 300_000) return invalid();
  return {
    v: version(c.v),
    challengeRef: ref(c.challengeRef),
    registrationRef: ref(c.registrationRef),
    clientId: ref(c.clientId),
    workspaceId: ref(c.workspaceId),
    organizationId: ref(c.organizationId),
    workspaceRef: ref(c.workspaceRef),
    requestFingerprint: digest(c.requestFingerprint),
    createdAt,
    expiresAt,
  };
}

/** Closed metadata only; raw payload custody and digest verification are separate. */
export function parseFinancialSourceMaterialization(
  value: unknown,
): FinancialSourceMaterialization {
  const m = fields(value, ["rawEventDigest", "event", "eventDigest"]);
  return {
    rawEventDigest: digest(m.rawEventDigest),
    event: parseFinancialSourceEvent(m.event),
    eventDigest: digest(m.eventDigest),
  };
}

type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };
function text(value: string): string {
  if (
    value.length > FINANCIAL_SOURCE_MAX_WIRE_BYTES ||
    new TextDecoder().decode(new TextEncoder().encode(value)) !== value
  )
    return invalid();
  return value;
}
/** Copy supported JSON before hashing so caller mutations cannot change captured bytes. */
function jsonValue(value: unknown, depth = 0, ancestors = new Set<object>()): CanonicalValue {
  if (depth > 16) return invalid();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return text(value);
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : invalid();
  if (typeof value !== "object" || value === null || ancestors.has(value)) return invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return items(value, 100).map((item) => jsonValue(item, depth + 1, ancestors));
    if (!plain(value)) return invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length > 100) return invalid();
    const result: { [key: string]: CanonicalValue } = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string") return invalid();
      jsonValue(key, depth + 1, ancestors);
      result[key] = jsonValue(ownData(value, key), depth + 1, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/** Same sorted JSON and supported-value boundaries as the frozen wire owner. */
export function canonicalFinancialSourceJson(value: unknown): string {
  return canonicalJson(jsonValue(value));
}
async function hash(value: unknown): Promise<FinancialSourceDigest> {
  const captured = jsonValue(value);
  if (
    new TextEncoder().encode(canonicalJson(captured)).byteLength > FINANCIAL_SOURCE_MAX_WIRE_BYTES
  )
    return invalid();
  return canonicalDigest(captured);
}
export function hashFinancialSourceValue(
  domain: string,
  value: unknown,
): Promise<FinancialSourceDigest> {
  return hash({ domain, value });
}
export function financialSourceEventDigest(
  event: FinancialSourceEvent,
): Promise<FinancialSourceDigest> {
  return hash({
    domain: "takosumi.financial-source-event@v1",
    event: parseFinancialSourceEvent(event),
  });
}

/** Reconstruct metadata only; the owning store must CAS the full original raw payload. */
export async function materializeFinancialSourceEvent(input: {
  readonly registration: FinancialSourceRegistration;
  readonly raw: FinancialSourceRawEvent;
  readonly predecessor?: FinancialSourceMaterialization;
}): Promise<FinancialSourceMaterialization> {
  const registration = parseFinancialSourceRegistration(input.registration);
  const raw = parseFinancialSourceRawEvent(input.raw);
  if (
    raw.registrationRef !== registration.registrationRef ||
    raw.incarnation !== registration.incarnation
  )
    return invalid();
  let previousDigest = registration.genesisDigest;
  if (raw.sequence === 1) {
    if (input.predecessor !== undefined) return invalid();
  } else {
    if (input.predecessor === undefined) return invalid();
    const prior = parseFinancialSourceMaterialization(input.predecessor);
    if (
      prior.event.eventRef !== raw.previousEventRef ||
      prior.event.sequence !== raw.sequence - 1 ||
      prior.event.registrationRef !== raw.registrationRef ||
      prior.event.incarnation !== raw.incarnation ||
      prior.event.affectedRef !== raw.affectedRef ||
      prior.event.kind === "close" ||
      (await financialSourceEventDigest(prior.event)) !== prior.eventDigest
    )
      return invalid();
    previousDigest = prior.eventDigest;
  }
  const event = parseFinancialSourceEvent({
    v: raw.v,
    eventRef: raw.eventRef,
    registrationRef: raw.registrationRef,
    incarnation: raw.incarnation,
    sequence: raw.sequence,
    previousDigest,
    kind: raw.kind,
    affectedRef: raw.affectedRef,
    evidenceRef: raw.evidenceRef,
  });
  return {
    rawEventDigest: await hashFinancialSourceValue("takosumi.financial-source-raw@v1", raw),
    event,
    eventDigest: await financialSourceEventDigest(event),
  };
}
