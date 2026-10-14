/** Exact USD cash and ledger unit adapters. One cent is 10,000 USD micros. */
export const MICROS_PER_MINOR = 10_000n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export class MoneyError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export function safeMicros(value: bigint): number {
  if (value < -MAX_SAFE || value > MAX_SAFE)
    throw new MoneyError("USD micros exceed safe integer range");
  return Number(value);
}

/** Convert an authored or verified integer-cent cash amount without rounding. */
export function minorToMicros(minor: number): number {
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new MoneyError("USD cents must be a nonnegative safe integer");
  }
  return safeMicros(BigInt(minor) * MICROS_PER_MINOR);
}

/** Parse a canonical unsigned decimal public money value exactly. */
export function parseUnsignedMicros(value: string): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new MoneyError("USD micros must be a canonical unsigned decimal integer string");
  }
  return safeMicros(BigInt(value));
}

/** Convert a complete payable invoice total once; any positive remainder rounds up. */
export function invoiceCents(payableMicros: string): number {
  const micros = BigInt(parseUnsignedMicros(payableMicros));
  const cents = (micros + MICROS_PER_MINOR - 1n) / MICROS_PER_MINOR;
  return Number(cents);
}
