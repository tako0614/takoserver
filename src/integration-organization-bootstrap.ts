import {
  createIntegrationOrganizationBootstrapStore,
  INTEGRATION_ORGANIZATION_ID,
  INTEGRATION_ORGANIZATION_NAME,
  type IntegrationOrganizationBootstrapOwnerIdentity,
  type IntegrationOrganizationBootstrapStatus,
  IntegrationOrganizationBootstrapStoreError,
} from "./auth.ts";

export { INTEGRATION_ORGANIZATION_ID, INTEGRATION_ORGANIZATION_NAME } from "./auth.ts";

import { errorEnvelopeResponse } from "./error-envelope.ts";
import { base64UrlDecode, canonicalDigest, isSha256Digest } from "./json.ts";
import {
  canonicalOperatorAudience,
  createOperatorPurposeVerifier,
} from "./operator-credentials.ts";
import type { Clock, Sql } from "./ports.ts";
import { parseStrictJson, StrictJsonError } from "./strict-json.ts";

export const INTEGRATION_ORGANIZATION_BOOTSTRAP_PURPOSE = "integration-organization-bootstrap";
export const INTEGRATION_ORGANIZATION_BOOTSTRAP_PROOF_MAX_TTL_SECONDS = 60;

const MAX_BODY_BYTES = 8 * 1_024;
const MAX_ASSERTION_BYTES = 8 * 1_024;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const WORKER_VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type IntegrationOrganizationBootstrapAction = "status" | "apply";

export interface IntegrationOrganizationBootstrapIdentity {
  readonly environment: "integration";
  readonly hostId: string;
  readonly sourceCommit: string;
  readonly artifactDigest: `sha256:${string}`;
  readonly publicWorkerVersionId: string;
}

export interface IntegrationOrganizationBootstrapConfig
  extends IntegrationOrganizationBootstrapIdentity {
  /** Existing identity-only operator key. No bootstrap-specific secret is introduced. */
  readonly publicJwk: string | { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string };
}

export interface IntegrationOrganizationBootstrapRequestBody {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly owner: IntegrationOrganizationBootstrapOwnerIdentity;
  /** Status resolves this value; apply must return it exactly. */
  readonly ownerPrincipalId?: string;
}

export type IntegrationOrganizationBootstrapRoute = (request: Request) => Promise<Response | null>;

export class IntegrationOrganizationBootstrapError extends Error {
  constructor(
    readonly code:
      | "configuration_unavailable"
      | "invalid_request"
      | "request_too_large"
      | "invalid_operator_assertion"
      | "operator_policy_mismatch"
      | "principal_unavailable"
      | "organization_state_conflict",
  ) {
    super(code);
    this.name = "IntegrationOrganizationBootstrapError";
  }
}

export function integrationOrganizationBootstrapPath(
  action: IntegrationOrganizationBootstrapAction,
): `/v1/operator/integration-e2e/organization-bootstrap/${IntegrationOrganizationBootstrapAction}` {
  return `/v1/operator/integration-e2e/organization-bootstrap/${action}`;
}

export function integrationOrganizationBootstrapRequestBody(input: {
  readonly owner: IntegrationOrganizationBootstrapOwnerIdentity;
  readonly ownerPrincipalId?: string;
}): IntegrationOrganizationBootstrapRequestBody {
  return {
    organizationId: INTEGRATION_ORGANIZATION_ID,
    organizationName: INTEGRATION_ORGANIZATION_NAME,
    owner: { ...input.owner },
    ...(input.ownerPrincipalId === undefined ? {} : { ownerPrincipalId: input.ownerPrincipalId }),
  };
}

/** Exact short-lived claims signed by the existing operator identity key. */
export async function integrationOrganizationBootstrapClaims(input: {
  readonly action: IntegrationOrganizationBootstrapAction;
  readonly body: IntegrationOrganizationBootstrapRequestBody;
  readonly identity: IntegrationOrganizationBootstrapIdentity;
}): Promise<Record<string, unknown>> {
  return {
    purpose: INTEGRATION_ORGANIZATION_BOOTSTRAP_PURPOSE,
    aud: input.identity.hostId,
    action: input.action,
    method: "POST",
    path: integrationOrganizationBootstrapPath(input.action),
    bodyDigest: await canonicalDigest(input.body),
    environment: input.identity.environment,
    hostId: input.identity.hostId,
    sourceCommit: input.identity.sourceCommit,
    artifactDigest: input.identity.artifactDigest,
    publicWorkerVersionId: input.identity.publicWorkerVersionId,
    organizationId: input.body.organizationId,
    organizationName: input.body.organizationName,
    provider: input.body.owner.provider,
    subject: input.body.owner.subject,
    email: input.body.owner.email,
    displayName: input.body.owner.displayName,
    ownerPrincipalId: input.body.ownerPrincipalId ?? null,
  };
}

/**
 * Undefined is intentional route absence. A supplied value is exact or the
 * composition refuses before it can touch storage.
 */
