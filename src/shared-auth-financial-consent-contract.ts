import { canonicalDigest, canonicalJson, isSha256Digest } from "./json.ts";
import {
  createSharedFinancialActionIdentity,
  parseSharedFinancialAction,
  SHARED_FINANCIAL_ACTION_VERSION,
  type SharedFinancialAction,
} from "./shared-financial-action.ts";
import {
  type FinancialIdentityChallenge,
  type FinancialSourceDigest,
  financialSourceDigest,
  financialSourceRef,
  parseFinancialIdentityChallenge,
} from "./shared-financial-source-contract.ts";
import { parseStrictJson } from "./strict-json.ts";

const CONSENT_ORIGINAL_VERSION = "takoserver-shared-financial-action-consent-v1" as const;
const CONSENT_CAPTURE_KEY_VERSION =
  "takoserver-shared-financial-action-consent-capture-v2" as const;
const MAX_ORIGINAL_BYTES = 65_536;
const MAX_OPAQUE_TEXT_BYTES = 4_096;
const MAX_PARENT_PINS = 64;

interface ConsentIssuerOriginal {
  readonly registrationRef: string;
  readonly registrationDigest: string;
  readonly incarnation: string;
}
interface FinancialActionSourceOriginal {
  readonly ref: string;
  readonly digest: FinancialSourceDigest;
  readonly registrationRef: string;
  readonly incarnation: string;
}
interface ConsentIdentityParentPin {
  readonly registrationRef: string;
  readonly incarnation: string;
  readonly affectedRef: string;
  readonly eventRef: string;
  readonly eventDigest: FinancialSourceDigest;
}
type ConsentIdentityEvidence =
  | { readonly kind: "not-required" }
  | {
      readonly kind: "financial-proof";
      readonly proofRef: string;
      readonly registrationRef: string;
      readonly identityGeneration: number;
      readonly sourceParentPins: readonly ConsentIdentityParentPin[];
    };
interface ConsentOriginalCore {
  readonly version: typeof CONSENT_ORIGINAL_VERSION;
  readonly consentRef: string;
  readonly actionVersion: typeof SHARED_FINANCIAL_ACTION_VERSION;
  readonly action: SharedFinancialAction;
  readonly actionRequestFingerprint: FinancialSourceDigest;
  readonly challenge: FinancialIdentityChallenge;
  readonly selectedTerms: { readonly ref: string; readonly digest: FinancialSourceDigest };
  readonly path: {
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly workspaceRef: string;
  };
  readonly financialRealmRef: string;
  readonly source: FinancialActionSourceOriginal;
  readonly consentIssuer: ConsentIssuerOriginal;
  readonly identityEvidence: ConsentIdentityEvidence;
  readonly rpSession: {
    readonly sessionDigest: string;
    readonly acceptedVersion: number;
    readonly accountId: string;
    readonly observedPrincipalId: string;
    readonly identity: ExactOidcIdentity;
  };
  readonly principalBinding: {
    readonly ref: string;
    readonly digest: string;
    readonly incarnation: string;
  };
  readonly credentialClass: {
    readonly ref: string;
    readonly digest: string;
    readonly incarnation: string;
  };
  readonly acceptedAt: number;
  readonly expiresAt: number;
}
interface ConsentOriginal extends ConsentOriginalCore {
  readonly consentDigest: FinancialSourceDigest;
}
interface ConsentOriginalIdentity {
  readonly original: ConsentOriginal;
  readonly consentDigest: FinancialSourceDigest;
  readonly canonicalOriginalJson: string;
}
interface ExactOidcIdentity {
  readonly issuer: string;
  readonly clientId: string;
  readonly subject: string;
  readonly sessionId: string;
  readonly authTime: number;
}

function invalid(): never {
  throw new TypeError("invalid shared financial action consent original");
}

function descriptors(value: object): Record<string, PropertyDescriptor> {
  try {
    return Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  } catch {
    return invalid();
  }
}

function record(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  let prototype: unknown;
  let keys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return invalid();
  }
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  if (
    keys.length !== names.length ||
    keys.some((key) => typeof key !== "string" || !names.includes(key))
  )
    return invalid();
  const own = descriptors(value);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    const descriptor = own[name];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true)
      return invalid();
    output[name] = descriptor.value;
  }
  return output;
}

