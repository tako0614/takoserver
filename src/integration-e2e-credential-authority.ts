import type { ApiKeyAdministration, ApiKeyAdministrationStatus, ApiKeyScope } from "./auth.ts";
import { base64UrlDecode, canonicalDigest, isSha256Digest } from "./json.ts";
import { createOperatorPurposeVerifier } from "./operator-credentials.ts";
import type { Clock } from "./ports.ts";
import { parseStrictJson, StrictJsonError } from "./strict-json.ts";

export const INTEGRATION_E2E_API_KEY_PURPOSE = "integration-e2e-api-key";
export const INTEGRATION_E2E_API_KEY_NAME = "integration-e2e-api-key";
export const INTEGRATION_E2E_API_KEY_SCOPES = ["resources:write"] as const;
export const INTEGRATION_E2E_ORGANIZATION_ID = "org_takosumi_hosted_staging";
export const INTEGRATION_E2E_API_KEY_DEFAULT_TTL_SECONDS = 900;
export const INTEGRATION_E2E_API_KEY_MAX_TTL_SECONDS = 3_600;
export const INTEGRATION_E2E_API_KEY_PROOF_MAX_TTL_SECONDS = 60;

const MAX_BODY_BYTES = 8 * 1_024;
const MAX_ASSERTION_BYTES = 8 * 1_024;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const WORKER_VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;

export type IntegrationE2eCredentialAuthorityAction = "issue" | "status" | "revoke";

export interface IntegrationE2eCredentialAuthorityIdentity {
  readonly environment: "integration";
  readonly organizationId: string;
  readonly sourceCommit: string;
  readonly artifactDigest: `sha256:${string}`;
  readonly publicWorkerVersionId: string;
}

export interface IntegrationE2eCredentialAuthorityConfig
  extends IntegrationE2eCredentialAuthorityIdentity {
  /** Public half of the dedicated integration-e2e-api-key Ed25519 key. */
  readonly publicJwk: string | { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string };
}

export interface IntegrationE2eCredentialAuthorityRequestBody {
  readonly operationId: string;
  readonly organizationId: string;
  readonly scopes: readonly string[];
  readonly ttlSeconds: number;
}

export type IntegrationE2eCredentialAuthorityRoute = (request: Request) => Promise<Response | null>;

export class IntegrationE2eCredentialAuthorityError extends Error {
  constructor(
    readonly code:
      | "configuration_unavailable"
      | "invalid_request"
      | "invalid_operator_assertion"
      | "operator_policy_mismatch"
      | "organization_unavailable"
      | "key_state_conflict"
      | "request_too_large",
  ) {
    super(code);
    this.name = "IntegrationE2eCredentialAuthorityError";
  }
}

/** Exact public path; no generic operator router exists. */
export function credentialAuthorityPath(
  action: IntegrationE2eCredentialAuthorityAction,
): `/v1/operator/integration-e2e/api-key/${IntegrationE2eCredentialAuthorityAction}` {
  return `/v1/operator/integration-e2e/api-key/${action}`;
}

export function credentialAuthorityRequestBody(
  input: IntegrationE2eCredentialAuthorityRequestBody,
): IntegrationE2eCredentialAuthorityRequestBody {
  return {
    operationId: input.operationId,
    organizationId: input.organizationId,
    scopes: [...input.scopes],
    ttlSeconds: input.ttlSeconds,
  };
}

/** Claims signed by the offline client and re-derived by the Worker. */
export async function credentialAuthorityClaims(input: {
  readonly action: IntegrationE2eCredentialAuthorityAction;
  readonly body: IntegrationE2eCredentialAuthorityRequestBody;
  readonly identity: IntegrationE2eCredentialAuthorityIdentity;
}): Promise<Record<string, unknown>> {
  return {
    purpose: INTEGRATION_E2E_API_KEY_PURPOSE,
    action: input.action,
    method: "POST",
    path: credentialAuthorityPath(input.action),
    bodyDigest: await canonicalDigest(input.body),
    operationId: input.body.operationId,
    environment: input.identity.environment,
    organizationId: input.body.organizationId,
    scopes: [...input.body.scopes],
    ttlSeconds: input.body.ttlSeconds,
    sourceCommit: input.identity.sourceCommit,
    artifactDigest: input.identity.artifactDigest,
    publicWorkerVersionId: input.identity.publicWorkerVersionId,
  };
}

