/**
 * The one wire error envelope every lane of this Host answers with.
 *
 * There used to be two. The stable Takoform Host lane rendered
 * `{code, message, requestId, retryable}`, while the `/v1/*` control lane
 * rendered `{code, message}` — and the released Takoform provider decodes an
 * envelope only when all four members are present, treating anything else as
 * protocol-invalid with an empty code. That is not cosmetic: the private
 * runtime-input route answers `operation_not_found` 404 to say "no handoff
 * exists yet, send one", and the provider reads that classification through the
 * envelope. A two-member 404 made the answer unreadable, so the whole sealed
 * runtime-input path was unreachable from the released provider (E2E defect 1).
 *
 * `requestId` is always fresh. The message is derived from the code unless the
 * Host supplies one it has already sanitized — a provider refusal naming the
 * cause, bounded and stripped by `sanitizedMessage` — so no caller-supplied
 * value and no raw internal text escapes through an error.
 */

/**
 * The closed portable taxonomy, and the codes the released provider retries on
 * its own.
 *
 * Both tables are generated from Takoform's frozen `spec/host-api/operations-v1.json`,
 * vendored under `vendor/takoform/host-api-v1/` and pinned by size and SHA-256
 * to an exact tag and commit. They used to be literals here under a sentence
 * asking a reader to keep them equal to a Go map in another repository. A
 * sentence is not a mechanism: nothing read both, so a Host that drifted would
 * answer a well-formed envelope the provider reads as an opaque rejection
 * instead of the classification the route meant. `retryable` is still derived
 * from the list rather than passed in, so two call sites cannot disagree about
 * whether one code means "try again".
 */
import {
  AUTOMATICALLY_RETRYABLE_ERROR_CODES,
  STABLE_ERROR_HTTP_STATUS,
} from "./generated/takoform-stable-error-taxonomy.ts";

export { AUTOMATICALLY_RETRYABLE_ERROR_CODES, STABLE_ERROR_HTTP_STATUS };

/**
 * The refusals this Host answers that the portable taxonomy does not name.
 *
 * These are not drift. The `/v1/*` control lane, the private runtime-input
 * route and the sponsorship seam are this Host's own surfaces, and a Host code
 * is exactly what the portable taxonomy leaves room for — the released provider
 * reads one as an opaque rejection, which is the correct answer for a refusal
 * it was never meant to act on. Declaring them is what makes the *undeclared*
 * pair below a refusal instead of a shrug.
 *
 * A code may appear at more than one status when two lanes answer it: a
 * reseller lane's `offering_unavailable` is a 503 about capacity, the Host
 * lane's is a 409 about the offering named in an apply.
 */
export const HOST_ERROR_HTTP_STATUS: Readonly<Record<string, readonly number[]>> = Object.freeze({
  apply_commitment_mismatch: [409],
  artifact_committed: [409],
  conflict: [409],
  delete_failed: [409],
  expired: [409],
  insufficient_funds: [402],
  invalid: [400],
  migration_commercial_authority_invalid: [409],
  migration_conflict: [409],
  not_found: [404],
  offering_changed: [409],
  offering_mismatch: [409],
  offering_unavailable: [409, 503],
  operation_not_cancellable: [409],
  organization_not_found: [404],
  space_mismatch: [409],
  tenant_conflict: [409],
  tenant_not_found: [404],
  token_replayed: [409],
  unavailable: [503],
});

/**
 * Portable codes this Host still answers at a status the taxonomy does not name.
 *
 * Each of these is a live defect, not an exemption: the released provider finds
 * the code in its table, finds the status disagrees, and reports an opaque
 * rejection — so a caller that was supposed to act on the classification gets
 * noise instead. They are listed rather than fixed here because both live in
 * the resource-lifecycle surface that is being consolidated; the consolidation
 * removes them.
 *
 * The list asserts they are *still* wrong. `tests/error-taxonomy.test.ts`
 * fails when one stops being emitted, so closing a divergence forces the entry
 * out rather than leaving a permanent excuse behind.
 */
export const PORTABLE_STATUS_DIVERGENCES: Readonly<Record<string, readonly number[]>> =
  Object.freeze({
    // src/takoform/routes.ts answers 404 for a wrong method on a known path.
    invalid_argument: [404],
    // src/takoform/artifacts.ts answers 409 for an upload that is not open.
    artifact_invalid: [409],
  });

export interface WireErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly retryable: boolean;
    /**
     * The Host's own finer name for this refusal, when the closed portable
     * taxonomy cannot carry the distinction.
     *
     * This is not an extension this Host invented. The released provider's
     * envelope and terminal-operation decoders both name `hostCode`, and both
     * decode with `DisallowUnknownFields` — so it is the only member a Host may
     * add, and anything else would make the whole envelope protocol-invalid.
     * `takoform`'s `host-api-wire-v1` and `operation-v1` schemas declare it as
     * a free-form non-empty string, which is exactly what a Host-specific
     * refinement of a portable code is.
     */
    readonly hostCode?: string;
    readonly details?: unknown;
  };
}