export function resolveIntegrationOrganizationBootstrapConfig(
  input: IntegrationOrganizationBootstrapConfig | undefined,
):
  | (IntegrationOrganizationBootstrapIdentity & {
      readonly publicJwk: {
        readonly kty: "OKP";
        readonly crv: "Ed25519";
        readonly x: string;
      };
    })
  | null {
  if (input === undefined) return null;
  if (
    !record(input) ||
    !exactKeys(input, [
      "artifactDigest",
      "environment",
      "hostId",
      "publicJwk",
      "publicWorkerVersionId",
      "sourceCommit",
    ])
  ) {
    throw new IntegrationOrganizationBootstrapError("configuration_unavailable");
  }
  let hostId: string;
  try {
    hostId = canonicalOperatorAudience(input.hostId);
  } catch {
    throw new IntegrationOrganizationBootstrapError("configuration_unavailable");
  }
  if (
    input.environment !== "integration" ||
    !SOURCE_COMMIT.test(input.sourceCommit) ||
    !isSha256Digest(input.artifactDigest) ||
    !WORKER_VERSION.test(input.publicWorkerVersionId)
  ) {
    throw new IntegrationOrganizationBootstrapError("configuration_unavailable");
  }
  return {
    environment: "integration",
    hostId,
    sourceCommit: input.sourceCommit,
    artifactDigest: input.artifactDigest,
    publicWorkerVersionId: input.publicWorkerVersionId,
    publicJwk: publicJwk(input.publicJwk),
  };
}

export function createIntegrationOrganizationBootstrap(input: {
  readonly configuration: IntegrationOrganizationBootstrapConfig;
  readonly sql: Sql;
  readonly clock?: Clock;
}): IntegrationOrganizationBootstrapRoute {
  const configuration = resolveIntegrationOrganizationBootstrapConfig(input.configuration);
  if (!configuration) {
    throw new IntegrationOrganizationBootstrapError("configuration_unavailable");
  }
  const clock = input.clock ?? (() => new Date());
  const verifier = createOperatorPurposeVerifier({
    publicKeyJwk: configuration.publicJwk,
    clock,
    maxLifetimeSeconds: INTEGRATION_ORGANIZATION_BOOTSTRAP_PROOF_MAX_TTL_SECONDS,
  });
  const store = createIntegrationOrganizationBootstrapStore({ sql: input.sql, clock });

  return async (request) => {
    const url = new URL(request.url);
    const action = actionForPath(url.pathname);
    if (!action || request.method !== "POST" || url.search || url.hash) return null;
    try {
      if (request.headers.get("content-type") !== "application/json") {
        return errorResponse(400, "invalid_argument", "unsupported_media_type");
      }
      const body = parseRequestBody(action, await boundedBody(request));
      const assertion = bearer(request.headers.get("authorization"));
      await verifyProof({ action, body, assertion, configuration, verifier });
      assertPolicy(action, body, url, configuration.hostId);

      if (action === "status") {
        return statusResponse(await store.status(body));
      }
      if (body.ownerPrincipalId === undefined) {
        throw new IntegrationOrganizationBootstrapError("operator_policy_mismatch");
      }
      const applied = await store.apply({
        organizationId: body.organizationId,
        organizationName: body.organizationName,
        owner: body.owner,
        ownerPrincipalId: body.ownerPrincipalId,
      });
      return statusResponse(applied.status, applied.created ? 201 : 200);
    } catch (error) {
      const code =
        error instanceof IntegrationOrganizationBootstrapStoreError
          ? error.code
          : error instanceof IntegrationOrganizationBootstrapError
            ? error.code
            : null;
      if (code) {
        if (code === "invalid_operator_assertion") {
          return errorResponse(401, "unauthenticated", code);
        }
        if (code === "operator_policy_mismatch") {
          return errorResponse(403, "permission_denied", code);
        }
        if (code === "principal_unavailable" || code === "organization_state_conflict") {
          return errorResponse(409, "conflict", code);
        }
        if (code === "post_commit_state_unknown") {
          return errorResponse(503, "unavailable", "internal_error");
        }
        if (code === "configuration_unavailable") {
          return errorResponse(503, "unavailable", code);
        }
        return errorResponse(400, "invalid_argument", code);
      }
      return errorResponse(503, "unavailable", "internal_error");
    }
  };
}

async function verifyProof(input: {
  readonly action: IntegrationOrganizationBootstrapAction;
  readonly body: IntegrationOrganizationBootstrapRequestBody;
  readonly assertion: string;
  readonly configuration: IntegrationOrganizationBootstrapIdentity & {
    readonly publicJwk: { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string };
  };
  readonly verifier: ReturnType<typeof createOperatorPurposeVerifier>;
}): Promise<void> {
  let claims: Readonly<Record<string, unknown>>;
  try {
    claims = await input.verifier.verify(
      input.assertion,
      INTEGRATION_ORGANIZATION_BOOTSTRAP_PURPOSE,
    );
  } catch {
    throw new IntegrationOrganizationBootstrapError("invalid_operator_assertion");
  }
  const expected = await integrationOrganizationBootstrapClaims({
    action: input.action,
    body: input.body,
    identity: input.configuration,
  });
  if (!exactKeys(claims, [...Object.keys(expected), "exp", "iat"])) {
    throw new IntegrationOrganizationBootstrapError("invalid_operator_assertion");
  }
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(claims[key]) !== JSON.stringify(value)) {
      throw new IntegrationOrganizationBootstrapError("invalid_operator_assertion");
    }
  }
}

