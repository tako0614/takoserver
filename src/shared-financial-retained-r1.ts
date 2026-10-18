import type { PurchaseCreditExpiry } from "./billing-config.ts";
import {
  assertHostedBillingFinancialRealm,
  assertHostedBillingFinancialRealmPersisted,
  type HostedBillingFinancialRealm,
} from "./hosted-billing-realm.ts";
import { base64UrlDecode, bytesDigest, canonicalDigest, canonicalJson } from "./json.ts";
import { assertMoneyCutoverSqlOrigin } from "./money-cutover-sql.ts";
import type { Row, Sql, SqlParam, SqlStatement } from "./ports.ts";
import {
  createSharedFinancialActionIdentity,
  type SharedFinancialAction,
  type SharedFinancialActionIdentity,
} from "./shared-financial-action.ts";
import {
  type FinancialIdentityChallenge,
  type FinancialSourceDigest,
  financialSourceDigest,
  financialSourceRef,
  parseFinancialIdentityChallenge,
} from "./shared-financial-source-contract.ts";
import {
  createFinancialPreproofChallengeStore,
  type FinancialEnrollmentComponentOptions,
  type FinancialPreproofPreparation,
  type FinancialPreproofPreparedImage,
  type FinancialPreproofScope,
  type FinancialPreproofScopeRealmImage,
} from "./shared-financial-source-enrollment.ts";
import type { StripeBillingClient } from "./stripe-billing-client.ts";

/** Unmounted, mechanical data custody only. No exported producer, issuer, caller or admission authority. */
const VERSION = "takoserver-financial-retained-r1-v1";
const TERMS_RECIPE = "financial-terms-utf8-sha256-v1";
const REG_RECIPE = "financial-action-registration-canonical-v1";
const SOURCE_RECIPE = "financial-selected-action-source-canonical-v1";
const MAX_COMMAND_BYTES = 98_304;
const MAX_TERMS_BYTES = 32_768;
const R1_SCHEMA_DIGEST = "sha256:8d1add60a5469f72a3796381ca9c23eef24325e2b9fb08e156a83e85e34a66e1";
const R1_NAMES = [
  "financial_action_source_registrations",
  "financial_retained_r1_originals",
  "financial_retained_r1_receipts",
] as const;

/** Exact Financial 0104 fence DDL; compare sqlite_schema rows, never a speculative fixed digest. */
const R1_FENCE_DDL = Object.freeze({
  financial_action_source_registrations_money_fence:
    "CREATE TRIGGER financial_action_source_registrations_money_fence BEFORE INSERT ON financial_action_source_registrations\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE p.singleton=1 AND p.epoch='usd-micros-v2') BEGIN\n SELECT RAISE(ABORT,'constraint: Financial R1 registration permit required');\nEND",
  financial_retained_r1_originals_money_fence:
    "CREATE TRIGGER financial_retained_r1_originals_money_fence BEFORE INSERT ON financial_retained_r1_originals\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM money_cutover_writer_permit p\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE p.singleton=1 AND p.epoch='usd-micros-v2'\n AND p.writer_epoch IS json_extract(NEW.scope_json,'$.writerEpoch')\n AND p.writer_epoch IS json_extract(NEW.original_json,'$.scopeRealm.writerEpoch')) BEGIN\n SELECT RAISE(ABORT,'constraint: Financial R1 original permit/epoch required');\nEND",
  financial_retained_r1_receipts_money_fence:
    "CREATE TRIGGER financial_retained_r1_receipts_money_fence BEFORE INSERT ON financial_retained_r1_receipts\nWHEN EXISTS(SELECT 1 FROM money_cutover_freeze)\n OR NOT EXISTS(SELECT 1 FROM financial_retained_r1_originals o\n JOIN money_cutover_writer_permit p ON p.singleton=1 AND p.epoch='usd-micros-v2'\n JOIN money_cutover_authorized_epoch a ON a.singleton=1 AND a.writer_epoch=p.writer_epoch\n WHERE o.r1_ref IS NEW.r1_ref AND o.challenge_ref IS NEW.challenge_ref\n AND o.preparation_ref IS NEW.preparation_ref AND o.receipt_ref IS NEW.receipt_ref\n AND o.command_json IS NEW.command_json AND o.original_digest IS NEW.original_digest\n AND p.writer_epoch IS json_extract(o.scope_json,'$.writerEpoch')\n AND p.writer_epoch IS json_extract(o.original_json,'$.scopeRealm.writerEpoch')) BEGIN\n SELECT RAISE(ABORT,'constraint: Financial R1 receipt permit/epoch required');\nEND",
} as const);

export class FinancialRetainedR1Error extends Error {
  constructor(
    readonly code: "invalid_request" | "conflict" | "unavailable",
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "FinancialRetainedR1Error";
  }
}
function fail(code: FinancialRetainedR1Error["code"], cause?: unknown): never {
  throw new FinancialRetainedR1Error(code, cause === undefined ? undefined : { cause });
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail("invalid_request");
  return value as Record<string, unknown>;
}
function ref(value: unknown): string {
  if (!financialSourceRef(value)) fail("invalid_request");
  return value;
}
function digest(value: unknown): FinancialSourceDigest {
  if (!financialSourceDigest(value)) fail("invalid_request");
  return value;
}
function safe(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    fail("invalid_request");
  return value;
}
function iso(value: unknown): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail("invalid_request");
  return value;
}
function same(a: unknown, b: unknown): boolean {
  return json(a) === json(b);
}
/** R1-local whole-image codec. The older M wire codec limits *each string* to 16 KiB,
 * which would silently make a valid 32 KiB exact UTF-8 display body unretainable after
 * base64url encoding. This keeps the same sorted JSON recipe but owns its explicit R1 limit. */
