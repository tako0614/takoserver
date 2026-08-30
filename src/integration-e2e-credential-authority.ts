import type { ApiKeyScope } from "./auth.ts";
import { base64UrlDecode, bytesDigest, canonicalDigest, isSha256Digest } from "./json.ts";
import { createOperatorPurposeVerifier } from "./operator-credentials.ts";
import type { Clock, Row, Sql } from "./ports.ts";
import { SqlError } from "./ports.ts";
import { parseStrictJson, StrictJsonError } from "./strict-json.ts";

export const INTEGRATION_E2E_API_KEY_PURPOSE = "integration-e2e-api-key-pair";
export const INTEGRATION_E2E_WRITER_KEY_NAME = "integration-e2e-writer";
export const INTEGRATION_E2E_EVIDENCE_KEY_NAME = "integration-e2e-evidence";
export const INTEGRATION_E2E_WRITER_SCOPES = ["resources:write"] as const;
export const INTEGRATION_E2E_EVIDENCE_SCOPES = ["resources:read"] as const;
export const INTEGRATION_E2E_ORGANIZATION_ID = "org_takosumi_hosted_staging";
export const INTEGRATION_E2E_API_KEY_DEFAULT_TTL_SECONDS = 3_600;
export const INTEGRATION_E2E_API_KEY_PROOF_MAX_TTL_SECONDS = 60;

const AUTHORITY_SLOT = "integration-e2e-credential-pair";
const OPERATION_TABLE = "integration_e2e_credential_pair_operations";
const LEGACY_KEY_NAME = "integration-e2e-api-key";
const MAX_BODY_BYTES = 8 * 1_024;
const MAX_ASSERTION_BYTES = 8 * 1_024;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const WORKER_VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;

export type IntegrationE2eCredentialRole = "writer" | "evidence";
export type IntegrationE2eCredentialAuthorityAction = "issue" | "status" | "revoke";
export type IntegrationE2eCredentialPairOperationState =
  | "unregistered"
  | "indeterminate"
  | "prepared"
  | "issuing"
  | "active"
  | "partial"
  | "revoking"
  | "revoked";

export const INTEGRATION_E2E_CREDENTIAL_ROLE_POLICY = [
  { role: "writer", scopes: INTEGRATION_E2E_WRITER_SCOPES },
  { role: "evidence", scopes: INTEGRATION_E2E_EVIDENCE_SCOPES },
] as const;

export interface IntegrationE2eCredentialAuthorityIdentity {
  readonly environment: "integration";
  readonly organizationId: string;
  readonly sourceCommit: string;
  readonly artifactDigest: `sha256:${string}`;
  readonly publicWorkerVersionId: string;
}

export interface IntegrationE2eCredentialAuthorityConfig
  extends IntegrationE2eCredentialAuthorityIdentity {
  /** Public half of the dedicated integration credential-pair Ed25519 key. */
  readonly publicJwk: string | { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string };
}

export interface IntegrationE2eCredentialAuthorityRequestBody {
  readonly operationId: string;
  readonly organizationId: string;
  readonly roles: readonly {
    readonly role: IntegrationE2eCredentialRole;
    readonly scopes: readonly string[];
  }[];
  readonly ttlSeconds: number;
}

export interface IntegrationE2eCredentialRoleStatus {
  readonly role: IntegrationE2eCredentialRole;
  readonly name: string;
  readonly keyId: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly ttlSeconds: number;
  /** Whether a durable bearer row exists, including a revoked tombstone row. */
  readonly recorded: boolean;
  /** Whether the exact bearer row is currently unrevoked. */
  readonly present: boolean;
  readonly usable: boolean;
  readonly createdAt?: string;
  readonly expiresAt?: string;
}