function arrayItems(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  let prototype: unknown;
  let keys: PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return invalid();
  }
  if (prototype !== Array.prototype || keys.length !== value.length + 1 || !keys.includes("length"))
    return invalid();
  const own = descriptors(value);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = own[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true)
      return invalid();
    result.push(descriptor.value);
  }
  return result;
}

function opaqueText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return invalid();
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  if (encoded.byteLength > MAX_OPAQUE_TEXT_BYTES) return invalid();
  try {
    parseStrictJson(encoded, encoded.byteLength);
  } catch {
    return invalid();
  }
  // Opaque means exact value preservation: no trim, Unicode normalization,
  // format guess, or digest/ref re-encoding is performed here.
  return value;
}

function oidcIdentityText(value: unknown): string {
  const text = opaqueText(value);
  if (
    text.length > 512 ||
    [...text].some(
      (character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f,
    )
  )
    return invalid();
  return text;
}

function exactOidcIdentity(value: unknown): ExactOidcIdentity {
  const item = record(value, ["issuer", "clientId", "subject", "sessionId", "authTime"]);
  if (
    typeof item.authTime !== "number" ||
    !Number.isSafeInteger(item.authTime) ||
    item.authTime < 0
  )
    return invalid();
  return Object.freeze({
    issuer: oidcIdentityText(item.issuer),
    clientId: oidcIdentityText(item.clientId),
    subject: oidcIdentityText(item.subject),
    sessionId: oidcIdentityText(item.sessionId),
    authTime: item.authTime,
  });
}

function opaqueTriple(value: unknown): {
  readonly ref: string;
  readonly digest: string;
  readonly incarnation: string;
} {
  const item = record(value, ["ref", "digest", "incarnation"]);
  return Object.freeze({
    ref: opaqueText(item.ref),
    digest: opaqueText(item.digest),
    incarnation: opaqueText(item.incarnation),
  });
}

function issuer(value: unknown): ConsentIssuerOriginal {
  const item = record(value, ["registrationRef", "registrationDigest", "incarnation"]);
  return Object.freeze({
    registrationRef: opaqueText(item.registrationRef),
    registrationDigest: opaqueText(item.registrationDigest),
    incarnation: opaqueText(item.incarnation),
  });
}

function actionSource(value: unknown): FinancialActionSourceOriginal {
  const item = record(value, ["ref", "digest", "registrationRef", "incarnation"]);
  if (
    !financialSourceRef(item.ref) ||
    !financialSourceDigest(item.digest) ||
    !financialSourceRef(item.registrationRef) ||
    !financialSourceRef(item.incarnation)
  )
    return invalid();
  return Object.freeze({
    ref: item.ref,
    digest: item.digest,
    registrationRef: item.registrationRef,
    incarnation: item.incarnation,
  });
}

function identityEvidence(
  value: unknown,
  challenge: FinancialIdentityChallenge,
): ConsentIdentityEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  let kind: unknown;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true)
      return invalid();
    kind = descriptor.value;
  } catch {
    return invalid();
  }
  if (kind === "not-required") {
    const item = record(value, ["kind"]);
    return Object.freeze({ kind: item.kind as "not-required" });
  }
  if (kind !== "financial-proof") return invalid();
  const item = record(value, [
    "kind",
    "proofRef",
    "registrationRef",
    "identityGeneration",
    "sourceParentPins",
  ]);
  if (
    typeof item.identityGeneration !== "number" ||
    !Number.isSafeInteger(item.identityGeneration) ||
    item.identityGeneration < 0
  )
    return invalid();
  const registrationRef = opaqueText(item.registrationRef);
  if (registrationRef !== challenge.registrationRef) return invalid();
  const sourceParentPins = arrayItems(item.sourceParentPins, MAX_PARENT_PINS).map((entry) => {
    const pin = record(entry, [
      "registrationRef",
      "incarnation",
      "affectedRef",
      "eventRef",
      "eventDigest",
    ]);
    if (!financialSourceDigest(pin.eventDigest)) return invalid();
    return Object.freeze({
      registrationRef: opaqueText(pin.registrationRef),
      incarnation: opaqueText(pin.incarnation),
      affectedRef: opaqueText(pin.affectedRef),
      eventRef: opaqueText(pin.eventRef),
      eventDigest: pin.eventDigest,
    });
  });
  return Object.freeze({
    kind: "financial-proof",
    proofRef: opaqueText(item.proofRef),
    registrationRef,
    identityGeneration: item.identityGeneration,
    sourceParentPins: Object.freeze(sourceParentPins),
  });
}

