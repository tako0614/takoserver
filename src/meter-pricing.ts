import { safeMicros } from "./money.ts";

/** Exact nonnegative priced USD micros, before the settlement's one quantization. */
export interface RationalMicros {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export function rational(numerator: bigint, denominator = 1n): RationalMicros {
  if (numerator < 0n || denominator <= 0n) throw new RangeError("invalid priced rational");
  let a = numerator;
  let b = denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return { numerator: numerator / a, denominator: denominator / a };
}

export function addRational(left: RationalMicros, right: RationalMicros): RationalMicros {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

/** Parse a configuration number's decimal representation, never a floating product. */
export function decimalRational(value: number): RationalMicros {
  if (!Number.isFinite(value) || value < 0) throw new RangeError("invalid decimal quantity");
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/u.exec(String(value));
  if (!match) throw new RangeError("invalid decimal quantity");
  const fractional = match[2] ?? "";
  const exponent = Number(match[3] ?? 0) - fractional.length;
  const digits = BigInt(`${match[1]}${fractional}`);
  return exponent >= 0
    ? rational(digits * 10n ** BigInt(exponent))
    : rational(digits, 10n ** BigInt(-exponent));
}

export function parsePricedRational(numerator: unknown, denominator: unknown): RationalMicros {
  if (
    typeof numerator !== "string" ||
    typeof denominator !== "string" ||
    numerator.length > 512 ||
    denominator.length > 512 ||
    !/^(0|[1-9][0-9]*)$/u.test(numerator) ||
    !/^[1-9][0-9]*$/u.test(denominator)
  )
    throw new RangeError("invalid priced rational");
  return rational(BigInt(numerator), BigInt(denominator));
}

/** Quantize once after all samples covered by this settlement have been summed. */
export function ceilPricedMicros(value: RationalMicros): number {
  return safeMicros((value.numerator + value.denominator - 1n) / value.denominator);
}

/** An unsettled row's integer projection is evidence, never the debit amount. */
export function floorPricedMicros(value: RationalMicros): number {
  return safeMicros(value.numerator / value.denominator);
}