/** Stable address for a one-time secret. The operation id itself is never stored as plaintext. */
export async function deterministicIntegrationE2eApiKeyId(operationId: string): Promise<string> {
  if (!OPERATION_ID.test(operationId)) {
    throw new IntegrationE2eCredentialAuthorityError("invalid_request");
  }
  const digest = await canonicalDigest({ purpose: INTEGRATION_E2E_API_KEY_PURPOSE, operationId });
  return `key_ie2e_${digest.slice("sha256:".length, "sha256:".length + 40)}`;
}

/**
 * `undefined` means the route is intentionally absent. Any supplied but
 * incomplete value is a startup failure, before a storage capability is used.
 */
export function resolveIntegrationE2eCredentialAuthorityConfig(
  input: IntegrationE2eCredentialAuthorityConfig | undefined,
):
  | (IntegrationE2eCredentialAuthorityIdentity & {
      readonly publicJwk: { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string };
    })
  | null {
  if (input === undefined) return null;
  if (
    !isRecord(input) ||
    !exactKeys(input, [
      "artifactDigest",
      "environment",
      "organizationId",
      "publicJwk",
      "publicWorkerVersionId",
      "sourceCommit",
    ])
  ) {
    throw new IntegrationE2eCredentialAuthorityError("configuration_unavailable");
  }
  const publicJwk = parsePublicJwk(input.publicJwk);
  if (
    input.environment !== "integration" ||
    input.organizationId !== INTEGRATION_E2E_ORGANIZATION_ID ||
    !SOURCE_COMMIT.test(input.sourceCommit) ||
    !isSha256Digest(input.artifactDigest) ||
    !WORKER_VERSION.test(input.publicWorkerVersionId)
  ) {
    throw new IntegrationE2eCredentialAuthorityError("configuration_unavailable");
  }
  return {
    environment: "integration",
    organizationId: input.organizationId,
    publicJwk,
    sourceCommit: input.sourceCommit,
    artifactDigest: input.artifactDigest,
    publicWorkerVersionId: input.publicWorkerVersionId,
  };
}

export function createIntegrationE2eCredentialAuthority(input: {
  readonly configuration: IntegrationE2eCredentialAuthorityConfig;
  readonly apiKeys: ApiKeyAdministration;
  readonly clock?: Clock;
}): IntegrationE2eCredentialAuthorityRoute {
  const configuration = resolveIntegrationE2eCredentialAuthorityConfig(input.configuration);
  if (!configuration) {
    throw new IntegrationE2eCredentialAuthorityError("configuration_unavailable");
  }
  const clock = input.clock ?? (() => new Date());
  const verifier = createOperatorPurposeVerifier({
    publicKeyJwk: configuration.publicJwk,
    clock,
    maxLifetimeSeconds: INTEGRATION_E2E_API_KEY_PROOF_MAX_TTL_SECONDS,
  });

  return async (request) => {
    const url = new URL(request.url);
    const action = actionForPath(url.pathname);
    if (!action || request.method !== "POST" || url.search || url.hash) return null;
    try {
      if (request.headers.get("content-type") !== "application/json") {
        return errorResponse(415, "unsupported_media_type");
      }
      const body = parseRequestBody(await boundedBody(request));
      const assertion = bearer(request.headers.get("authorization"));
      await verifyProof({ action, body, assertion, configuration, verifier });
      assertPolicy(body, configuration);

      // The target policy names an existing organization. The authority uses
      // its durable owner principal directly; it never creates a session or a
      // membership to impersonate that owner.
      if (!(await input.apiKeys.organizationOwnerPrincipalId(configuration.organizationId))) {
        return errorResponse(409, "organization_unavailable");
      }
      const apiKeyId = await deterministicIntegrationE2eApiKeyId(body.operationId);
      if (action === "issue") {
        const result = await input.apiKeys.issue({
          organizationId: configuration.organizationId,
          name: INTEGRATION_E2E_API_KEY_NAME,
          scopes: INTEGRATION_E2E_API_KEY_SCOPES,
          expiresInSeconds: body.ttlSeconds,
          apiKeyId,
          exclusiveUnrevokedName: INTEGRATION_E2E_API_KEY_NAME,
        });
        if (result.kind === "existing") {
          assertAuthorityKeyState(result.status, body);
          return errorResponse(
            409,
            "secret_unrecoverable",
            presentStatus(body.operationId, apiKeyId, result.status),
          );
        }
        if (result.kind === "exclusive_conflict") {
          return errorResponse(409, "live_key_exists");
        }
        return Response.json(
          {
            ...presentStatus(body.operationId, apiKeyId, {
              apiKey: result.apiKey,
              present: true,
              usable: true,
              revokedAt: null,
            }),
            secret: result.secret,
          },
          { status: 201, headers: privateHeaders() },
        );
      }
      const currentStatus = await input.apiKeys.status({
        organizationId: configuration.organizationId,
        apiKeyId,
      });
      assertAuthorityKeyState(currentStatus, body);
      if (action === "status") {
        return Response.json(presentStatus(body.operationId, apiKeyId, currentStatus), {
          headers: privateHeaders(),
        });
      }
      const status = await input.apiKeys.revoke({
        organizationId: configuration.organizationId,
        apiKeyId,
      });
      assertAuthorityKeyState(status, body);
      return Response.json(presentStatus(body.operationId, apiKeyId, status), {
        headers: privateHeaders(),
      });
    } catch (error) {
      if (error instanceof IntegrationE2eCredentialAuthorityError) {
        const status =
          error.code === "invalid_operator_assertion"
            ? 401
            : error.code === "operator_policy_mismatch"
              ? 403
              : error.code === "key_state_conflict"
                ? 409
                : error.code === "request_too_large"
                  ? 413
                  : error.code === "organization_unavailable" ||
                      error.code === "configuration_unavailable"
                    ? 503
                    : 400;
        return errorResponse(status, error.code);
      }
      return errorResponse(500, "internal_error");
    }
  };
}