function assertPolicy(
  action: IntegrationOrganizationBootstrapAction,
  body: IntegrationOrganizationBootstrapRequestBody,
  addressed: URL,
  hostId: string,
): void {
  if (
    addressed.origin !== hostId ||
    addressed.username.length > 0 ||
    addressed.password.length > 0 ||
    body.organizationId !== INTEGRATION_ORGANIZATION_ID ||
    body.organizationName !== INTEGRATION_ORGANIZATION_NAME ||
    (action === "status" && body.ownerPrincipalId !== undefined) ||
    (action === "apply" && body.ownerPrincipalId === undefined)
  ) {
    throw new IntegrationOrganizationBootstrapError("operator_policy_mismatch");
  }
}

function parseRequestBody(
  action: IntegrationOrganizationBootstrapAction,
  bytes: Uint8Array,
): IntegrationOrganizationBootstrapRequestBody {
  let value: unknown;
  try {
    value = parseStrictJson(bytes, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof StrictJsonError) {
      throw new IntegrationOrganizationBootstrapError("invalid_request");
    }
    throw error;
  }
  const keys =
    action === "status"
      ? ["organizationId", "organizationName", "owner"]
      : ["organizationId", "organizationName", "owner", "ownerPrincipalId"];
  if (
    !record(value) ||
    !exactKeys(value, keys) ||
    typeof value.organizationId !== "string" ||
    !boundedText(value.organizationId, 128) ||
    typeof value.organizationName !== "string" ||
    !boundedText(value.organizationName, 128) ||
    !record(value.owner) ||
    !exactKeys(value.owner, ["displayName", "email", "provider", "subject"]) ||
    (value.owner.provider !== "google" && value.owner.provider !== "github") ||
    typeof value.owner.subject !== "string" ||
    !boundedText(value.owner.subject, 256) ||
    typeof value.owner.email !== "string" ||
    !boundedText(value.owner.email, 256) ||
    typeof value.owner.displayName !== "string" ||
    !boundedText(value.owner.displayName, 256) ||
    (action === "apply" &&
      (typeof value.ownerPrincipalId !== "string" || !boundedText(value.ownerPrincipalId, 128)))
  ) {
    throw new IntegrationOrganizationBootstrapError("invalid_request");
  }
  return {
    organizationId: value.organizationId,
    organizationName: value.organizationName,
    owner: {
      provider: value.owner.provider,
      subject: value.owner.subject,
      email: value.owner.email,
      displayName: value.owner.displayName,
    },
    ...(action === "apply" ? { ownerPrincipalId: value.ownerPrincipalId as string } : {}),
  };
}

async function boundedBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new IntegrationOrganizationBootstrapError("request_too_large");
  }
  if (!request.body) throw new IntegrationOrganizationBootstrapError("invalid_request");
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
        throw new IntegrationOrganizationBootstrapError("request_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) throw new IntegrationOrganizationBootstrapError("invalid_request");
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
    throw new IntegrationOrganizationBootstrapError("invalid_operator_assertion");
  }
  const assertion = value.slice("Bearer ".length);
  if (!assertion || assertion.includes(" ")) {
    throw new IntegrationOrganizationBootstrapError("invalid_operator_assertion");
  }
  return assertion;
}

function actionForPath(path: string): IntegrationOrganizationBootstrapAction | null {
  for (const action of ["status", "apply"] as const) {
    if (path === integrationOrganizationBootstrapPath(action)) return action;
  }
  return null;
}

function publicJwk(input: unknown): {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
} {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new IntegrationOrganizationBootstrapError("configuration_unavailable");
    }
  }
  if (
    !record(value) ||
    !exactKeys(value, ["crv", "kty", "x"]) ||
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    typeof value.x !== "string" ||
    base64UrlDecode(value.x)?.byteLength !== 32
  ) {
    throw new IntegrationOrganizationBootstrapError("configuration_unavailable");
  }
  return { kty: "OKP", crv: "Ed25519", x: value.x };
}

function boundedText(value: string, maximum: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    ![...value].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 31 || code === 127);
    })
  );
}

function statusResponse(
  status: IntegrationOrganizationBootstrapStatus,
  responseStatus = 200,
): Response {
  return Response.json(
    { kind: "takoserver.integration-organization-bootstrap-status@v1", ...status },
    { status: responseStatus, headers: privateHeaders() },
  );
}

function errorResponse(status: number, code: string, hostCode?: string): Response {
  return errorEnvelopeResponse(
    code,
    status,
    undefined,
    { headers: privateHeaders() },
    undefined,
    hostCode,
  );
}

function privateHeaders(): Record<string, string> {
  return {
    "cache-control": "private, no-store",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
  };
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
