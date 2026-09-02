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
 * Codes the released provider retries on its own. `retryable` is derived from
 * this list rather than passed in, so two call sites cannot disagree about
 * whether one code means "try again".
 */
export const AUTOMATICALLY_RETRYABLE_ERROR_CODES: readonly string[] = [
  "resource_busy",
  "backend_unavailable",
  "rate_limited",
  "deadline_exceeded",
];

/**
 * The closed code/status pairs the released provider's `parseAPIError` accepts.
 *
 * A code outside this table, or one at a status the table does not name, is
 * read by the provider as an opaque rejection rather than a classification.
 * That is a safe answer — the provider fails the operation instead of acting on
 * a code it does not understand — but it is never the answer a route wants when
 * the caller is supposed to act on the classification. Keep this table equal to
 * `internal/clientv3/errors.go`'s `stableErrorHTTPStatusByCode`.
 */
export const STABLE_ERROR_HTTP_STATUS: Readonly<Record<string, number>> = Object.freeze({
  invalid_argument: 400,
  unauthenticated: 401,
  permission_denied: 403,
  form_unknown: 404,
  form_not_installed: 409,
  form_unavailable: 503,
  resource_not_found: 404,
  resource_busy: 409,
  import_conflict: 409,
  policy_denied: 403,
  backend_unavailable: 503,
  internal_error: 500,
  rate_limited: 429,
  deadline_exceeded: 504,
  operation_cancelled: 409,
  operation_not_found: 404,
  dependency_in_use: 409,
  artifact_missing: 404,
  artifact_invalid: 400,
  unsupported_capability: 422,
  migration_required: 409,
  uid_mismatch: 409,
  revision_conflict: 412,
  generation_conflict: 412,
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

/** The envelope as an HTTP response. Both lanes render errors through this. */
export function errorEnvelopeResponse(
  code: string,
  status: number,
  details?: unknown,
  init?: ResponseInit,
  message?: string,
  hostCode?: string,
): Response {
  return Response.json(errorEnvelope(code, details, undefined, message, hostCode), {
    ...init,
    status,
  });
}