function r1Value(value: unknown, depth = 0, ancestors = new Set<object>()): unknown {
  if (depth > 24) fail("invalid_request");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return safe(value);
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    if (
      bytes.length > MAX_COMMAND_BYTES ||
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes) !== value
    )
      fail("invalid_request");
    return value;
  }
  if (typeof value !== "object" || ancestors.has(value)) fail("invalid_request");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 1000 || Reflect.ownKeys(value).length !== value.length + 1)
        fail("invalid_request");
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
          fail("invalid_request");
        return r1Value(descriptor.value, depth + 1, ancestors);
      });
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail("invalid_request");
    const keys = Reflect.ownKeys(value);
    if (keys.length > 128) fail("invalid_request");
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string") fail("invalid_request");
      r1Value(key, depth + 1, ancestors);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        fail("invalid_request");
      result[key] = r1Value(descriptor.value, depth + 1, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
function json(value: unknown): string {
  const body = canonicalJson(r1Value(value));
  if (new TextEncoder().encode(body).length > MAX_COMMAND_BYTES) fail("invalid_request");
  return body;
}
/** Detach every field before a digest or SQL await. Oversize means explicit refusal, never truncation. */
function snapshot<T>(value: T): T {
  try {
    return JSON.parse(json(value)) as T;
  } catch (error) {
    if (error instanceof FinancialRetainedR1Error) throw error;
    return fail("invalid_request", error);
  }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const part of Object.values(value)) freeze(part);
    Object.freeze(value);
  }
  return value;
}

export interface SelectedTermsOriginal {
  readonly ref: string;
  readonly digest: FinancialSourceDigest;
  readonly mediaType: "text/plain; charset=utf-8";
  readonly locale: string;
  readonly bodyUtf8Base64url: string;
  readonly bodyByteLength: number;
  readonly digestRecipe: typeof TERMS_RECIPE;
}
export interface SelectedActionSourceOriginal {
  readonly ref: string;
  readonly digest: FinancialSourceDigest;
  readonly registrationRef: string;
  readonly registrationDigest: FinancialSourceDigest;
  readonly incarnation: string;
  readonly originRef: string;
  readonly financialRealm: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly workspaceRef: string;
  readonly selectedAt: number;
}
export type SelectedEconomicR1 =
  | {
      readonly kind: "topup";
      readonly amountMinor: number;
      readonly currency: "USD";
      readonly pricingRevision: string;
      readonly purchaseCreditExpiry: PurchaseCreditExpiry;
      readonly minimumMinor: number;
      readonly maximumMinor: number;
    }
  | {
      readonly kind: "subscription-start";
      readonly planKey: string;
      readonly pricingRevision: string;
      readonly priceId: string;
      readonly priceAmountMinor: number;
      readonly includedMinor: number;
      readonly currency: "USD";
      readonly periodMonths: 1;
    }
  | {
      readonly kind: "card-setup";
      readonly setupDisclosureRevision: string;
      readonly onDemandTermsRevision: string;
    }
  | {
      readonly kind: "plan-change";
      readonly expectedSubscriptionRef: string;
      readonly targetSubscriptionId: string;
      readonly targetGeneration: number;
      readonly targetPeriodStart: string;
      readonly targetPeriodEnd: string;
      readonly planKey: string;
      readonly pricingRevision: string;
      readonly priceId: string;
      readonly priceAmountMinor: number;
      readonly includedMinor: number;
      readonly currency: "USD";
    }
  | {
      readonly kind: "cancel";
      readonly expectedSubscriptionRef: string;
      readonly targetSubscriptionId: string;
      readonly targetGeneration: number;
      readonly branch: "legacy" | "pending-plan-change";
      readonly pendingReference: string | null;
      readonly scheduleId: string | null;
      readonly cancelAtPeriodEnd: true;
    };
export interface FinancialR1Original {
  readonly version: typeof VERSION;
  readonly r1Ref: string;
  readonly challengeRef: string;
  readonly preparationRef: string;
  readonly c0ReceiptRef: string;
  readonly c0: FinancialPreproofPreparation;
  readonly scopeRealm: FinancialPreproofScopeRealmImage;
  readonly economic: SelectedEconomicR1;
  readonly selectedTerms: SelectedTermsOriginal;
  readonly actionSource: SelectedActionSourceOriginal;
}
export interface FinancialR1WriteCommand {
  readonly key: {
    readonly challengeRef: string;
    readonly preparationRef: string;
    readonly r1Ref: string;
  };
  readonly r1ReceiptRef: string;
  readonly original: FinancialR1Original;
}
export interface FinancialR1Receipt {
  readonly r1ReceiptRef: string;
  readonly r1Ref: string;
  readonly challengeRef: string;
  readonly preparationRef: string;
  readonly originalDigest: FinancialSourceDigest;
}
export type FinancialR1Read =
  | { readonly status: "not-found" }
  | {
      readonly status: "found";
      readonly original: FinancialR1Original;
      readonly receipt: FinancialR1Receipt;
    };
export type FinancialR1JoinedRead =
  | { readonly status: "not-found" }
  | {
      readonly status: "found";
      readonly original: FinancialR1Original;
      readonly actionIdentity: SharedFinancialActionIdentity;
      readonly r1ReceiptRef: string;
      readonly c0ReceiptRef: string;
    };