function time(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}

function parseCore(value: unknown): ConsentOriginalCore {
  const item = record(value, [
    "version",
    "consentRef",
    "actionVersion",
    "action",
    "actionRequestFingerprint",
    "challenge",
    "selectedTerms",
    "path",
    "financialRealmRef",
    "source",
    "consentIssuer",
    "identityEvidence",
    "rpSession",
    "principalBinding",
    "credentialClass",
    "acceptedAt",
    "expiresAt",
  ]);
  if (
    item.version !== CONSENT_ORIGINAL_VERSION ||
    item.actionVersion !== SHARED_FINANCIAL_ACTION_VERSION
  )
    return invalid();

  const action = parseSharedFinancialAction(item.action);
  const challengeSnapshot = record(item.challenge, [
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
  const challenge = Object.freeze(parseFinancialIdentityChallenge(challengeSnapshot));
  if (
    !financialSourceDigest(item.actionRequestFingerprint) ||
    item.actionRequestFingerprint !== challenge.requestFingerprint
  )
    return invalid();

  const termsInput = record(item.selectedTerms, ["ref", "digest"]);
  if (!financialSourceRef(termsInput.ref) || !financialSourceDigest(termsInput.digest))
    return invalid();
  const pathInput = record(item.path, ["organizationId", "workspaceId", "workspaceRef"]);
  if (
    !financialSourceRef(pathInput.organizationId) ||
    !financialSourceRef(pathInput.workspaceId) ||
    !financialSourceRef(pathInput.workspaceRef) ||
    action.organizationId !== challenge.organizationId ||
    pathInput.organizationId !== challenge.organizationId ||
    pathInput.workspaceId !== challenge.workspaceId ||
    pathInput.workspaceRef !== challenge.workspaceRef
  )
    return invalid();

  const source = actionSource(item.source);
  const consentIssuer = issuer(item.consentIssuer);
  const evidence = identityEvidence(item.identityEvidence, challenge);
  const sessionInput = record(item.rpSession, [
    "sessionDigest",
    "acceptedVersion",
    "accountId",
    "observedPrincipalId",
    "identity",
  ]);
  if (
    typeof sessionInput.acceptedVersion !== "number" ||
    !Number.isSafeInteger(sessionInput.acceptedVersion) ||
    sessionInput.acceptedVersion < 0
  )
    return invalid();
  const principalBinding = opaqueTriple(item.principalBinding);
  const credentialClass = opaqueTriple(item.credentialClass);
  const acceptedAt = time(item.acceptedAt);
  const expiresAt = time(item.expiresAt);
  if (
    acceptedAt < challenge.createdAt ||
    acceptedAt >= expiresAt ||
    expiresAt > challenge.expiresAt
  )
    return invalid();

  return Object.freeze({
    version: CONSENT_ORIGINAL_VERSION,
    consentRef: opaqueText(item.consentRef),
    actionVersion: SHARED_FINANCIAL_ACTION_VERSION,
    action,
    actionRequestFingerprint: item.actionRequestFingerprint,
    challenge,
    selectedTerms: Object.freeze({ ref: termsInput.ref, digest: termsInput.digest }),
    path: Object.freeze({
      organizationId: pathInput.organizationId,
      workspaceId: pathInput.workspaceId,
      workspaceRef: pathInput.workspaceRef,
    }),
    financialRealmRef: opaqueText(item.financialRealmRef),
    source,
    consentIssuer,
    identityEvidence: evidence,
    rpSession: Object.freeze({
      sessionDigest: opaqueText(sessionInput.sessionDigest),
      acceptedVersion: sessionInput.acceptedVersion,
      accountId: opaqueText(sessionInput.accountId),
      observedPrincipalId: opaqueText(sessionInput.observedPrincipalId),
      identity: exactOidcIdentity(sessionInput.identity),
    }),
    principalBinding,
    credentialClass,
    acceptedAt,
    expiresAt,
  });
}

function parseFullObject(value: unknown): ConsentOriginal {
  const item = record(value, [
    "version",
    "consentRef",
    "actionVersion",
    "action",
    "actionRequestFingerprint",
    "challenge",
    "selectedTerms",
    "path",
    "financialRealmRef",
    "source",
    "consentIssuer",
    "identityEvidence",
    "rpSession",
    "principalBinding",
    "credentialClass",
    "acceptedAt",
    "expiresAt",
    "consentDigest",
  ]);
  const core = parseCore({
    version: item.version,
    consentRef: item.consentRef,
    actionVersion: item.actionVersion,
    action: item.action,
    actionRequestFingerprint: item.actionRequestFingerprint,
    challenge: item.challenge,
    selectedTerms: item.selectedTerms,
    path: item.path,
    financialRealmRef: item.financialRealmRef,
    source: item.source,
    consentIssuer: item.consentIssuer,
    identityEvidence: item.identityEvidence,
    rpSession: item.rpSession,
    principalBinding: item.principalBinding,
    credentialClass: item.credentialClass,
    acceptedAt: item.acceptedAt,
    expiresAt: item.expiresAt,
  });
  if (!financialSourceDigest(item.consentDigest)) return invalid();
  return Object.freeze({ ...core, consentDigest: item.consentDigest });
}

function parseFullInputSync(input: unknown): { readonly original: ConsentOriginal } {
  if (input instanceof Uint8Array) {
    if (Object.getPrototypeOf(input) !== Uint8Array.prototype) return invalid();
    const inputBytes = new Uint8Array(input);
    if (inputBytes.byteLength > MAX_ORIGINAL_BYTES) return invalid();
    let decoded: unknown;
    try {
      decoded = parseStrictJson(inputBytes, MAX_ORIGINAL_BYTES);
    } catch {
      return invalid();
    }
    const original = parseFullObject(decoded);
    const canonical = new TextEncoder().encode(canonicalJson(original));
    if (!equalBytes(inputBytes, canonical)) return invalid();
    return Object.freeze({ original });
  }
  const original = parseFullObject(input);
  if (new TextEncoder().encode(canonicalJson(original)).byteLength > MAX_ORIGINAL_BYTES)
    return invalid();
  return Object.freeze({ original });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function coreOf(original: ConsentOriginal): ConsentOriginalCore {
  return parseCore({
    version: original.version,
    consentRef: original.consentRef,
    actionVersion: original.actionVersion,
    action: original.action,
    actionRequestFingerprint: original.actionRequestFingerprint,
    challenge: original.challenge,
    selectedTerms: original.selectedTerms,
    path: original.path,
    financialRealmRef: original.financialRealmRef,
    source: original.source,
    consentIssuer: original.consentIssuer,
    identityEvidence: original.identityEvidence,
    rpSession: original.rpSession,
    principalBinding: original.principalBinding,
    credentialClass: original.credentialClass,
    acceptedAt: original.acceptedAt,
    expiresAt: original.expiresAt,
  });
}

async function verifyOriginal(original: ConsentOriginal): Promise<ConsentOriginalCore> {
  // All input detachment/cross-field checks happen before this first await.
  const core = coreOf(original);
  const actionIdentityPromise = createSharedFinancialActionIdentity(core.action);
  const consentDigestPromise = canonicalDigest([CONSENT_ORIGINAL_VERSION, core]);
  const [actionIdentity, consentDigest] = await Promise.all([
    actionIdentityPromise,
    consentDigestPromise,
  ]);
  if (
    actionIdentity.requestFingerprint !== core.actionRequestFingerprint ||
    actionIdentity.requestFingerprint !== core.challenge.requestFingerprint ||
    consentDigest !== original.consentDigest
  )
    return invalid();
  return core;
}

/** Parse and verify a full canonical original; this is data validation, not source/current qualification. */
export async function parseSharedAuthFinancialActionConsentOriginal(
  input: unknown,
): Promise<ConsentOriginal> {
  const parsed = parseFullInputSync(input);
  await verifyOriginal(parsed.original);
  return parsed.original;
}

/** Create an exact original and its separate consent-domain lowerhex identity from detached data only. */
export async function createSharedAuthFinancialActionConsentOriginalIdentity(
  input: unknown,
): Promise<ConsentOriginalIdentity> {
  const core = parseCore(input);
  // Bound the final full row before hashing. The fixed-width placeholder keeps
  // this synchronous size check exact without waiting for the consent digest.
  const placeholder = Object.freeze({ ...core, consentDigest: `sha256:${"0".repeat(64)}` });
  if (new TextEncoder().encode(canonicalJson(placeholder)).byteLength > MAX_ORIGINAL_BYTES)
    return invalid();
  // Capture action and consent preimages before the first await. Caller mutation
  // after this call cannot alter the action identity, digest, or serialized row.
  const actionIdentityPromise = createSharedFinancialActionIdentity(core.action);
  const consentDigestPromise = canonicalDigest([CONSENT_ORIGINAL_VERSION, core]);
  const [actionIdentity, consentDigest] = await Promise.all([
    actionIdentityPromise,
    consentDigestPromise,
  ]);
  if (
    actionIdentity.requestFingerprint !== core.actionRequestFingerprint ||
    actionIdentity.requestFingerprint !== core.challenge.requestFingerprint ||
    !isSha256Digest(consentDigest)
  )
    return invalid();
  const original: ConsentOriginal = Object.freeze({ ...core, consentDigest });
  const canonicalOriginalJson = canonicalJson(original);
  if (new TextEncoder().encode(canonicalOriginalJson).byteLength > MAX_ORIGINAL_BYTES)
    return invalid();
  return Object.freeze({ original, consentDigest, canonicalOriginalJson });
}

/** Stable data key from the persisted challenge/action original; never current Principal/session/time. */
export async function createSharedAuthFinancialActionConsentCaptureKeyData(
  input: unknown,
): Promise<FinancialSourceDigest> {
  const fields = record(input, [
    "challengeRef",
    "actionKind",
    "actionReference",
    "actionRequestFingerprint",
  ]);
  const challengeRef = fields.challengeRef;
  const actionKind = fields.actionKind;
  const actionReference = fields.actionReference;
  const actionRequestFingerprint = fields.actionRequestFingerprint;
  if (
    !financialSourceRef(challengeRef) ||
    !["topup", "subscription-start", "card-setup", "plan-change", "cancel"].includes(
      String(actionKind),
    ) ||
    !financialSourceRef(actionReference) ||
    !financialSourceDigest(actionRequestFingerprint)
  )
    return invalid();
  const key = await canonicalDigest([
    CONSENT_CAPTURE_KEY_VERSION,
    challengeRef,
    actionKind,
    actionReference,
    actionRequestFingerprint,
  ]);
  return isSha256Digest(key) ? key : invalid();
}

/** Pure key DATA shared with the internal rpfc address; it is not consent. */
export async function createSharedAuthFinancialActionConsentCaptureKey(
  input: unknown,
): Promise<FinancialSourceDigest> {
  const { original } = parseFullInputSync(input);
  const core = coreOf(original);
  // Snapshot the exact saved tuple before any crypto await.
  const challengeRef = core.challenge.challengeRef;
  const actionKind = core.action.kind;
  const actionReference = core.action.reference;
  const actionRequestFingerprint = core.actionRequestFingerprint;
  const actionIdentityPromise = createSharedFinancialActionIdentity(core.action);
  const consentDigestPromise = canonicalDigest([CONSENT_ORIGINAL_VERSION, core]);
  const [actionIdentity, consentDigest] = await Promise.all([
    actionIdentityPromise,
    consentDigestPromise,
  ]);
  if (
    actionIdentity.requestFingerprint !== actionRequestFingerprint ||
    actionIdentity.requestFingerprint !== core.challenge.requestFingerprint ||
    consentDigest !== original.consentDigest
  )
    return invalid();
  return createSharedAuthFinancialActionConsentCaptureKeyData({
    challengeRef,
    actionKind,
    actionReference,
    actionRequestFingerprint,
  });
}
