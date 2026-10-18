/** PRIVATE unmounted DATA assembly. No issuer, permission, provider call or SQL execution. */

import { canonicalJson } from "../../src/json.ts";
import { type SqlStatement } from "../../src/ports.ts";
import { parseSharedFinancialAction } from "../../src/shared-financial-action.ts";
import {
  type ConsentCandidate,
  prepareConsentBatch,
} from "../../src/shared-financial-consent-data.ts";
import {
  createFinancialRetainedR1Store,
  type FinancialR1WriteCommand,
} from "../../src/shared-financial-retained-r1.ts";

export interface FiveActionConsentDataInput {
  readonly consent: ConsentCandidate;
  readonly actionBody: unknown;
  readonly original: FinancialR1WriteCommand;
}

function refuse(): never {
  throw new TypeError("five-action consent DATA mismatch or unavailable original");
}

/** Detach own JSON data before the first read/await; never invoke an accessor or toJSON. */
function detach(value: unknown, depth = 0, ancestors = new Set<object>()): unknown {
  if (depth > 32) return refuse();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length <= 131072 ? value : refuse();
  if (typeof value === "number") return Number.isFinite(value) ? value : refuse();
  if (typeof value !== "object" || ancestors.has(value)) return refuse();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    return refuse();
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length > (Array.isArray(value) ? 1001 : 128)) return refuse();
    const result: Record<string, unknown> | unknown[] = Array.isArray(value)
      ? []
      : Object.create(null);
    if (Array.isArray(value) && keys.length !== value.length + 1) return refuse();
    for (const key of keys) {
      if (Array.isArray(value) && key === "length") continue;
      if (typeof key !== "string") return refuse();
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !("value" in field) || !field.enumerable) return refuse();
      Object.defineProperty(result, key, {
        value: detach(field.value, depth + 1, ancestors),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

/** The existing R1 reader owns exactPair, economic/body/terms/source verification and the C0 join.
 * A matching historical original is DATA, never fresh admission or retry authority. */
export function createFiveActionConsentDataAssembler(
  options: Parameters<typeof createFinancialRetainedR1Store>[0],
) {
  const originals = createFinancialRetainedR1Store(options);
  async function prepare(input: FiveActionConsentDataInput): Promise<readonly SqlStatement[]> {
    const data = detach(input) as FiveActionConsentDataInput;
    if (
      Object.keys(data).length !== 3 ||
      !Object.hasOwn(data, "consent") ||
      !Object.hasOwn(data, "actionBody") ||
      !Object.hasOwn(data, "original")
    )
      return refuse();
    const action = parseSharedFinancialAction(data.actionBody);
    const consent = data.consent;
    if (
      consent.actionKind !== action.kind ||
      consent.actionRef !== action.reference ||
      consent.challengeRef !== data.original.key.challengeRef
    )
      return refuse();
    const retained = await originals.readJoinedRetainedR1Data(consent.challengeRef);
    if (retained.status !== "found") return refuse();
    const o = retained.original;
    const expected: FinancialR1WriteCommand = {
      key: { challengeRef: o.challengeRef, preparationRef: o.preparationRef, r1Ref: o.r1Ref },
      r1ReceiptRef: retained.r1ReceiptRef,
      original: o,
    };
    if (
      canonicalJson(data.original) !== canonicalJson(expected) ||
      canonicalJson(action) !== canonicalJson(retained.actionIdentity.action) ||
      consent.requestFingerprint !== retained.actionIdentity.requestFingerprint ||
      action.organizationId !== o.scopeRealm.organizationId ||
      action.organizationId !== o.c0.challenge.organizationId
    )
      return refuse();
    // Keep all three original SQL bodies and their ordered typed params unchanged.
    return prepareConsentBatch(consent, action.organizationId);
  }
  return Object.freeze({ prepare });
}