export interface IntegrationE2eCredentialPairStatus {
  readonly kind: "takoserver.integration-e2e-credential-pair-status@v1";
  readonly operationId: string;
  readonly organizationId: string;
  readonly state: IntegrationE2eCredentialPairOperationState;
  readonly fence: number | null;
  readonly completeness: "absent" | "partial" | "complete";
  readonly terminal: boolean;
  readonly legacyKeyPresent: boolean;
  readonly provenance: {
    readonly sourceCommit: string;
    readonly artifactDigest: `sha256:${string}`;
    readonly publicWorkerVersionId: string;
  } | null;
  readonly roles: {
    readonly writer: IntegrationE2eCredentialRoleStatus;
    readonly evidence: IntegrationE2eCredentialRoleStatus;
  };
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
      | "live_pair_exists"
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

export function credentialAuthorityRequestBody(input: {
  readonly operationId: string;
  readonly organizationId: string;
  readonly roles?: IntegrationE2eCredentialAuthorityRequestBody["roles"];
  readonly ttlSeconds: number;
}): IntegrationE2eCredentialAuthorityRequestBody {
  return {
    operationId: input.operationId,
    organizationId: input.organizationId,
    roles: (input.roles ?? INTEGRATION_E2E_CREDENTIAL_ROLE_POLICY).map((role) => ({
      role: role.role,
      scopes: [...role.scopes],
    })),
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
    roles: input.body.roles.map((role) => ({ role: role.role, scopes: [...role.scopes] })),
    ttlSeconds: input.body.ttlSeconds,
    sourceCommit: input.identity.sourceCommit,
    artifactDigest: input.identity.artifactDigest,
    publicWorkerVersionId: input.identity.publicWorkerVersionId,
  };
}

/** Stable role addresses. The operation id itself is never stored in a bearer row. */
export async function deterministicIntegrationE2eApiKeyIds(
  operationId: string,
): Promise<Record<IntegrationE2eCredentialRole, string>> {
  assertOperationId(operationId);
  const roleId = async (role: IntegrationE2eCredentialRole, marker: string): Promise<string> => {
    const digest = await canonicalDigest({
      purpose: INTEGRATION_E2E_API_KEY_PURPOSE,
      operationId,
      role,
    });
    return `key_ie2e_${marker}_${digest.slice("sha256:".length, "sha256:".length + 40)}`;
  };
  return {
    writer: await roleId("writer", "w"),
    evidence: await roleId("evidence", "e"),
  };
}

async function deterministicLegacyApiKeyId(operationId: string): Promise<string> {
  assertOperationId(operationId);
  const digest = await canonicalDigest({ purpose: "integration-e2e-api-key", operationId });
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
  readonly sql: Sql;
  readonly clock?: Clock;
  /** Boundary seam for collision tests; production uses cryptographic randomness. */
  readonly randomSecret?: () => string;
}): IntegrationE2eCredentialAuthorityRoute {
  const configuration = resolveIntegrationE2eCredentialAuthorityConfig(input.configuration);
  if (!configuration) {
    throw new IntegrationE2eCredentialAuthorityError("configuration_unavailable");
  }
  const clock = input.clock ?? (() => new Date());
  const lifecycle = createCredentialPairLifecycle({
    sql: input.sql,
    clock,
    randomSecret: input.randomSecret ?? randomSecret,
  });
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
      if (!(await lifecycle.organizationExists(configuration.organizationId))) {
        return errorResponse(409, "organization_unavailable");
      }

      if (action === "status") {
        return Response.json(await lifecycle.status(body), { headers: privateHeaders() });
      }
      if (action === "revoke") {
        const result = await lifecycle.revoke(body, configuration);
        if (result.kind === "live_pair_exists") {
          return errorResponse(409, "live_pair_exists");
        }
        return Response.json(result.pair, { headers: privateHeaders() });
      }

      const result = await lifecycle.issue(body, configuration);
      if (result.kind === "issued") {
        return Response.json(
          {
            kind: "takoserver.integration-e2e-credential-pair-issued@v1",
            pair: result.pair,
            secrets: result.secrets,
          },
          { status: 201, headers: privateHeaders() },
        );
      }
      if (result.kind === "existing") {
        return errorResponse(409, "secret_unrecoverable", result.pair);
      }
      if (result.kind === "live_pair_exists") {
        return errorResponse(409, "live_pair_exists");
      }
      return errorResponse(500, "pair_issue_incomplete", result.pair);
    } catch (error) {
      if (error instanceof IntegrationE2eCredentialAuthorityError) {
        const status =
          error.code === "invalid_operator_assertion"
            ? 401
            : error.code === "operator_policy_mismatch"
              ? 403
              : error.code === "key_state_conflict" || error.code === "live_pair_exists"
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

type DurableOperationState = Exclude<
  IntegrationE2eCredentialPairOperationState,
  "unregistered" | "indeterminate"
>;

interface PreparedOperation {
  readonly inserted: boolean;
  readonly conflict: boolean;
  readonly fence: number;
}

function createCredentialPairLifecycle(input: {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly randomSecret: () => string;
}) {
  const nowMilliseconds = (): number => input.clock().getTime();

  const organizationExists = async (organizationId: string): Promise<boolean> => {
    const rows = await input.sql.query("SELECT owner_principal_id FROM orgs WHERE id = ?", [
      organizationId,
    ]);
    return typeof rows[0]?.owner_principal_id === "string";
  };

  const status = async (
    body: IntegrationE2eCredentialAuthorityRequestBody,
  ): Promise<IntegrationE2eCredentialPairStatus> => {
    const ids = await deterministicIntegrationE2eApiKeyIds(body.operationId);
    const legacyKeyId = await deterministicLegacyApiKeyId(body.operationId);
    const rows = await input.sql.query(
      `SELECT
         p.operation_id, p.org_id, p.writer_key_id, p.evidence_key_id,
         p.writer_name, p.evidence_name, p.writer_scopes_json, p.evidence_scopes_json,
         p.ttl_seconds, p.state, p.fence, p.source_commit, p.artifact_digest,
         p.authority_worker_version_id,
         w.id AS writer_row_id, w.org_id AS writer_org_id, w.name AS writer_row_name,
         w.scopes_json AS writer_row_scopes_json, w.created_at AS writer_created_at,
         w.expires_at AS writer_expires_at, w.revoked_at AS writer_revoked_at,
         e.id AS evidence_row_id, e.org_id AS evidence_org_id, e.name AS evidence_row_name,
         e.scopes_json AS evidence_row_scopes_json, e.created_at AS evidence_created_at,
         e.expires_at AS evidence_expires_at, e.revoked_at AS evidence_revoked_at,
         l.id AS legacy_row_id, l.org_id AS legacy_org_id, l.name AS legacy_name,
         l.scopes_json AS legacy_scopes_json, l.revoked_at AS legacy_revoked_at
       FROM ${OPERATION_TABLE} p
       LEFT JOIN auth_tokens w ON w.id = p.writer_key_id AND w.kind = 'api_key'
       LEFT JOIN auth_tokens e ON e.id = p.evidence_key_id AND e.kind = 'api_key'
       LEFT JOIN auth_tokens l ON l.id = ? AND l.kind = 'api_key'
       WHERE p.operation_id = ?`,
      [legacyKeyId, body.operationId],
    );
    const operation = rows[0];
    if (operation) return pairStatusFromOperation(operation, body, ids, nowMilliseconds());

    const orphanRows = await input.sql.query(
      `SELECT id, org_id, name, scopes_json, created_at, expires_at, revoked_at
       FROM auth_tokens WHERE kind = 'api_key' AND id IN (?, ?, ?)`,
      [ids.writer, ids.evidence, legacyKeyId],
    );
    const writer = orphanRows.find((row) => row.id === ids.writer);
    const evidence = orphanRows.find((row) => row.id === ids.evidence);
    const legacy = orphanRows.find((row) => row.id === legacyKeyId);
    if (writer) validateRoleRow(writer, body, "writer", ids.writer);
    if (evidence) validateRoleRow(evidence, body, "evidence", ids.evidence);
    if (legacy) validateLegacyRow(legacy, body, legacyKeyId);
    const writerStatus = roleStatus(
      "writer",
      ids.writer,
      writer,
      body.ttlSeconds,
      nowMilliseconds(),
    );
    const evidenceStatus = roleStatus(
      "evidence",
      ids.evidence,
      evidence,
      body.ttlSeconds,
      nowMilliseconds(),
    );
    const legacyKeyPresent = legacy !== undefined && legacy.revoked_at === null;
    const completeness = pairCompleteness(writerStatus.present, evidenceStatus.present);
    return {
      kind: "takoserver.integration-e2e-credential-pair-status@v1",
      operationId: body.operationId,
      organizationId: body.organizationId,
      state:
        writer !== undefined || evidence !== undefined || legacy !== undefined
          ? "indeterminate"
          : "unregistered",
      fence: null,
      completeness,
      terminal: false,
      legacyKeyPresent,
      provenance: null,
      roles: { writer: writerStatus, evidence: evidenceStatus },
    };
  };

  const prepare = async (
    body: IntegrationE2eCredentialAuthorityRequestBody,
    identity: IntegrationE2eCredentialAuthorityIdentity,
  ): Promise<PreparedOperation> => {
    const ids = await deterministicIntegrationE2eApiKeyIds(body.operationId);
    const now = nowMilliseconds();
    let write: Awaited<ReturnType<Sql["run"]>>;
    try {
      write = await input.sql.run(
        `INSERT INTO ${OPERATION_TABLE}
           (operation_id, authority_slot, org_id, writer_key_id, evidence_key_id,
            writer_name, evidence_name, writer_scopes_json, evidence_scopes_json,
            ttl_seconds, state, fence, source_commit, artifact_digest,
            authority_worker_version_id, created_at, updated_at, revoked_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 1, ?, ?, ?, ?, ?, NULL
         WHERE NOT EXISTS (
           SELECT 1 FROM auth_tokens
           WHERE kind = 'api_key' AND org_id = ? AND name = ? AND revoked_at IS NULL
         )
         ON CONFLICT(operation_id) DO NOTHING`,
        [
          body.operationId,
          AUTHORITY_SLOT,
          body.organizationId,
          ids.writer,
          ids.evidence,
          INTEGRATION_E2E_WRITER_KEY_NAME,
          INTEGRATION_E2E_EVIDENCE_KEY_NAME,
          JSON.stringify(INTEGRATION_E2E_WRITER_SCOPES),
          JSON.stringify(INTEGRATION_E2E_EVIDENCE_SCOPES),
          body.ttlSeconds,
          identity.sourceCommit,
          identity.artifactDigest,
          identity.publicWorkerVersionId,
          now,
          now,
          body.organizationId,
          LEGACY_KEY_NAME,
        ],
      );
    } catch (error) {
      if (error instanceof SqlError && error.code === "constraint") {
        return { inserted: false, conflict: true, fence: 0 };
      }
      throw error;
    }
    if (write.changes === 1) return { inserted: true, conflict: false, fence: 1 };
    const current = await status(body);
    if (current.state === "unregistered") return { inserted: false, conflict: true, fence: 0 };
    return { inserted: false, conflict: false, fence: current.fence ?? 0 };
  };

  const exactLegacyRow = async (
    body: IntegrationE2eCredentialAuthorityRequestBody,
  ): Promise<Row | null> => {
    const legacyKeyId = await deterministicLegacyApiKeyId(body.operationId);
    const rows = await input.sql.query(
      `SELECT id, org_id, name, scopes_json, created_at, expires_at, revoked_at
       FROM auth_tokens WHERE id = ? AND kind = 'api_key'`,
      [legacyKeyId],
    );
    const row = rows[0];
    if (!row) return null;
    validateLegacyRow(row, body, legacyKeyId);
    return row;
  };

  const revokeExactLegacy = async (
    body: IntegrationE2eCredentialAuthorityRequestBody,
  ): Promise<IntegrationE2eCredentialPairStatus> => {
    const legacyKeyId = await deterministicLegacyApiKeyId(body.operationId);
    const revokedAt = input.clock().toISOString();
    await input.sql.run(
      `UPDATE auth_tokens SET revoked_at = ?
       WHERE id = ? AND org_id = ? AND kind = 'api_key' AND name = ?
         AND scopes_json = ? AND revoked_at IS NULL`,
      [
        revokedAt,
        legacyKeyId,
        body.organizationId,
        LEGACY_KEY_NAME,
        JSON.stringify(INTEGRATION_E2E_WRITER_SCOPES),
      ],
    );
    const settled = await status(body);
    if (settled.legacyKeyPresent) {
      throw new IntegrationE2eCredentialAuthorityError("key_state_conflict");
    }
    return settled;
  };

  const beginRevoke = async (body: IntegrationE2eCredentialAuthorityRequestBody): Promise<void> => {
    // A local CAS may lose once to issue's only forward transition
    // (issuing -> active). Re-read that durable state and claim revoke from
    // the newer fence. This is not a network mutation retry: every attempt is
    // a guarded D1 owner transition and no bearer is touched until revoking.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await status(body);
      if (current.state === "unregistered" || current.state === "indeterminate") {
        throw new IntegrationE2eCredentialAuthorityError("key_state_conflict");
      }
      if (current.state === "revoked" || current.state === "revoking") return;
      const write = await input.sql.run(
        `UPDATE ${OPERATION_TABLE}
         SET state = 'revoking', fence = fence + 1, updated_at = ?
         WHERE operation_id = ? AND fence = ?
           AND state IN ('prepared', 'issuing', 'active', 'partial')`,
        [nowMilliseconds(), body.operationId, current.fence as number],
      );
      if (write.changes === 1) return;
    }
    const raced = await status(body);
    if (raced.state === "revoking" || raced.state === "revoked") return;
    throw new IntegrationE2eCredentialAuthorityError("key_state_conflict");
  };

  const settleRevoke = async (
    body: IntegrationE2eCredentialAuthorityRequestBody,
  ): Promise<IntegrationE2eCredentialPairStatus> => {
    const current = await status(body);
    if (current.state === "revoked") return current;
    if (current.state !== "revoking" || current.fence === null) {
      throw new IntegrationE2eCredentialAuthorityError("key_state_conflict");
    }
    const ids = await deterministicIntegrationE2eApiKeyIds(body.operationId);
    const legacyId = await deterministicLegacyApiKeyId(body.operationId);
    const revokedAt = input.clock().toISOString();
    const now = nowMilliseconds();
    await input.sql.batch([
      {
        sql: `UPDATE auth_tokens SET revoked_at = ?
              WHERE id = ? AND org_id = ? AND kind = 'api_key' AND revoked_at IS NULL`,
        params: [revokedAt, ids.writer, body.organizationId],
      },
      {
        sql: `UPDATE auth_tokens SET revoked_at = ?
              WHERE id = ? AND org_id = ? AND kind = 'api_key' AND revoked_at IS NULL`,
        params: [revokedAt, ids.evidence, body.organizationId],
      },
      {
        sql: `UPDATE auth_tokens SET revoked_at = ?
              WHERE id = ? AND org_id = ? AND kind = 'api_key' AND revoked_at IS NULL`,
        params: [revokedAt, legacyId, body.organizationId],
      },
      {
        sql: `UPDATE ${OPERATION_TABLE}
              SET state = 'revoked', fence = fence + 1, updated_at = ?, revoked_at = ?
              WHERE operation_id = ? AND state = 'revoking' AND fence = ?
                AND NOT EXISTS (
                  SELECT 1 FROM auth_tokens
                  WHERE kind = 'api_key' AND org_id = ? AND revoked_at IS NULL
                    AND id IN (?, ?, ?)
                )`,
        params: [
          now,
          now,
          body.operationId,
          current.fence,
          body.organizationId,
          ids.writer,
          ids.evidence,
          legacyId,
        ],
      },
    ]);
    const settled = await status(body);
    if (!settled.terminal) {
      throw new IntegrationE2eCredentialAuthorityError("key_state_conflict");
    }
    return settled;
  };

  const revoke = async (
    body: IntegrationE2eCredentialAuthorityRequestBody,
    identity: IntegrationE2eCredentialAuthorityIdentity,
  ): Promise<
    | { readonly kind: "revoked"; readonly pair: IntegrationE2eCredentialPairStatus }
    | { readonly kind: "live_pair_exists" }
  > => {
    let current = await status(body);
    if (current.state === "unregistered" || current.state === "indeterminate") {
      // A pre-0030 operation has only its deterministic legacy bearer row. It
      // must remain indeterminate (there is no pair provenance to fabricate),
      // but the current dedicated authority can still revoke that exact row.
      // This path never claims the pair live slot, so it cannot disturb a
      // separately recorded writer/evidence pair.
      if ((await exactLegacyRow(body)) !== null) {
        return { kind: "revoked", pair: await revokeExactLegacy(body) };
      }
      const prepared = await prepare(body, identity);
      if (prepared.conflict) return { kind: "live_pair_exists" };
      current = await status(body);
    }
    if (current.state !== "revoked") await beginRevoke(body);
    return { kind: "revoked", pair: await settleRevoke(body) };
  };

  const issue = async (
    body: IntegrationE2eCredentialAuthorityRequestBody,
    identity: IntegrationE2eCredentialAuthorityIdentity,
  ): Promise<
    | {
        readonly kind: "issued";
        readonly pair: IntegrationE2eCredentialPairStatus;
        readonly secrets: { readonly writer: string; readonly evidence: string };
      }
    | {
        readonly kind: "existing" | "incomplete";
        readonly pair: IntegrationE2eCredentialPairStatus;
      }
    | { readonly kind: "live_pair_exists" }
  > => {
    const prepared = await prepare(body, identity);
    if (prepared.conflict) return { kind: "live_pair_exists" };
    if (!prepared.inserted) return { kind: "existing", pair: await status(body) };

    const beforeClaim = await status(body);
    if (
      beforeClaim.state !== "prepared" ||
      beforeClaim.fence !== prepared.fence ||
      beforeClaim.completeness !== "absent" ||
      beforeClaim.legacyKeyPresent
    ) {
      const repaired = await revoke(body, identity);
      if (repaired.kind === "live_pair_exists") return repaired;
      return { kind: "incomplete", pair: repaired.pair };
    }
    const claim = await input.sql.run(
      `UPDATE ${OPERATION_TABLE}
       SET state = 'issuing', fence = fence + 1, updated_at = ?
       WHERE operation_id = ? AND state = 'prepared' AND fence = ?`,
      [nowMilliseconds(), body.operationId, prepared.fence],
    );
    if (claim.changes !== 1) {
      return { kind: "existing", pair: await status(body) };
    }
    const claimed = await status(body);
    if (claimed.state !== "issuing" || claimed.fence === null) {
      throw new IntegrationE2eCredentialAuthorityError("key_state_conflict");
    }

    const writerSecret = input.randomSecret();
    const evidenceSecret = input.randomSecret();
    if (
      !validSecret(writerSecret) ||
      !validSecret(evidenceSecret) ||
      writerSecret === evidenceSecret
    ) {
      const repaired = await revoke(body, identity);
      if (repaired.kind === "live_pair_exists") return repaired;
      return { kind: "incomplete", pair: repaired.pair };
    }
    const ids = await deterministicIntegrationE2eApiKeyIds(body.operationId);
    const createdAt = input.clock().toISOString();
    const expiresAt = new Date(
      Date.parse(createdAt) + INTEGRATION_E2E_API_KEY_DEFAULT_TTL_SECONDS * 1_000,
    ).toISOString();
    const writerDigest = await bytesDigest(new TextEncoder().encode(writerSecret));
    const evidenceDigest = await bytesDigest(new TextEncoder().encode(evidenceSecret));
    let results: readonly { readonly changes: number }[];
    try {
      results = await input.sql.batch([
        issueRoleStatement({
          operationId: body.operationId,
          fence: claimed.fence,
          organizationId: body.organizationId,
          role: "writer",
          keyId: ids.writer,
          secretDigest: writerDigest,
          createdAt,
          expiresAt,
        }),
        issueRoleStatement({
          operationId: body.operationId,
          fence: claimed.fence,
          organizationId: body.organizationId,
          role: "evidence",
          keyId: ids.evidence,
          secretDigest: evidenceDigest,
          createdAt,
          expiresAt,
        }),
        {
          sql: `UPDATE ${OPERATION_TABLE}
                SET state = 'active', fence = fence + 1, updated_at = ?
                WHERE operation_id = ? AND state = 'issuing' AND fence = ?
                  AND EXISTS (
                    SELECT 1 FROM auth_tokens
                    WHERE id = ? AND kind = 'api_key' AND org_id = ? AND name = ?
                      AND scopes_json = ? AND secret_digest = ?
                      AND created_at = ? AND expires_at = ? AND revoked_at IS NULL
                  )
                  AND EXISTS (
                    SELECT 1 FROM auth_tokens
                    WHERE id = ? AND kind = 'api_key' AND org_id = ? AND name = ?
                      AND scopes_json = ? AND secret_digest = ?
                      AND created_at = ? AND expires_at = ? AND revoked_at IS NULL
                  )`,
          params: [
            nowMilliseconds(),
            body.operationId,
            claimed.fence,
            ids.writer,
            body.organizationId,
            INTEGRATION_E2E_WRITER_KEY_NAME,
            JSON.stringify(INTEGRATION_E2E_WRITER_SCOPES),
            writerDigest,
            createdAt,
            expiresAt,
            ids.evidence,
            body.organizationId,
            INTEGRATION_E2E_EVIDENCE_KEY_NAME,
            JSON.stringify(INTEGRATION_E2E_EVIDENCE_SCOPES),
            evidenceDigest,
            createdAt,
            expiresAt,
          ],
        },
      ]);
    } catch {
      results = [];
    }
    if (results.length === 3 && results.every((result) => result.changes === 1)) {
      const pair = await status(body);
      if (pair.state !== "active" || pair.completeness !== "complete") {
        throw new IntegrationE2eCredentialAuthorityError("key_state_conflict");
      }
      return {
        kind: "issued",
        pair,
        secrets: { writer: writerSecret, evidence: evidenceSecret },
      };
    }

    await input.sql.run(
      `UPDATE ${OPERATION_TABLE}
       SET state = 'partial', fence = fence + 1, updated_at = ?
       WHERE operation_id = ? AND state = 'issuing' AND fence = ?`,
      [nowMilliseconds(), body.operationId, claimed.fence],
    );
    const repaired = await revoke(body, identity);
    if (repaired.kind === "live_pair_exists") return repaired;
    return { kind: "incomplete", pair: repaired.pair };
  };

  return { organizationExists, status, issue, revoke };
}

function issueRoleStatement(input: {
  readonly operationId: string;
  readonly fence: number;
  readonly organizationId: string;
  readonly role: IntegrationE2eCredentialRole;
  readonly keyId: string;
  readonly secretDigest: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}) {
  const name =
    input.role === "writer" ? INTEGRATION_E2E_WRITER_KEY_NAME : INTEGRATION_E2E_EVIDENCE_KEY_NAME;
  const scopes =
    input.role === "writer" ? INTEGRATION_E2E_WRITER_SCOPES : INTEGRATION_E2E_EVIDENCE_SCOPES;
  return {
    sql: `INSERT INTO auth_tokens
            (secret_digest, id, kind, principal_id, org_id, name, scopes_json, created_at, expires_at)
          SELECT ?, ?, 'api_key', o.owner_principal_id, p.org_id, ?, ?, ?, ?
          FROM ${OPERATION_TABLE} p JOIN orgs o ON o.id = p.org_id
          WHERE p.operation_id = ? AND p.org_id = ? AND p.state = 'issuing' AND p.fence = ?
            AND NOT EXISTS (
              SELECT 1 FROM auth_tokens legacy
              WHERE legacy.kind = 'api_key' AND legacy.org_id = p.org_id
                AND legacy.name = '${LEGACY_KEY_NAME}' AND legacy.revoked_at IS NULL
            )
            AND NOT EXISTS (SELECT 1 FROM auth_tokens WHERE id = ?)`,
    params: [
      input.secretDigest,
      input.keyId,
      name,
      JSON.stringify(scopes),
      input.createdAt,
      input.expiresAt,
      input.operationId,
      input.organizationId,
      input.fence,
      input.keyId,
    ],
  } as const;
}

function pairStatusFromOperation(
  row: Row,
  body: IntegrationE2eCredentialAuthorityRequestBody,
  ids: Record<IntegrationE2eCredentialRole, string>,
  now: number,
): IntegrationE2eCredentialPairStatus {
  assertOperationRow(row, body, ids);
  const writerRow = roleRow(row, "writer");
  const evidenceRow = roleRow(row, "evidence");
  if (writerRow) validateRoleRow(writerRow, body, "writer", ids.writer);
  if (evidenceRow) validateRoleRow(evidenceRow, body, "evidence", ids.evidence);
  const legacyRow = legacyRowFromJoin(row);
  if (legacyRow) validateLegacyRow(legacyRow, body, String(legacyRow.id));
  const writer = roleStatus("writer", ids.writer, writerRow, body.ttlSeconds, now);
  const evidence = roleStatus("evidence", ids.evidence, evidenceRow, body.ttlSeconds, now);
  const state = String(row.state) as DurableOperationState;
  const completeness = pairCompleteness(writer.present, evidence.present);
  const legacyKeyPresent = legacyRow !== null && legacyRow.revoked_at === null;
  return {
    kind: "takoserver.integration-e2e-credential-pair-status@v1",
    operationId: body.operationId,
    organizationId: body.organizationId,
    state,
    fence: Number(row.fence),
    completeness,
    terminal: state === "revoked" && completeness === "absent" && !legacyKeyPresent,
    legacyKeyPresent,
    provenance: {
      sourceCommit: String(row.source_commit),
      artifactDigest: String(row.artifact_digest) as `sha256:${string}`,
      publicWorkerVersionId: String(row.authority_worker_version_id),
    },
    roles: { writer, evidence },
  };
}

function assertOperationRow(
  row: Row,
  body: IntegrationE2eCredentialAuthorityRequestBody,
  ids: Record<IntegrationE2eCredentialRole, string>,
): void {
  if (
    row.operation_id !== body.operationId ||
    row.org_id !== body.organizationId ||
    row.writer_key_id !== ids.writer ||
    row.evidence_key_id !== ids.evidence ||
    row.writer_name !== INTEGRATION_E2E_WRITER_KEY_NAME ||
    row.evidence_name !== INTEGRATION_E2E_EVIDENCE_KEY_NAME ||
    row.writer_scopes_json !== JSON.stringify(INTEGRATION_E2E_WRITER_SCOPES) ||
    row.evidence_scopes_json !== JSON.stringify(INTEGRATION_E2E_EVIDENCE_SCOPES) ||
    row.ttl_seconds !== body.ttlSeconds ||
    !["prepared", "issuing", "active", "partial", "revoking", "revoked"].includes(
      String(row.state),
    ) ||
    !Number.isSafeInteger(row.fence) ||
    Number(row.fence) < 1 ||
    typeof row.source_commit !== "string" ||
    !SOURCE_COMMIT.test(row.source_commit) ||
    typeof row.artifact_digest !== "string" ||
    !isSha256Digest(row.artifact_digest) ||
    typeof row.authority_worker_version_id !== "string" ||
    !WORKER_VERSION.test(row.authority_worker_version_id)
  ) {
    throw new IntegrationE2eCredentialAuthorityError("key_state_conflict");
  }
}

function roleRow(row: Row, role: IntegrationE2eCredentialRole): Row | undefined {
  const id = row[`${role}_row_id`];
  if (typeof id !== "string") return undefined;
  return {
    id,
    org_id: row[`${role}_org_id`],
    name: row[`${role}_row_name`],
    scopes_json: row[`${role}_row_scopes_json`],
    created_at: row[`${role}_created_at`],
    expires_at: row[`${role}_expires_at`],
    revoked_at: row[`${role}_revoked_at`],
  };
}

function legacyRowFromJoin(row: Row): Row | null {
  return typeof row.legacy_row_id === "string"
    ? {
        id: row.legacy_row_id,
        org_id: row.legacy_org_id,
        name: row.legacy_name,
        scopes_json: row.legacy_scopes_json,
        revoked_at: row.legacy_revoked_at,
      }
    : null;
}

function validateRoleRow(
  row: Row,
  body: IntegrationE2eCredentialAuthorityRequestBody,
  role: IntegrationE2eCredentialRole,
  keyId: string,
): void {
  const name =
    role === "writer" ? INTEGRATION_E2E_WRITER_KEY_NAME : INTEGRATION_E2E_EVIDENCE_KEY_NAME;
  const scopes =
    role === "writer" ? INTEGRATION_E2E_WRITER_SCOPES : INTEGRATION_E2E_EVIDENCE_SCOPES;
  if (
    row.id !== keyId ||
    row.org_id !== body.organizationId ||
    row.name !== name ||
    row.scopes_json !== JSON.stringify(scopes) ||
    typeof row.created_at !== "string" ||
    typeof row.expires_at !== "string" ||
    Date.parse(row.expires_at) - Date.parse(row.created_at) !== body.ttlSeconds * 1_000 ||
    (row.revoked_at !== null && typeof row.revoked_at !== "string")
  ) {
    throw new IntegrationE2eCredentialAuthorityError("key_state_conflict");
  }
}

function validateLegacyRow(
  row: Row,
  body: IntegrationE2eCredentialAuthorityRequestBody,
  expectedId: string,
): void {
  if (
    row.id !== expectedId ||
    row.org_id !== body.organizationId ||
    row.name !== LEGACY_KEY_NAME ||
    row.scopes_json !== JSON.stringify(INTEGRATION_E2E_WRITER_SCOPES) ||
    (row.revoked_at !== null && typeof row.revoked_at !== "string")
  ) {
    throw new IntegrationE2eCredentialAuthorityError("key_state_conflict");
  }
}

function roleStatus(
  role: IntegrationE2eCredentialRole,
  keyId: string,
  row: Row | undefined,
  ttlSeconds: number,
  now: number,
): IntegrationE2eCredentialRoleStatus {
  const present = row !== undefined && row.revoked_at === null;
  const createdAt = typeof row?.created_at === "string" ? row.created_at : undefined;
  const expiresAt = typeof row?.expires_at === "string" ? row.expires_at : undefined;
  return {
    role,
    name: role === "writer" ? INTEGRATION_E2E_WRITER_KEY_NAME : INTEGRATION_E2E_EVIDENCE_KEY_NAME,
    keyId,
    scopes: role === "writer" ? INTEGRATION_E2E_WRITER_SCOPES : INTEGRATION_E2E_EVIDENCE_SCOPES,
    ttlSeconds,
    recorded: row !== undefined,
    present,
    usable: present && expiresAt !== undefined && Date.parse(expiresAt) > now,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function pairCompleteness(
  writerPresent: boolean,
  evidencePresent: boolean,
): "absent" | "partial" | "complete" {
  return writerPresent && evidencePresent
    ? "complete"
    : writerPresent || evidencePresent
      ? "partial"
      : "absent";
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
    JSON.stringify(body.roles) !== JSON.stringify(INTEGRATION_E2E_CREDENTIAL_ROLE_POLICY) ||
    body.ttlSeconds !== INTEGRATION_E2E_API_KEY_DEFAULT_TTL_SECONDS
  ) {
    throw new IntegrationE2eCredentialAuthorityError("operator_policy_mismatch");
  }
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
    !exactKeys(value, ["operationId", "organizationId", "roles", "ttlSeconds"]) ||
    typeof value.operationId !== "string" ||
    !OPERATION_ID.test(value.operationId) ||
    typeof value.organizationId !== "string" ||
    !boundedIdentity(value.organizationId) ||
    !Array.isArray(value.roles) ||
    value.roles.length !== 2 ||
    value.roles.some(
      (role) =>
        !isRecord(role) ||
        !exactKeys(role, ["role", "scopes"]) ||
        (role.role !== "writer" && role.role !== "evidence") ||
        !Array.isArray(role.scopes) ||
        role.scopes.some((scope) => typeof scope !== "string"),
    ) ||
    !Number.isSafeInteger(value.ttlSeconds)
  ) {
    throw new IntegrationE2eCredentialAuthorityError("invalid_request");
  }
  return {
    operationId: value.operationId,
    organizationId: value.organizationId,
    roles: value.roles as IntegrationE2eCredentialAuthorityRequestBody["roles"],
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

function assertOperationId(operationId: string): void {
  if (!OPERATION_ID.test(operationId)) {
    throw new IntegrationE2eCredentialAuthorityError("invalid_request");
  }
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

function validSecret(value: string): boolean {
  return value.length >= 16 && value.length <= 512;
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

function errorResponse(
  status: number,
  code: string,
  details?: IntegrationE2eCredentialPairStatus,
): Response {
  return Response.json(
    { error: { code }, ...(details ? { pair: details } : {}) },
    { status, headers: privateHeaders() },
  );
}

// Keep both fixed roles tied to the public API-key vocabulary.
const _scopeTypecheck: readonly ApiKeyScope[] = [
  ...INTEGRATION_E2E_WRITER_SCOPES,
  ...INTEGRATION_E2E_EVIDENCE_SCOPES,
];
void _scopeTypecheck;