interface Captured {
  readonly sql: Sql;
  readonly client: StripeBillingClient;
  readonly realm: HostedBillingFinancialRealm;
  readonly c0Options: FinancialEnrollmentComponentOptions & {
    readonly scope: FinancialPreproofScope;
  };
  readonly scopeRealm: FinancialPreproofScopeRealmImage;
  readonly current: string;
  readonly currentParams: readonly SqlParam[];
}
function capture(
  options: FinancialEnrollmentComponentOptions & { readonly scope: FinancialPreproofScope },
): Captured {
  const { sql, client, clock, realm } = options;
  const writerEpoch = digest(options.writerEpoch);
  try {
    assertMoneyCutoverSqlOrigin(sql, { writerEpoch });
    assertHostedBillingFinancialRealm(realm, {
      sql,
      client,
      billingAuthority: realm.billingAuthority,
    });
  } catch (error) {
    return fail("unavailable", error);
  }
  const s = exact(snapshot(options.scope), [
    "registrationRef",
    "clientId",
    "workspaceId",
    "organizationId",
    "workspaceRef",
  ]);
  const scope: FinancialPreproofScope = {
    registrationRef: ref(s.registrationRef),
    clientId: ref(s.clientId),
    workspaceId: ref(s.workspaceId),
    organizationId: ref(s.organizationId),
    workspaceRef: ref(s.workspaceRef),
  };
  const receiverRef = ref(options.receiverRef),
    targetRef = ref(options.targetRef);
  const scopeRealm = freeze({
    ...scope,
    accountId: realm.accountId,
    mode: realm.mode,
    billingAuthority: realm.billingAuthority,
    financialRealm: realm.financialRealm,
    writerEpoch,
    receiverRef,
    targetRef,
  });
  const c0Options = Object.freeze({
    sql,
    client,
    clock,
    realm,
    writerEpoch,
    receiverRef,
    targetRef,
    scope,
  });
  return Object.freeze({
    sql,
    client,
    realm,
    c0Options,
    scopeRealm,
    current: `EXISTS (SELECT 1 FROM stripe_mode_realm WHERE singleton=1 AND mode='test')
      AND EXISTS (SELECT 1 FROM stripe_billing_account_realms WHERE singleton=1 AND account_id=? AND mode='test' AND billing_authority=?)`,
    currentParams: Object.freeze([realm.accountId, realm.billingAuthority]),
  });
}
function economic(value: unknown, action: SharedFinancialActionIdentity): SelectedEconomicR1 {
  const fields = {
    topup: [
      "kind",
      "amountMinor",
      "currency",
      "pricingRevision",
      "purchaseCreditExpiry",
      "minimumMinor",
      "maximumMinor",
    ],
    "subscription-start": [
      "kind",
      "planKey",
      "pricingRevision",
      "priceId",
      "priceAmountMinor",
      "includedMinor",
      "currency",
      "periodMonths",
    ],
    "card-setup": ["kind", "setupDisclosureRevision", "onDemandTermsRevision"],
    "plan-change": [
      "kind",
      "expectedSubscriptionRef",
      "targetSubscriptionId",
      "targetGeneration",
      "targetPeriodStart",
      "targetPeriodEnd",
      "planKey",
      "pricingRevision",
      "priceId",
      "priceAmountMinor",
      "includedMinor",
      "currency",
    ],
    cancel: [
      "kind",
      "expectedSubscriptionRef",
      "targetSubscriptionId",
      "targetGeneration",
      "branch",
      "pendingReference",
      "scheduleId",
      "cancelAtPeriodEnd",
    ],
  } as const;
  const e = exact(value, fields[action.action.kind]);
  if (e.kind !== action.action.kind) fail("invalid_request");
  switch (action.action.kind) {
    case "topup": {
      const amount = safe(e.amountMinor, 1),
        minimum = safe(e.minimumMinor, 1),
        maximum = safe(e.maximumMinor, 1);
      if (
        amount !== action.action.amountMinor ||
        e.currency !== "USD" ||
        minimum > amount ||
        maximum < amount
      )
        fail("invalid_request");
      ref(e.pricingRevision);
      if (
        e.purchaseCreditExpiry === null ||
        typeof e.purchaseCreditExpiry !== "object" ||
        Array.isArray(e.purchaseCreditExpiry)
      )
        fail("invalid_request");
      if ((e.purchaseCreditExpiry as { kind?: unknown }).kind === "none")
        exact(e.purchaseCreditExpiry, ["kind"]);
      else {
        const expiry = exact(e.purchaseCreditExpiry, ["kind", "seconds"]);
        if (expiry.kind !== "fixed-duration") fail("invalid_request");
        safe(expiry.seconds, 1);
      }
      break;
    }
    case "subscription-start":
      if (e.planKey !== action.action.planKey || e.currency !== "USD" || e.periodMonths !== 1)
        fail("invalid_request");
      ref(e.pricingRevision);
      ref(e.priceId);
      safe(e.priceAmountMinor, 1);
      safe(e.includedMinor);
      break;
    case "card-setup":
      if (e.setupDisclosureRevision !== action.action.setupDisclosureRevision)
        fail("invalid_request");
      ref(e.onDemandTermsRevision);
      break;
    case "plan-change":
      if (
        e.planKey !== action.action.planKey ||
        e.expectedSubscriptionRef !== action.action.expectedSubscriptionRef ||
        e.currency !== "USD"
      )
        fail("invalid_request");
      ref(e.targetSubscriptionId);
      safe(e.targetGeneration);
      ref(e.targetPeriodStart);
      ref(e.targetPeriodEnd);
      ref(e.pricingRevision);
      ref(e.priceId);
      safe(e.priceAmountMinor, 1);
      safe(e.includedMinor);
      break;
    case "cancel":
      if (
        e.expectedSubscriptionRef !== action.action.expectedSubscriptionRef ||
        e.cancelAtPeriodEnd !== true ||
        (e.branch !== "legacy" && e.branch !== "pending-plan-change")
      )
        fail("invalid_request");
      ref(e.targetSubscriptionId);
      safe(e.targetGeneration);
      if (e.pendingReference !== null) ref(e.pendingReference);
      if (e.scheduleId !== null) ref(e.scheduleId);
      break;
  }
  return value as SelectedEconomicR1;
}
function registrationBody(s: SelectedActionSourceOriginal) {
  return {
    version: REG_RECIPE,
    registrationRef: s.registrationRef,
    incarnation: s.incarnation,
    sourceRef: s.ref,
    originRef: s.originRef,
    financialRealm: s.financialRealm,
    organizationId: s.organizationId,
    workspaceId: s.workspaceId,
    workspaceRef: s.workspaceRef,
  };
}
function sourceBody(s: SelectedActionSourceOriginal) {
  return {
    version: SOURCE_RECIPE,
    ref: s.ref,
    registrationRef: s.registrationRef,
    registrationDigest: s.registrationDigest,
    incarnation: s.incarnation,
    originRef: s.originRef,
    financialRealm: s.financialRealm,
    organizationId: s.organizationId,
    workspaceId: s.workspaceId,
    workspaceRef: s.workspaceRef,
    selectedAt: s.selectedAt,
  };
}
interface Parsed {
  readonly command: FinancialR1WriteCommand;
  readonly commandJson: string;
  readonly originalJson: string;
  readonly originalDigest: FinancialSourceDigest;
  readonly registrationJson: string;
  readonly actionIdentity: SharedFinancialActionIdentity;
}
async function parseCaptured(input: FinancialR1WriteCommand, c: Captured): Promise<Parsed> {
  // The complete command is detached before the first await, including all nested option images.
  const detached = snapshot(input);
  const cmd = exact(detached, ["key", "r1ReceiptRef", "original"]);
  const key = exact(cmd.key, ["challengeRef", "preparationRef", "r1Ref"]);
  const refs = [
    ref(key.challengeRef),
    ref(key.preparationRef),
    ref(key.r1Ref),
    ref(cmd.r1ReceiptRef),
  ];
  if (new Set(refs).size !== 4) fail("invalid_request");
  const o = exact(cmd.original, [
    "version",
    "r1Ref",
    "challengeRef",
    "preparationRef",
    "c0ReceiptRef",
    "c0",
    "scopeRealm",
    "economic",
    "selectedTerms",
    "actionSource",
  ]);
  if (
    o.version !== VERSION ||
    o.r1Ref !== refs[2] ||
    o.challengeRef !== refs[0] ||
    o.preparationRef !== refs[1] ||
    !same(o.scopeRealm, c.scopeRealm)
  )
    fail("invalid_request");
  const pre = exact(o.c0, ["preparationRef", "receiptRef", "challenge", "selection"]);
  let challenge: FinancialIdentityChallenge;
  try {
    challenge = parseFinancialIdentityChallenge(pre.challenge);
  } catch (error) {
    return fail("invalid_request", error);
  }
  if (
    pre.preparationRef !== refs[1] ||
    pre.receiptRef !== ref(o.c0ReceiptRef) ||
    challenge.challengeRef !== refs[0] ||
    challenge.registrationRef !== c.scopeRealm.registrationRef ||
    challenge.clientId !== c.scopeRealm.clientId ||
    challenge.workspaceId !== c.scopeRealm.workspaceId ||
    challenge.organizationId !== c.scopeRealm.organizationId ||
    challenge.workspaceRef !== c.scopeRealm.workspaceRef
  )
    fail("invalid_request");
  const selection = exact(pre.selection, [
    "action",
    "customer",
    "business",
    "terms",
    "carrier",
    "billingBinding",
  ]);
  const a = exact(selection.action, ["kind", "ref", "body", "requestFingerprint"]);
  const t = exact(selection.terms, ["ref", "digest"]);
  const customer = exact(selection.customer, [
    "requestRef",
    "idempotencyKey",
    "requestFingerprint",
    "financialRealm",
  ]);
  const business = exact(selection.business, ["ref", "requestFingerprint"]);
  const binding = exact(selection.billingBinding, [
    "bindingRef",
    "organizationId",
    "workspaceId",
    "workspaceRef",
  ]);
  const carrier = exact(selection.carrier, [
    "issuerRef",
    "requestRef",
    "carrierRef",
    "contextRef",
    "createdAt",
  ]);
  for (const field of [
    carrier.issuerRef,
    carrier.requestRef,
    carrier.carrierRef,
    carrier.contextRef,
  ])
    ref(field);
  iso(carrier.createdAt);
  ref(a.ref);
  digest(a.requestFingerprint);
  ref(t.ref);
  digest(t.digest);
  ref(customer.requestRef);
  ref(customer.idempotencyKey);
  digest(customer.requestFingerprint);
  ref(business.ref);
  digest(business.requestFingerprint);
  ref(binding.bindingRef);
  if (
    customer.financialRealm !== c.scopeRealm.financialRealm ||
    binding.organizationId !== c.scopeRealm.organizationId ||
    binding.workspaceId !== c.scopeRealm.workspaceId ||
    binding.workspaceRef !== c.scopeRealm.workspaceRef ||
    a.requestFingerprint !== challenge.requestFingerprint
  )
    fail("invalid_request");
  const terms = exact(o.selectedTerms, [
    "ref",
    "digest",
    "mediaType",
    "locale",
    "bodyUtf8Base64url",
    "bodyByteLength",
    "digestRecipe",
  ]);
  if (
    terms.ref !== t.ref ||
    terms.digest !== t.digest ||
    terms.mediaType !== "text/plain; charset=utf-8" ||
    terms.digestRecipe !== TERMS_RECIPE ||
    typeof terms.locale !== "string" ||
    !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(terms.locale) ||
    typeof terms.bodyUtf8Base64url !== "string"
  )
    fail("invalid_request");
  const termBytes = base64UrlDecode(terms.bodyUtf8Base64url);
  if (
    !termBytes ||
    termBytes.length < 1 ||
    termBytes.length > MAX_TERMS_BYTES ||
    termBytes.length !== safe(terms.bodyByteLength, 1)
  )
    fail("invalid_request");
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(termBytes);
    const roundTrip = new TextEncoder().encode(decoded);
    if (
      roundTrip.length !== termBytes.length ||
      roundTrip.some((byte, index) => byte !== termBytes[index])
    )
      fail("invalid_request");
  } catch (error) {
    return fail("invalid_request", error);
  }
  const source = exact(o.actionSource, [
    "ref",
    "digest",
    "registrationRef",
    "registrationDigest",
    "incarnation",
    "originRef",
    "financialRealm",
    "organizationId",
    "workspaceId",
    "workspaceRef",
    "selectedAt",
  ]);
  const s = source as unknown as SelectedActionSourceOriginal;
  for (const field of [
    s.ref,
    s.registrationRef,
    s.incarnation,
    s.originRef,
    s.financialRealm,
    s.organizationId,
    s.workspaceId,
    s.workspaceRef,
  ])
    ref(field);
  digest(s.digest);
  digest(s.registrationDigest);
  safe(s.selectedAt);
  if (
    s.organizationId !== c.scopeRealm.organizationId ||
    s.workspaceId !== c.scopeRealm.workspaceId ||
    s.workspaceRef !== c.scopeRealm.workspaceRef ||
    s.financialRealm !== c.scopeRealm.financialRealm ||
    s.selectedAt > challenge.createdAt
  )
    fail("invalid_request");
  let actionIdentity: SharedFinancialActionIdentity;
  try {
    actionIdentity = await createSharedFinancialActionIdentity(a.body);
  } catch (error) {
    return fail("invalid_request", error);
  }
  if (
    actionIdentity.action.kind !== a.kind ||
    actionIdentity.action.reference !== a.ref ||
    actionIdentity.action.organizationId !== challenge.organizationId ||
    actionIdentity.requestFingerprint !== a.requestFingerprint ||
    actionIdentity.requestFingerprint !== challenge.requestFingerprint
  )
    fail("invalid_request");
  economic(o.economic, actionIdentity);
  if (
    (await bytesDigest(termBytes)) !== terms.digest ||
    (await canonicalDigest([REG_RECIPE, registrationBody(s)])) !== s.registrationDigest ||
    (await canonicalDigest([SOURCE_RECIPE, sourceBody(s)])) !== s.digest
  )
    fail("invalid_request");
  const command = freeze(detached) as FinancialR1WriteCommand;
  return {
    command,
    commandJson: json(command),
    originalJson: json(command.original),
    originalDigest: await canonicalDigest(command.original),
    registrationJson: json(registrationBody(s)),
    actionIdentity,
  };
}
function keyParams(command: FinancialR1WriteCommand): readonly SqlParam[] {
  return [
    command.key.r1Ref,
    command.key.challengeRef,
    command.key.preparationRef,
    command.r1ReceiptRef,
  ];
}
const COLLISION = `r1_ref IN (?,?,?,?) OR challenge_ref IN (?,?,?,?)
  OR preparation_ref IN (?,?,?,?) OR receipt_ref IN (?,?,?,?)`;
