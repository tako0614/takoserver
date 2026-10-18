/**
 * The existing confirmation form's one-read POST syntax. This is submission DATA:
 * the expected transaction/challenge/fingerprint are not a qualified Financial
 * R1 selection, displayed original, RP issuer or consent permission.
 */
import { base64UrlDecode, canonicalDigest, canonicalJson } from "./json.ts";

const PREPARED_VIEW_VERSION = "rp-financial-consent-prepared-view-v1";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** Pure RP DATA renderer. This commits to the HTML bytes; it does not prove
 * delivery, display, an affirmative POST or a current financial permission. */
export async function renderSharedAuthFinancialPreparedConsentView(
  input: Readonly<{
    transactionRef: string;
    action: unknown;
    termsOriginalUtf8Base64url: string;
  }>,
): Promise<Readonly<{ html: string; disclosureRef: string }>> {
  if (!/^rpfc_[A-Za-z0-9_-]{43}$/u.test(input.transactionRef)) return invalid();
  const termsBytes = base64UrlDecode(input.termsOriginalUtf8Base64url);
  if (!termsBytes || termsBytes.byteLength < 1 || termsBytes.byteLength > 16_384) return invalid();
  let terms: string;
  try {
    terms = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(termsBytes);
  } catch {
    return invalid();
  }
  if (!terms || terms.length > 8_192) return invalid();
  const action = canonicalJson(input.action);
  if (typeof action !== "string" || !action || new TextEncoder().encode(action).byteLength > 16_384)
    return invalid();
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Confirm financial action</title><main><h1>Confirm financial action</h1><h2>Action</h2><pre>${escapeHtml(action)}</pre><h2>Terms</h2><pre>${escapeHtml(terms)}</pre><form method="post"><input type="hidden" name="confirmation_transaction" value="${input.transactionRef}"><button type="submit" name="approve" value="yes">Approve</button></form></main></html>`;
  const disclosureRef = await canonicalDigest([PREPARED_VIEW_VERSION, html]);
  return Object.freeze({ html, disclosureRef });
}

export interface SharedAuthFinancialConfirmationSelectionData {
  readonly transactionRef: string;
  readonly challengeRef: string;
  readonly requestFingerprint: string;
}

export interface SharedAuthFinancialConfirmationSubmissionData {
  readonly state: "confirmation-submission-data";
  readonly transactionRef: string;
  readonly challengeRef: string;
  readonly requestFingerprint: string;
}

export class SharedAuthFinancialConfirmationSubmissionError extends Error {
  readonly code = "invalid_request" as const;
  constructor() {
    super("invalid_shared_auth_financial_confirmation_submission");
    this.name = "SharedAuthFinancialConfirmationSubmissionError";
  }
}

function invalid(): never {
  throw new SharedAuthFinancialConfirmationSubmissionError();
}

function selection(value: unknown): SharedAuthFinancialConfirmationSelectionData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  let keys: PropertyKey[];
  let prototype: unknown;
  let fields: PropertyDescriptorMap;
  try {
    keys = Reflect.ownKeys(value);
    prototype = Object.getPrototypeOf(value);
    fields = Object.getOwnPropertyDescriptors(value);
  } catch {
    return invalid();
  }
  const names = ["transactionRef", "challengeRef", "requestFingerprint"] as const;
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== names.length ||
    keys.some((key) => typeof key !== "string" || !names.includes(key as (typeof names)[number]))
  )
    return invalid();
  const read = (name: (typeof names)[number]) => {
    const descriptor = fields[name];
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true ||
      typeof descriptor.value !== "string"
    )
      return invalid();
    return descriptor.value as string;
  };
  const transactionRef = read("transactionRef");
  const challengeRef = read("challengeRef");
  const requestFingerprint = read("requestFingerprint");
  if (
    !/^rpfc_[A-Za-z0-9_-]{43}$/u.test(transactionRef) ||
    challengeRef.length === 0 ||
    challengeRef.length > 255 ||
    !/^sha256:[0-9a-f]{64}$/u.test(requestFingerprint)
  )
    return invalid();
  return Object.freeze({ transactionRef, challengeRef, requestFingerprint });
}

const maxBodyBytes = 8_192;

async function readOneBody(request: Request): Promise<Uint8Array> {
  if (request.bodyUsed || !request.body || request.signal.aborted) return invalid();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (request.signal.aborted) return invalid();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) return invalid();
      size += result.value.byteLength;
      if (size > maxBodyBytes) return invalid();
      parts.push(result.value);
    }
  } catch {
    return invalid();
  } finally {
    reader.releaseLock();
  }
  if (size === 0) return invalid();
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return body;
}

/** Consumes the original Request body once; never clones it or mints consent. */
export async function parseSharedAuthFinancialConfirmationSubmissionCandidate(
  request: Request,
  originalSelection: unknown,
): Promise<SharedAuthFinancialConfirmationSubmissionData> {
  const selected = selection(originalSelection);
  if (
    !(request instanceof Request) ||
    request.method !== "POST" ||
    request.headers.get("content-type") !== "application/x-www-form-urlencoded" ||
    request.signal.aborted
  )
    return invalid();
  const body = await readOneBody(request);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    return invalid();
  }
  const params = new URLSearchParams(text);
  if (
    [...params.keys()].length !== 2 ||
    params.getAll("approve").length !== 1 ||
    params.getAll("confirmation_transaction").length !== 1 ||
    params.get("approve") !== "yes" ||
    params.get("confirmation_transaction") !== selected.transactionRef
  )
    return invalid();
  return Object.freeze({
    state: "confirmation-submission-data",
    transactionRef: selected.transactionRef,
    challengeRef: selected.challengeRef,
    requestFingerprint: selected.requestFingerprint,
  });
}