/** Whether an envelope this Host emits is one the released provider decodes. */
export function isStableErrorEnvelope(code: string, status: number, retryable: boolean): boolean {
  if (STABLE_ERROR_HTTP_STATUS[code] !== status) return false;
  return retryable ? AUTOMATICALLY_RETRYABLE_ERROR_CODES.includes(code) : true;
}

/** How a refusal this Host answers relates to the closed portable taxonomy. */
export type RefusalClassification =
  /** The portable code, at the one status the frozen taxonomy names for it. */
  | "portable"
  /** This Host's own code, outside the portable taxonomy and declared as such. */
  | "host"
  /** A portable code at a status the taxonomy does not name — a declared defect. */
  | "declared-divergence"
  /** Nothing says what this pair means. */
  | "unclassified";

/** Where one code/status pair sits against the taxonomy this Host answers by. */
export function classifyRefusal(code: string, status: number): RefusalClassification {
  if (isStableErrorEnvelope(code, status, false)) return "portable";
  if (PORTABLE_STATUS_DIVERGENCES[code]?.includes(status) === true) {
    return "declared-divergence";
  }
  if (HOST_ERROR_HTTP_STATUS[code]?.includes(status) === true) return "host";
  return "unclassified";
}

/**
 * The complete envelope body for one failure.
 *
 * `requestId` is minted here rather than accepted, so a caller can never choose
 * the identity its failure is recorded under. `details` is carried only where a
 * lane already publishes it and is never derived from a secret value.
 */
export function errorEnvelope(
  code: string,
  details?: unknown,
  requestId = `req_${crypto.randomUUID()}`,
  message?: string,
  hostCode?: string,
): WireErrorEnvelope {
  return {
    error: {
      code,
      message: sanitizedMessage(message) ?? code.replaceAll("_", " "),
      requestId,
      retryable: AUTOMATICALLY_RETRYABLE_ERROR_CODES.includes(code),
      ...(hostCode === undefined ? {} : { hostCode }),
      ...(details === undefined ? {} : { details }),
    },
  };
}

/** How much of a diagnosis one failure may carry. */
export const MAXIMUM_ERROR_MESSAGE_LENGTH = 400;

/**
 * The one gate a non-derived message passes through.
 *
 * A message that reaches here has already been declared safe for a customer to
 * read by whoever produced it, so this is not redaction — it is the bound that
 * keeps a refusal a sentence rather than a stranger's stack trace, and it
 * flattens every control character so nothing can forge a second line, a JSON
 * break, or a terminal escape inside an error envelope.
 */
export function sanitizedMessage(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let text = "";
  for (const character of value.slice(0, MAXIMUM_ERROR_MESSAGE_LENGTH * 2)) {
    const code = character.codePointAt(0) ?? 0;
    text += code < 0x20 || code === 0x7f ? " " : character;
    if (text.length >= MAXIMUM_ERROR_MESSAGE_LENGTH) break;
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Whether an unclassifiable refusal should fail here rather than ship.
 *
 * Outside production this is an authoring-time refusal: a pair no table names
 * is one no caller can act on, and finding that out from a customer is finding
 * it out too late. In production the guard is off — an error path is the last
 * place to introduce a new way to fail — and the static scan in
 * `tests/error-taxonomy.test.ts` is what keeps the tables complete.
 */
const REFUSE_UNCLASSIFIED_ENVELOPES = (() => {
  try {
    // Read through `globalThis` rather than a bare `process`: a Worker has no
    // Node globals, and this module ships inside one.
    const host = globalThis as {
      readonly process?: { readonly env?: Readonly<Record<string, string | undefined>> };
    };
    const environment = host.process?.env?.NODE_ENV;
    return environment !== undefined && environment !== "production";
  } catch {
    return false;
  }
})();

/** The envelope as an HTTP response. Both lanes render errors through this. */
export function errorEnvelopeResponse(
  code: string,
  status: number,
  details?: unknown,
  init?: ResponseInit,
  message?: string,
  hostCode?: string,
): Response {
  if (REFUSE_UNCLASSIFIED_ENVELOPES && classifyRefusal(code, status) === "unclassified") {
    throw new Error(
      `unclassified refusal ${code} ${status}: name it in STABLE_ERROR_HTTP_STATUS ` +
        "(portable), HOST_ERROR_HTTP_STATUS (this Host's own), or fix the status",
    );
  }
  return Response.json(errorEnvelope(code, details, undefined, message, hostCode), {
    ...init,
    status,
  });
}