function collisionParams(command: FinancialR1WriteCommand): readonly SqlParam[] {
  const refs = keyParams(command);
  return [...refs, ...refs, ...refs, ...refs];
}
async function ready(c: Captured): Promise<void> {
  const rows = await c.sql.query(
    `SELECT type,name,sql FROM sqlite_schema WHERE tbl_name IN (?,?,?) AND sql IS NOT NULL ORDER BY type,name`,
    R1_NAMES,
  );
  const fenceNames = Object.keys(R1_FENCE_DDL);
  const core = rows.filter((row) => !fenceNames.includes(row.name as string));
  const fences = rows.filter((row) => fenceNames.includes(row.name as string));
  const expectedFences = Object.entries(R1_FENCE_DDL)
    .map(([name, sql]) => ({ type: "trigger", name, sql }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (
    rows.length !== 17 ||
    core.length !== 14 ||
    fences.length !== 3 ||
    (await canonicalDigest(core)) !== R1_SCHEMA_DIGEST ||
    (await canonicalDigest(fences)) !== (await canonicalDigest(expectedFences))
  )
    fail("unavailable");
  await assertHostedBillingFinancialRealmPersisted(c.realm, {
    sql: c.sql,
    client: c.client,
    billingAuthority: c.realm.billingAuthority,
  });
}
async function registered(c: Captured, p: Parsed): Promise<void> {
  const s = p.command.original.actionSource;
  const rows = await c.sql.query(
    `SELECT registration_ref,incarnation,registration_digest,digest_recipe,registration_json
     FROM financial_action_source_registrations WHERE registration_ref=? AND incarnation=?`,
    [s.registrationRef, s.incarnation],
  );
  if (
    rows.length !== 1 ||
    rows[0]?.registration_ref !== s.registrationRef ||
    rows[0].incarnation !== s.incarnation ||
    rows[0].registration_digest !== s.registrationDigest ||
    rows[0].digest_recipe !== REG_RECIPE ||
    rows[0].registration_json !== p.registrationJson
  )
    fail("unavailable");
}
async function rowsFor(c: Captured, command: FinancialR1WriteCommand) {
  const params = collisionParams(command);
  const originals = await c.sql.query(
    `SELECT * FROM financial_retained_r1_originals WHERE ${COLLISION}`,
    params,
  );
  const receipts = await c.sql.query(
    `SELECT * FROM financial_retained_r1_receipts WHERE ${COLLISION}`,
    params,
  );
  return { originals, receipts };
}
async function exactPair(
  c: Captured,
  p: Parsed,
  originals: readonly Row[],
  receipts: readonly Row[],
): Promise<FinancialR1Receipt> {
  if (originals.length !== 1 || receipts.length !== 1) fail("unavailable");
  const o = originals[0],
    r = receipts[0];
  if (!o || !r) fail("unavailable");
  const cmd = p.command,
    s = cmd.original.actionSource;
  const refs = keyParams(cmd);
  if (
    [o.r1_ref, o.challenge_ref, o.preparation_ref, o.receipt_ref].some((v, i) => v !== refs[i]) ||
    [r.r1_ref, r.challenge_ref, r.preparation_ref, r.receipt_ref].some((v, i) => v !== refs[i])
  )
    fail("conflict");
  if (typeof o.command_json !== "string" || typeof o.original_json !== "string")
    fail("unavailable");
  let stored: Parsed;
  try {
    stored = await parseCaptured(JSON.parse(o.command_json) as FinancialR1WriteCommand, c);
  } catch (error) {
    return fail("unavailable", error);
  }
  if (stored.commandJson !== o.command_json || stored.originalJson !== o.original_json)
    fail("unavailable");
  if (o.command_json !== p.commandJson) fail("conflict");
  if (
    o.original_json !== p.originalJson ||
    o.original_digest !== p.originalDigest ||
    o.scope_json !== json(cmd.original.scopeRealm) ||
    o.terms_ref !== cmd.original.selectedTerms.ref ||
    o.terms_digest !== cmd.original.selectedTerms.digest ||
    o.source_registration_ref !== s.registrationRef ||
    o.source_registration_digest !== s.registrationDigest ||
    o.source_incarnation !== s.incarnation ||
    r.command_json !== p.commandJson ||
    r.original_digest !== p.originalDigest ||
    r.all_rows_match !== 1
  )
    fail("unavailable");
  return freeze({
    r1ReceiptRef: cmd.r1ReceiptRef,
    r1Ref: cmd.key.r1Ref,
    challengeRef: cmd.key.challengeRef,
    preparationRef: cmd.key.preparationRef,
    originalDigest: p.originalDigest,
  });
}

/** Builds data-only SQL for a separately qualified future producer or isolated fixture.
 * This never writes, qualifies a registration, authorizes a retry, or supplies an entry route. */
export async function buildFinancialR1MechanicalBatch(
  options: FinancialEnrollmentComponentOptions & { readonly scope: FinancialPreproofScope },
  command: FinancialR1WriteCommand,
): Promise<readonly SqlStatement[]> {
  const c = capture(options);
  let p: Parsed;
  try {
    p = await parseCaptured(command, c);
  } catch (error) {
    if (error instanceof FinancialRetainedR1Error) throw error;
    return fail("unavailable", error);
  }
  return compileMechanicalBatch(c, p);
}
// One primary business namespace. Fingerprint, workspace/client and new refs are never absence keys.
const R1_BUSINESS = `json_extract(command_json,'$.original.c0.selection.action.body.kind') IS ?
  AND json_extract(command_json,'$.original.c0.selection.action.body.organizationId') IS ?
  AND json_extract(command_json,'$.original.c0.selection.action.body.reference') IS ?`;
// Legacy C0 body is opaque. Its actual Org is the parsed challenge Org, never an unvalidated body claim.
const C0_BUSINESS = `((json_extract(record_json,'$.selection.action.body.kind') IS ?
  AND json_extract(record_json,'$.challenge.organizationId') IS ?
  AND json_extract(record_json,'$.selection.action.body.reference') IS ?)
  OR (json_extract(record_json,'$.selection.action.kind') IS ?
  AND json_extract(record_json,'$.challenge.organizationId') IS ?
  AND json_extract(record_json,'$.selection.action.ref') IS ?))`;

/** New-five-only original. Fixed one-row DATA input reuses all four role IDs and C0 image values.
 * No field or predicate is omitted to reserve space for a separately qualified future guard. */
function compileCoPreparationOriginal(
  p: Parsed,
  c0: FinancialPreproofPreparedImage,
  current: string,
  currentParams: readonly SqlParam[],
): SqlStatement {
  const o = p.command.original,
    s = o.actionSource,
    action = p.actionIdentity.action;
  const r1Business = `json_extract(command_json,'$.original.c0.selection.action.body.kind') IS i.action_kind
    AND json_extract(command_json,'$.original.c0.selection.action.body.organizationId') IS i.organization_id
    AND json_extract(command_json,'$.original.c0.selection.action.body.reference') IS i.action_reference`;
  const c0Business = `((json_extract(record_json,'$.selection.action.body.kind') IS i.action_kind
    AND json_extract(record_json,'$.challenge.organizationId') IS i.organization_id
    AND json_extract(record_json,'$.selection.action.body.reference') IS i.action_reference)
    OR (json_extract(record_json,'$.selection.action.kind') IS i.action_kind
    AND json_extract(record_json,'$.challenge.organizationId') IS i.organization_id
    AND json_extract(record_json,'$.selection.action.ref') IS i.action_reference))`;
  const collisions = `r1_ref IN (i.r1_ref,i.challenge_ref,i.preparation_ref,i.receipt_ref)
    OR challenge_ref IN (i.r1_ref,i.challenge_ref,i.preparation_ref,i.receipt_ref)
    OR preparation_ref IN (i.r1_ref,i.challenge_ref,i.preparation_ref,i.receipt_ref)
    OR receipt_ref IN (i.r1_ref,i.challenge_ref,i.preparation_ref,i.receipt_ref)`;
  return Object.freeze({
    sql: `WITH r1_input(r1_ref,challenge_ref,preparation_ref,receipt_ref,command_json,original_json,original_digest,
        terms_ref,terms_digest,source_registration_ref,source_registration_digest,source_incarnation,scope_json,
        action_kind,organization_id,action_reference,c0_receipt_ref,c0_challenge_json,c0_scope_json,c0_record_json,c0_created_at)
      AS (VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?))
      INSERT INTO financial_retained_r1_originals(r1_ref,challenge_ref,preparation_ref,receipt_ref,command_json,original_json,original_digest,terms_ref,terms_digest,source_registration_ref,source_registration_digest,source_incarnation,scope_json)
      SELECT i.r1_ref,i.challenge_ref,i.preparation_ref,i.receipt_ref,i.command_json,i.original_json,i.original_digest,
        i.terms_ref,i.terms_digest,i.source_registration_ref,i.source_registration_digest,i.source_incarnation,i.scope_json
      FROM r1_input i WHERE ${current}
      AND NOT EXISTS(SELECT 1 FROM financial_retained_r1_originals WHERE ${collisions})
      AND NOT EXISTS(SELECT 1 FROM financial_retained_r1_receipts WHERE ${collisions})
      AND NOT EXISTS(SELECT 1 FROM financial_retained_r1_originals WHERE ${r1Business})
      AND NOT EXISTS(SELECT 1 FROM financial_retained_r1_receipts WHERE ${r1Business})
      AND NOT EXISTS(SELECT 1 FROM financial_preproof_challenges WHERE ${c0Business}
        AND NOT(challenge_ref IS i.challenge_ref AND preparation_ref IS i.preparation_ref
          AND challenge_json IS i.c0_challenge_json AND scope_json IS i.c0_scope_json
          AND record_json IS i.c0_record_json AND created_at IS i.c0_created_at))
      AND NOT EXISTS(SELECT 1 FROM financial_preproof_challenge_receipts WHERE ${c0Business}
        AND NOT(receipt_ref IS i.c0_receipt_ref AND challenge_ref IS i.challenge_ref
          AND preparation_ref IS i.preparation_ref AND record_json IS i.c0_record_json AND all_rows_match=1))`,
    params: Object.freeze([
      o.r1Ref,
      o.challengeRef,
      o.preparationRef,
      p.command.r1ReceiptRef,
      p.commandJson,
      p.originalJson,
      p.originalDigest,
      o.selectedTerms.ref,
      o.selectedTerms.digest,
      s.registrationRef,
      s.registrationDigest,
      s.incarnation,
      json(o.scopeRealm),
      action.kind,
      action.organizationId,
      action.reference,
      c0.receiptRef,
      c0.challengeJson,
      c0.scopeJson,
      c0.recordJson,
      c0.createdAt,
      ...currentParams,
    ]),
  });
}
function compileMechanicalBatch(
  c: Captured,
  p: Parsed,
  c0?: FinancialPreproofPreparedImage,
): readonly SqlStatement[] {
  const c0Match = c0
    ? ` AND EXISTS(SELECT 1 FROM financial_preproof_challenges c
        JOIN financial_preproof_challenge_receipts q ON q.challenge_ref=c.challenge_ref
        WHERE c.challenge_ref=? AND c.preparation_ref=? AND c.challenge_json=? AND c.scope_json=?
        AND c.record_json=? AND c.created_at=? AND q.receipt_ref=? AND q.challenge_ref=?
        AND q.preparation_ref=? AND q.record_json=? AND q.all_rows_match=1)`
    : "";
  const c0Params: readonly SqlParam[] = c0
    ? [
        c0.challengeRef,
        c0.preparationRef,
        c0.challengeJson,
        c0.scopeJson,
        c0.recordJson,
        c0.createdAt,
        c0.receiptRef,
        c0.challengeRef,
        c0.preparationRef,
        c0.recordJson,
      ]
    : [];
  const o = p.command.original,
    s = o.actionSource;
  const current = `${c.current} AND EXISTS (SELECT 1 FROM financial_action_source_registrations
    WHERE registration_ref=? AND incarnation=? AND registration_digest=? AND digest_recipe=? AND registration_json=?)`;
  const currentParams = [
    ...c.currentParams,
    s.registrationRef,
    s.incarnation,
    s.registrationDigest,
    REG_RECIPE,
    p.registrationJson,
  ];
  const collisions = collisionParams(p.command);
  return Object.freeze([
    c0
      ? compileCoPreparationOriginal(p, c0, current, currentParams)
      : Object.freeze({
          sql: `INSERT INTO financial_retained_r1_originals(r1_ref,challenge_ref,preparation_ref,receipt_ref,command_json,original_json,original_digest,terms_ref,terms_digest,source_registration_ref,source_registration_digest,source_incarnation,scope_json)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${current}
        AND NOT EXISTS(SELECT 1 FROM financial_retained_r1_originals WHERE ${COLLISION})
        AND NOT EXISTS(SELECT 1 FROM financial_retained_r1_receipts WHERE ${COLLISION})`,
          params: Object.freeze([
            o.r1Ref,
            o.challengeRef,
            o.preparationRef,
            p.command.r1ReceiptRef,
            p.commandJson,
            p.originalJson,
            p.originalDigest,
            o.selectedTerms.ref,
            o.selectedTerms.digest,
            s.registrationRef,
            s.registrationDigest,
            s.incarnation,
            json(o.scopeRealm),
            ...currentParams,
            ...collisions,
            ...collisions,
          ]),
        }),
    Object.freeze({
      sql: `INSERT INTO financial_retained_r1_receipts(receipt_ref,r1_ref,challenge_ref,preparation_ref,command_json,original_digest,all_rows_match)
        VALUES(?,?,?,?,?,?,CASE WHEN changes()=1 AND EXISTS(SELECT 1 FROM financial_retained_r1_originals
        WHERE r1_ref=? AND challenge_ref=? AND preparation_ref=? AND receipt_ref=? AND command_json=?
          AND original_digest=?) AND (${current})${c0Match} THEN 1 ELSE 0 END)`,
      params: Object.freeze([
        p.command.r1ReceiptRef,
        o.r1Ref,
        o.challengeRef,
        o.preparationRef,
        p.commandJson,
        p.originalDigest,
        o.r1Ref,
        o.challengeRef,
        o.preparationRef,
        p.command.r1ReceiptRef,
        p.commandJson,
        p.originalDigest,
        ...currentParams,
        ...c0Params,
      ]),
    }),
  ]);
}

/** Fixed five-statement DATA contribution; no execution, issuer or NEW authority.
 * observedAt is metadata only. The owning R.batch/permit/replay coordinator is not supplied. */
export async function buildFinancialR1CoPreparationBatch(
  options: FinancialEnrollmentComponentOptions & { readonly scope: FinancialPreproofScope },
  command: FinancialR1WriteCommand,
  observedAt: string,
): Promise<readonly SqlStatement[]> {
  const c = capture(options),
    at = iso(observedAt);
  try {
    const p = await parseCaptured(command, c),
      s = p.command.original.actionSource;
    // Obtain both statements and their exact preimage from the actual C0 compiler.
    // Neither a caller SQL array nor values reconstructed from SQL params are accepted.
    const c0 = createFinancialPreproofChallengeStore(c.c0Options).buildPreparationContribution(
      p.command.original.c0,
      at,
    );
    const r1 = compileMechanicalBatch(c, p, c0.preparedImage);
    return Object.freeze([
      Object.freeze({
        sql: `INSERT INTO financial_action_source_registrations(registration_ref,incarnation,registration_digest,digest_recipe,registration_json,created_at)
          SELECT ?,?,?,?,?,? WHERE ${c.current}`,
        params: Object.freeze([
          s.registrationRef,
          s.incarnation,
          s.registrationDigest,
          REG_RECIPE,
          p.registrationJson,
          at,
          ...c.currentParams,
        ]),
      }),
      ...c0.statements,
      ...r1,
    ]);
  } catch (error) {
    if (error instanceof FinancialRetainedR1Error) throw error;
    return fail("unavailable", error);
  }
}

/** Historical readers are usable without a future C0 row. Qualified prepare remains unavailable. */
export function createFinancialRetainedR1Store(
  options: FinancialEnrollmentComponentOptions & { readonly scope: FinancialPreproofScope },
) {
  const c = capture(options);
  let c0: ReturnType<typeof createFinancialPreproofChallengeStore>;
  try {
    c0 = createFinancialPreproofChallengeStore(c.c0Options);
  } catch (error) {
    return fail("unavailable", error);
  }
  async function readRetainedR1Original(
    command: FinancialR1WriteCommand,
  ): Promise<FinancialR1Read> {
    // Snapshot the complete caller command synchronously, before any SQL or digest await.
    let detached: FinancialR1WriteCommand;
    try {
      detached = snapshot(command);
    } catch (error) {
      return fail("invalid_request", error);
    }
    try {
      const p = await parseCaptured(detached, c);
      await ready(c);
      const { originals, receipts } = await rowsFor(c, p.command);
      if (originals.length === 0 && receipts.length === 0)
        return Object.freeze({ status: "not-found" });
      if (originals.length > 1 || receipts.length > 1) fail("conflict");
      const receipt = await exactPair(c, p, originals, receipts);
      await registered(c, p);
      return freeze({ status: "found", original: p.command.original, receipt });
    } catch (error) {
      if (error instanceof FinancialRetainedR1Error) throw error;
      return fail("unavailable", error);
    }
  }
  /** Exact historical data join. A matching row is not a qualified source or RP-consent result. */
  async function readJoinedRetainedR1Data(challengeRef: string): Promise<FinancialR1JoinedRead> {
    const key = ref(challengeRef);
    try {
      await ready(c);
      // Positive absence needs the entire R1 namespace, not just the challenge column.
      // A different R1's receipt/preparation/r1 ref cannot be treated as a free challenge.
      const collisions = Array<SqlParam>(16).fill(key);
      const originals = await c.sql.query(
        `SELECT challenge_ref,command_json FROM financial_retained_r1_originals WHERE ${COLLISION}`,
        collisions,
      );
      const receipts = await c.sql.query(
        `SELECT challenge_ref,receipt_ref FROM financial_retained_r1_receipts WHERE ${COLLISION}`,
        collisions,
      );
      if (originals.length > 1 || receipts.length > 1) fail("conflict");
      if (
        originals.some((row) => row.challenge_ref !== key) ||
        receipts.some((row) => row.challenge_ref !== key)
      )
        fail("conflict");
      const c0Image = await c0.readActionSelectionOriginal(key);
      if (originals.length === 0 && receipts.length === 0 && c0Image === undefined)
        return Object.freeze({ status: "not-found" });
      if (originals.length !== 1 || receipts.length !== 1 || c0Image === undefined)
        fail("unavailable");
      const raw = originals[0]?.command_json;
      if (typeof raw !== "string") fail("unavailable");
      let command: FinancialR1WriteCommand;
      try {
        command = JSON.parse(raw) as FinancialR1WriteCommand;
      } catch (error) {
        return fail("unavailable", error);
      }
      let r1: FinancialR1Read;
      try {
        r1 = await readRetainedR1Original(command);
      } catch (error) {
        if (error instanceof FinancialRetainedR1Error && error.code === "invalid_request")
          return fail("unavailable", error);
        throw error;
      }
      if (r1.status !== "found") fail("unavailable");
      const o = r1.original;
      if (
        o.challengeRef !== key ||
        !same(o.c0.challenge, c0Image.challenge) ||
        !same(o.c0.selection, c0Image.selection) ||
        !same(o.scopeRealm, c0Image.scopeRealm) ||
        o.preparationRef !== c0Image.preparationRef ||
        o.c0ReceiptRef !== c0Image.receiptRef ||
        o.selectedTerms.ref !== c0Image.terms.ref ||
        o.selectedTerms.digest !== c0Image.terms.digest
      )
        fail("conflict");
      return freeze({
        status: "found",
        original: o,
        actionIdentity: c0Image.actionIdentity,
        r1ReceiptRef: r1.receipt.r1ReceiptRef,
        c0ReceiptRef: c0Image.receiptRef,
      });
    } catch (error) {
      if (error instanceof FinancialRetainedR1Error) throw error;
      return fail("unavailable", error);
    }
  }
  /** Historical DATA only. not-found never authorizes NEW or proves no effect after unknown ACK. */
  async function readBusinessRetainedR1Data(
    action: SharedFinancialAction,
  ): Promise<FinancialR1JoinedRead> {
    let expected: SharedFinancialActionIdentity;
    try {
      // The strict action parser detaches before its first digest await.
      expected = await createSharedFinancialActionIdentity(snapshot(action));
    } catch (error) {
      return fail("invalid_request", error);
    }
    if (expected.action.organizationId !== c.scopeRealm.organizationId) fail("invalid_request");
    try {
      await ready(c);
      await c0.checkPreparationHistorySchema();
      const params: readonly SqlParam[] = [
        expected.action.kind,
        expected.action.organizationId,
        expected.action.reference,
      ];
      const c0BusinessParams = [...params, ...params];
      const [originals, receipts, c0Originals, c0Receipts] = await Promise.all([
        c.sql.query(
          `SELECT challenge_ref,command_json FROM financial_retained_r1_originals WHERE ${R1_BUSINESS}`,
          params,
        ),
        c.sql.query(
          `SELECT challenge_ref,command_json FROM financial_retained_r1_receipts WHERE ${R1_BUSINESS}`,
          params,
        ),
        c.sql.query(
          `SELECT challenge_ref FROM financial_preproof_challenges WHERE ${C0_BUSINESS}`,
          c0BusinessParams,
        ),
        c.sql.query(
          `SELECT challenge_ref FROM financial_preproof_challenge_receipts WHERE ${C0_BUSINESS}`,
          c0BusinessParams,
        ),
      ]);
      const families = [originals, receipts, c0Originals, c0Receipts];
      if (families.every((rows) => rows.length === 0))
        return Object.freeze({ status: "not-found" });
      if (families.some((rows) => rows.length !== 1)) fail("unavailable");
      const challengeRef = originals[0]?.challenge_ref,
        raw = originals[0]?.command_json;
      if (
        typeof challengeRef !== "string" ||
        typeof raw !== "string" ||
        receipts[0]?.command_json !== raw ||
        families.some((rows) => rows[0]?.challenge_ref !== challengeRef)
      )
        fail("unavailable");
      // Validate the real stored full command, never a dummy/current selection.
      let parsed: Parsed;
      try {
        parsed = await parseCaptured(JSON.parse(raw) as FinancialR1WriteCommand, c);
      } catch (error) {
        return fail("unavailable", error);
      }
      if (parsed.commandJson !== raw) fail("unavailable");
      const retained = await readJoinedRetainedR1Data(challengeRef);
      if (retained.status !== "found" || !same(retained.original, parsed.command.original))
        fail("unavailable");
      if (
        !same(expected.action, retained.actionIdentity.action) ||
        expected.requestFingerprint !== retained.actionIdentity.requestFingerprint
      )
        fail("conflict");
      return retained;
    } catch (error) {
      if (error instanceof FinancialRetainedR1Error) throw error;
      return fail("unavailable", error);
    }
  }
  /** Displayed-terms/canonical DATA producers exist, but the registered genuine issuer and
   * current admission are unwired; caller DTOs cannot qualify prepare. */
  async function prepare(_command: FinancialR1WriteCommand): Promise<never> {
    return fail("unavailable");
  }
  /** RP-facing entry is unavailable until the actual producer and registration origin are wired. */
  async function readRetainedActionConsentR1(_challengeRef: string): Promise<never> {
    ref(_challengeRef);
    return fail("unavailable");
  }
  return Object.freeze({
    prepare,
    readRetainedR1Original,
    readJoinedRetainedR1Data,
    readBusinessRetainedR1Data,
    readRetainedActionConsentR1,
  });
}