async function verifyProof(input: {
  readonly action: IntegrationE2eCredentialAuthorityAction;
  readonly body: IntegrationE2eCredentialAuthorityRequestBody;
  readonly assertion: string;
  readonly configuration: IntegrationE2eCredentialAuthorityIdentity & {
    readonly publicJwk: { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string };
  };
  readonly verifier: ReturnType<typeof createOperatorPurposeVerifier>;
}): Promise<void> {
  let claims: Readonly<Record<string, unknown>>;
  try {
    claims = await input.verifier.verify(input.assertion, INTEGRATION_E2E_API_KEY_PURPOSE);
  } catch {
    throw new IntegrationE2eCredentialAuthorityError("invalid_operator_assertion");
  }
  const expected = await credentialAuthorityClaims({
    action: input.action,
    body: input.body,
    identity: input.configuration,
  });
  const expectedKeys = [...Object.keys(expected), "exp", "iat"];
  if (!exactKeys(claims, expectedKeys)) {
    throw new IntegrationE2eCredentialAuthorityError("invalid_operator_assertion");
  }
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(claims[key]) !== JSON.stringify(value)) {
      throw new IntegrationE2eCredentialAuthorityError("invalid_operator_assertion");
    }
  }
}

function assertPolicy(
  body: IntegrationE2eCredentialAuthorityRequestBody,
  configuration: IntegrationE2eCredentialAuthorityIdentity,
): void {
  if (
    body.organizationId !== configuration.organizationId ||
    JSON.stringify(body.scopes) !== JSON.stringify(INTEGRATION_E2E_API_KEY_SCOPES) ||
    !Number.isSafeInteger(body.ttlSeconds) ||
    body.ttlSeconds <= 0 ||
    body.ttlSeconds > INTEGRATION_E2E_API_KEY_MAX_TTL_SECONDS
  ) {
    throw new IntegrationE2eCredentialAuthorityError("operator_policy_mismatch");
  }
}

function assertAuthorityKeyState(
  status: ApiKeyAdministrationStatus | null,
  body: IntegrationE2eCredentialAuthorityRequestBody,
): void {
  if (!status) return;
  if (
    status.apiKey.name !== INTEGRATION_E2E_API_KEY_NAME ||
    status.apiKey.organizationId !== body.organizationId ||
    JSON.stringify(status.apiKey.scopes) !== JSON.stringify(INTEGRATION_E2E_API_KEY_SCOPES) ||
    Date.parse(status.apiKey.expiresAt) - Date.parse(status.apiKey.createdAt) !==
      body.ttlSeconds * 1_000
  ) {
    throw new IntegrationE2eCredentialAuthorityError("key_state_conflict");
  }
}

