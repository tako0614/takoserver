import {
  type FinancialSourceDigest,
  type FinancialSourceEvent,
  type FinancialSourceReceipt,
  type FinancialSourceReceiptRecord,
  financialSourceDigest,
  financialSourceEventDigest,
  financialSourceRef,
  hashFinancialSourceValue,
  parseFinancialSourceEvent,
  parseFinancialSourceReceipt,
} from "./shared-financial-source-contract.ts";

/** Independent consumer of the Accounts receiver ABI v1. Parsing and hashes
 * describe data, not a genuine source, enrolled receiver or committed ACK. */
export interface FinancialSourceApplyRequest {
  readonly v: 1;
  readonly event: FinancialSourceEvent;
  readonly eventDigest: FinancialSourceDigest;
}
export interface FinancialSourceReadRequest {
  readonly v: 1;
  readonly registrationRef: string;
  readonly eventRef: string;
  readonly eventDigest: FinancialSourceDigest;
}
export interface FinancialSourceReceiverAbi {
  applySourceEvent(input: FinancialSourceApplyRequest): Promise<FinancialSourceReceipt>;
  /** Only undefined denotes absence. A null, error or different digest is not absence. */
  readSourceEventReceipt(
    input: FinancialSourceReadRequest,
  ): Promise<FinancialSourceReceipt | undefined>;
}
export type FinancialSourceAbiErrorCode =
  | "invalid-request"
  | "unregistered-source"
  | "conflict"
  | "unavailable";
export class FinancialSourceAbiError extends Error {
  constructor(
    readonly code: FinancialSourceAbiErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "FinancialSourceAbiError";
  }
}

function invalid(cause?: unknown): never {
  throw new FinancialSourceAbiError("invalid-request", { cause });
}
function normalize(error: unknown): never {
  if (error instanceof FinancialSourceAbiError) throw error;
  return invalid(error);
}
/** Read own data descriptors without invoking caller accessors. */
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object") return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some((key) => !names.includes(key as string)))
    return invalid();
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !("value" in descriptor)) return invalid();
    result[name] = descriptor.value;
  }
  return result;
}
function ref(value: unknown): string {
  return financialSourceRef(value) ? value : invalid();
}

export function parseFinancialSourceApplyRequest(value: unknown): FinancialSourceApplyRequest {
  try {
    const input = fields(value, ["v", "event", "eventDigest"]);
    if (input.v !== 1 || !financialSourceDigest(input.eventDigest)) return invalid();
    return {
      v: 1,
      event: parseFinancialSourceEvent(input.event),
      eventDigest: input.eventDigest,
    };
  } catch (error) {
    return normalize(error);
  }
}
export async function verifyFinancialSourceApplyRequest(
  value: unknown,
): Promise<FinancialSourceApplyRequest> {
  const input = parseFinancialSourceApplyRequest(value);
  if ((await financialSourceEventDigest(input.event)) !== input.eventDigest) return invalid();
  return input;
}
/** The original event is required to verify this digest; a read envelope alone
 * cannot prove registration, currentness or the existence of a receipt. */
export function parseFinancialSourceReadRequest(value: unknown): FinancialSourceReadRequest {
  try {
    const input = fields(value, ["v", "registrationRef", "eventRef", "eventDigest"]);
    if (input.v !== 1 || !financialSourceDigest(input.eventDigest)) return invalid();
    return {
      v: 1,
      registrationRef: ref(input.registrationRef),
      eventRef: ref(input.eventRef),
      eventDigest: input.eventDigest,
    };
  } catch (error) {
    return normalize(error);
  }
}

export interface FinancialSourceReceiptRefInput {
  readonly registrationRef: string;
  readonly receiverRef: string;
  readonly targetRef: string;
  readonly eventRef: string;
  readonly eventDigest: FinancialSourceDigest;
  readonly incarnation: string;
  readonly sequence: number;
  readonly state: FinancialSourceReceipt["state"];
}
/** Deterministic eight-field identity. Only the owning receiver's committed
 * immutable row/readback may expose this value as an ACK. */
export async function financialSourceReceiptRef(
  input: FinancialSourceReceiptRefInput,
): Promise<string> {
  try {
    const value = fields(input, [
      "registrationRef",
      "receiverRef",
      "targetRef",
      "eventRef",
      "eventDigest",
      "incarnation",
      "sequence",
      "state",
    ]);
    ref(value.registrationRef);
    ref(value.receiverRef);
    ref(value.targetRef);
    parseFinancialSourceReceipt({
      v: 1,
      receiptRef: "pending",
      eventRef: value.eventRef,
      eventDigest: value.eventDigest,
      incarnation: value.incarnation,
      sequence: value.sequence,
      state: value.state,
    });
    // The shared codec snapshots the original closed data before its first await.
    const digest = await hashFinancialSourceValue(
      "takosumi.financial-source-receipt-ref@v1",
      input,
    );
    return `fsr_${digest.slice(7)}`;
  } catch (error) {
    return normalize(error);
  }
}

export interface MakeFinancialSourceReceiptInput {
  readonly registrationRef: string;
  readonly receiverRef: string;
  readonly targetRef: string;
  readonly event: FinancialSourceEvent;
  readonly eventDigest: FinancialSourceDigest;
}
export async function makeFinancialSourceReceipt(
  input: MakeFinancialSourceReceiptInput,
): Promise<FinancialSourceReceipt> {
  try {
    const value = fields(input, [
      "registrationRef",
      "receiverRef",
      "targetRef",
      "event",
      "eventDigest",
    ]);
    const registrationRef = ref(value.registrationRef);
    const receiverRef = ref(value.receiverRef);
    const targetRef = ref(value.targetRef);
    const verified = await verifyFinancialSourceApplyRequest({
      v: 1,
      event: value.event,
      eventDigest: value.eventDigest,
    });
    if (verified.event.registrationRef !== registrationRef) return invalid();
    const receipt = {
      eventRef: verified.event.eventRef,
      eventDigest: verified.eventDigest,
      incarnation: verified.event.incarnation,
      sequence: verified.event.sequence,
      state:
        verified.event.kind === "close" ? ("admission-closed" as const) : ("advanced" as const),
    };
    return {
      v: 1,
      ...receipt,
      receiptRef: await financialSourceReceiptRef({
        registrationRef,
        receiverRef,
        targetRef,
        ...receipt,
      }),
    };
  } catch (error) {
    return normalize(error);
  }
}

/** This record digest is separate from the event digest and is not a signature. */
export async function financialSourceReceiptRecordDigest(
  input: FinancialSourceReceiptRecord,
): Promise<FinancialSourceDigest> {
  try {
    const value = fields(input, ["registrationRef", "receiverRef", "targetRef", "receipt"]);
    const registrationRef = ref(value.registrationRef);
    const receiverRef = ref(value.receiverRef);
    const targetRef = ref(value.targetRef);
    const receipt = parseFinancialSourceReceipt(value.receipt);
    const expected = await financialSourceReceiptRef({
      registrationRef,
      receiverRef,
      targetRef,
      eventRef: receipt.eventRef,
      eventDigest: receipt.eventDigest,
      incarnation: receipt.incarnation,
      sequence: receipt.sequence,
      state: receipt.state,
    });
    if (receipt.receiptRef !== expected) return invalid();
    return await hashFinancialSourceValue("takosumi.financial-source-receipt-record@v1", {
      registrationRef,
      receiverRef,
      targetRef,
      receipt,
    });
  } catch (error) {
    return normalize(error);
  }
}