function presentStatus(
  operationId: string,
  keyId: string,
  status: ApiKeyAdministrationStatus | null,
): Record<string, unknown> {
  return {
    kind: "takoserver.integration-e2e-api-key-status@v1",
    operationId,
    keyId,
    present: status?.present ?? false,
    usable: status?.usable ?? false,
    ...(status
      ? {
          organizationId: status.apiKey.organizationId,
          scopes: status.apiKey.scopes,
          createdAt: status.apiKey.createdAt,
          expiresAt: status.apiKey.expiresAt,
        }
      : {}),
  };
}

function parseRequestBody(bytes: Uint8Array): IntegrationE2eCredentialAuthorityRequestBody {
  let value: unknown;
  try {
    value = parseStrictJson(bytes, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof StrictJsonError) {
      throw new IntegrationE2eCredentialAuthorityError("invalid_request");
    }
    throw error;
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, ["operationId", "organizationId", "scopes", "ttlSeconds"]) ||
    typeof value.operationId !== "string" ||
    !OPERATION_ID.test(value.operationId) ||
    typeof value.organizationId !== "string" ||
    !boundedIdentity(value.organizationId) ||
    !Array.isArray(value.scopes) ||
    value.scopes.length < 1 ||
    value.scopes.length > 8 ||
    value.scopes.some((scope) => typeof scope !== "string") ||
    !Number.isSafeInteger(value.ttlSeconds)
  ) {
    throw new IntegrationE2eCredentialAuthorityError("invalid_request");
  }
  return {
    operationId: value.operationId,
    organizationId: value.organizationId,
    scopes: value.scopes as readonly string[],
    ttlSeconds: value.ttlSeconds as number,
  };
}

async function boundedBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new IntegrationE2eCredentialAuthorityError("request_too_large");
  }
  if (!request.body) throw new IntegrationE2eCredentialAuthorityError("invalid_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new IntegrationE2eCredentialAuthorityError("request_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) throw new IntegrationE2eCredentialAuthorityError("invalid_request");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function bearer(value: string | null): string {
  if (!value || value.length > MAX_ASSERTION_BYTES || !value.startsWith("Bearer ")) {
    throw new IntegrationE2eCredentialAuthorityError("invalid_operator_assertion");
  }
  const assertion = value.slice("Bearer ".length);
  if (!assertion || assertion.includes(" ")) {
    throw new IntegrationE2eCredentialAuthorityError("invalid_operator_assertion");
  }
  return assertion;
}

function actionForPath(path: string): IntegrationE2eCredentialAuthorityAction | null {
  for (const action of ["issue", "status", "revoke"] as const) {
    if (path === credentialAuthorityPath(action)) return action;
  }
  return null;
}

function parsePublicJwk(input: unknown): {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
} {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new IntegrationE2eCredentialAuthorityError("configuration_unavailable");
    }
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, ["crv", "kty", "x"]) ||
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    typeof value.x !== "string"
  ) {
    throw new IntegrationE2eCredentialAuthorityError("configuration_unavailable");
  }
  const bytes = base64UrlDecode(value.x);
  if (bytes?.byteLength !== 32) {
    throw new IntegrationE2eCredentialAuthorityError("configuration_unavailable");
  }
  return { kty: "OKP", crv: "Ed25519", x: value.x };
}

function boundedIdentity(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value &&
    !value.includes("/") &&
    !value.includes("%") &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  );
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function privateHeaders(): Record<string, string> {
  return {
    "cache-control": "private, no-store",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
  };
}

function errorResponse(status: number, code: string, details?: Record<string, unknown>): Response {
  return Response.json(
    { error: { code }, ...(details ? { status: details } : {}) },
    { status, headers: privateHeaders() },
  );
}

// Keep the fixed scope's source type tied to the public API-key vocabulary.
const _scopeTypecheck: readonly ApiKeyScope[] = INTEGRATION_E2E_API_KEY_SCOPES;
void _scopeTypecheck;
