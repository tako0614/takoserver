import {
  API_KEY_SCOPES,
  type ApiKey,
  type ApiKeyScope,
  AuthError,
  assertAuthTokenCaptureReader,
  type CapturedAuthTokenRow,
} from "./auth.ts";
import {
  auth103NativeRequestCurrentness,
  qualifyAuth103NativeRequestOrigin,
  readAuth103NativeRequestOrigin,
} from "./auth103-native-origin-source.ts";
import {
  type CredentialAuthorityOrigin,
  createCredentialAuthorityClassStore,
  directCredentialCurrentness,
  directOwnerKeySourceCurrentness,
  type TokenAuthorityRecord,
} from "./credential-authority-class.ts";
import { bytesDigest } from "./json.ts";
import { type Row, type Sql, SqlError, type SqlParam, type SqlWrite } from "./ports.ts";
import { createSharedPrincipalAuthorityStore } from "./shared-principal-authority.ts";
import {
  captureWorkerRequestRetainedDirectOwnerSession,
  readWorkerRequestConsumers,
  readWorkerRequestFinancialInputs,
  readWorkerRequestRetainedCredentialInputs,
  type WorkerRequestSql,
} from "./worker-request-composition.ts";

/** Explicit direct-owner command. No Actor, token DTO, source ref or callback. */
export interface WorkerRequestDirectOwnerKeyCommand {
  readonly organizationId: string;
  readonly name: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly expiresInSeconds: number;
}

function command(input: WorkerRequestDirectOwnerKeyCommand): WorkerRequestDirectOwnerKeyCommand {
  if (
    !input ||
    typeof input !== "object" ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) ||
    Reflect.ownKeys(input).length !== 4
  )
    throw new AuthError("invalid");
  const org = Object.getOwnPropertyDescriptor(input, "organizationId");
  const name = Object.getOwnPropertyDescriptor(input, "name");
  const scopes = Object.getOwnPropertyDescriptor(input, "scopes");
  const ttl = Object.getOwnPropertyDescriptor(input, "expiresInSeconds");
  if (
    !org ||
    !("value" in org) ||
    typeof org.value !== "string" ||
    !org.value ||
    org.value.length > 512 ||
    /\p{Cc}/u.test(org.value) ||
    !name ||
    !("value" in name) ||
    typeof name.value !== "string" ||
    !name.value ||
    name.value.length > 128 ||
    /\p{Cc}/u.test(name.value) ||
    !scopes ||
    !("value" in scopes) ||
    !Array.isArray(scopes.value) ||
    scopes.value.length < 1 ||
    scopes.value.length > API_KEY_SCOPES.length ||
    !ttl ||
    !("value" in ttl) ||
    !Number.isSafeInteger(ttl.value) ||
    ttl.value <= 0
  )
    throw new AuthError("invalid");
  const selected: ApiKeyScope[] = [];
  for (let index = 0; index < scopes.value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(scopes.value, String(index));
    if (!descriptor || !("value" in descriptor)) throw new AuthError("invalid");
    const value = API_KEY_SCOPES.find((scope) => scope === descriptor.value);
    if (!value || selected.includes(value)) throw new AuthError("invalid");
    selected.push(value);
  }
  return Object.freeze({
    organizationId: org.value,
    name: name.value,
    scopes: Object.freeze(selected),
    expiresInSeconds: ttl.value,
  });
}

async function originalRequest(connection: WorkerRequestSql) {
  // WorkerRequestSql's ordinary brand is insufficient. This runs the actual
  // platform/source/Clock/registered-catalog qualifier before any issuance.
  const nativeOrigin = await qualifyAuth103NativeRequestOrigin(connection);
  const native = readAuth103NativeRequestOrigin(nativeOrigin, connection);
  if (!native) throw new AuthError("invalid");
  const inputs = readWorkerRequestFinancialInputs(connection);
  const consumers = readWorkerRequestConsumers(connection);
  const originalSql = inputs.sql;
  const query = Object.getOwnPropertyDescriptor(originalSql, "query");
  const batch = Object.getOwnPropertyDescriptor(originalSql, "batch");
  if (
    !query ||
    !("value" in query) ||
    typeof query.value !== "function" ||
    !batch ||
    !("value" in batch) ||
    typeof batch.value !== "function"
  )
    throw new AuthError("invalid");
  const assertCurrent = (): void => {
    const current = readAuth103NativeRequestOrigin(nativeOrigin, connection);
    if (
      !current ||
      current.authSchemaRef !== native.authSchemaRef ||
      current.targetRef !== native.targetRef ||
      current.sourceRef !== native.sourceRef ||
      current.clockPolicyRef !== native.clockPolicyRef ||
      readWorkerRequestFinancialInputs(connection) !== inputs ||
      readWorkerRequestConsumers(connection) !== consumers
    )
      throw new AuthError("invalid");
    for (const [name, expected] of [
      ["query", query.value],
      ["batch", batch.value],
    ] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(originalSql, name);
      if (!descriptor || !("value" in descriptor) || descriptor.value !== expected)
        throw new AuthError("invalid");
    }
  };
  const sql = Object.freeze<Sql>({
    async query(text, params) {
      assertCurrent();
      let rows: readonly Row[];
      try {
        rows = await Reflect.apply(query.value, originalSql, [text, params]);
      } catch (error) {
        throw new SqlError(
          error instanceof SqlError ? error.code : "unavailable",
          "direct key store operation failed",
        );
      }
      assertCurrent();
      return rows;
    },
    async run() {
      throw new AuthError("invalid");
    },
    async batch(statements) {
      assertCurrent();
      let writes: readonly SqlWrite[];
      try {
        writes = await Reflect.apply(batch.value, originalSql, [statements]);
      } catch (error) {
        throw new SqlError(
          error instanceof SqlError ? error.code : "unavailable",
          "direct key store operation failed",
        );
      }
      assertCurrent();
      return writes;
    },
  });
  assertCurrent();
  return Object.freeze({
    inputs,
    consumers,
    native,
    sql,
    assertCurrent,
    currentness() {
      assertCurrent();
      return auth103NativeRequestCurrentness(nativeOrigin, connection);
    },
  });
}

type OriginalRequest = Awaited<ReturnType<typeof originalRequest>>;
type Fields = Readonly<Record<string, SqlParam>>;

function exact(write: SqlWrite | undefined, expected: Fields): boolean {
  if (
    !write ||
    !Number.isSafeInteger(write.changes) ||
    write.changes <= 0 ||
    write.rows.length !== 1
  )
    return false;
  const row = write.rows[0];
  return (
    !!row &&
    Reflect.ownKeys(row).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => {
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      return descriptor && "value" in descriptor && descriptor.value === value;
    })
  );
}

function postimage(table: "auth_tokens" | "credential_authority_classes", fields: Fields) {
  return {
    sql: `EXISTS (SELECT 1 FROM ${table} WHERE ${Object.keys(fields)
      .map((key) => `${key} IS ?`)
      .join(" AND ")})`,
    params: Object.values(fields),
  };
}

/**
 * Explicit Root-owned issuer leaf, not mounted over the ordinary API-key path.
 * A retained original native-target owner session is mandatory. Missing classes
 * are refused; no class is inferred from an Actor, scope or ordinary bearer.
 */
export async function issueWorkerRequestDirectOwnerKey(
  connection: WorkerRequestSql,
  authorization: string | null,
  input: WorkerRequestDirectOwnerKeyCommand,
): Promise<{ readonly apiKey: ApiKey; readonly secret: string }> {
  const selected = command(input);
  const request = await originalRequest(connection);
  const sourceCapture = await captureWorkerRequestRetainedDirectOwnerSession(
    connection,
    authorization,
  );
  request.assertCurrent();
  const source = readWorkerRequestRetainedCredentialInputs(connection, sourceCapture);
  const accounts = request.consumers.accounts;
  assertAuthTokenCaptureReader(accounts, { sql: request.inputs.sql });
  const inspect = Object.getOwnPropertyDescriptor(accounts, "inspectAuthenticatedTokenCapture");
  if (!inspect || !("value" in inspect) || typeof inspect.value !== "function")
    throw new AuthError("invalid");
  const captured: CapturedAuthTokenRow | null = Reflect.apply(inspect.value, accounts, [
    sourceCapture,
  ]);
  request.assertCurrent();
  if (
    !source ||
    source.inputs !== request.inputs ||
    source.credentialOriginal.backend !== "auth-token" ||
    !captured ||
    source.credentialOriginal.record.origin.targetRef !== request.native.targetRef
  )
    throw new AuthError("permission_denied");
  const sourceRecord = source.credentialOriginal.record;
  const anchor = await createSharedPrincipalAuthorityStore({ sql: request.sql }).readAnchor(
    captured.principalId,
  );
  request.assertCurrent();
  if (!anchor || anchor.originKind !== "fresh-local" || anchor.state !== "active")
    throw new AuthError("permission_denied");
  const sourceCurrent = directOwnerKeySourceCurrentness(
    sourceRecord,
    anchor,
    anchor.verificationDomain,
    captured,
    selected.organizationId,
  );
  const nativeCurrent = request.currentness();
  const issuedAt = request.inputs.clock();
  const createdAt = issuedAt.toISOString();
  const expiresAt = new Date(issuedAt.getTime() + selected.expiresInSeconds * 1000).toISOString();
  const secret = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  const digest = await bytesDigest(new TextEncoder().encode(secret));
  request.assertCurrent();
  const id = `key_${crypto.randomUUID().replaceAll("-", "")}`;
  const scopesJson = JSON.stringify(selected.scopes);
  const origin: CredentialAuthorityOrigin = Object.freeze({
    ref: `authority_${crypto.randomUUID()}`,
    incarnation: `credential_inc_${crypto.randomUUID()}`,
    targetRef: request.native.targetRef,
    principalId: captured.principalId,
    principalIncarnation: anchor.incarnation,
    issuanceRef: `direct_key_${id}`,
    issuanceDigest: digest,
    issuedAt: createdAt,
  });
  const tokenFields: Fields = Object.freeze({
    secret_digest: digest,
    id,
    kind: "api_key",
    principal_id: captured.principalId,
    org_id: selected.organizationId,
    name: selected.name,
    scopes_json: scopesJson,
    created_at: createdAt,
    expires_at: expiresAt,
    revoked_at: null,
  });
  const classFields: Fields = Object.freeze({
    authority_ref: origin.ref,
    credential_incarnation: origin.incarnation,
    class: "direct-exact-org-key",
    backend: "auth-token",
    target_ref: origin.targetRef,
    organization_id: selected.organizationId,
    principal_id: captured.principalId,
    principal_incarnation: anchor.incarnation,
    issuance_ref: origin.issuanceRef,
    issuance_digest: digest,
    issued_at: createdAt,
    token_id: id,
    token_digest: digest,
    token_kind: "api_key",
    token_scopes_json: scopesJson,
    token_created_at: createdAt,
    principal_binding_ref: null,
    rp_registration_ref: null,
    rp_registration_digest: null,
    session_digest: null,
    session_created_at: null,
    session_enrolled_version: null,
    issuer: null,
    client_id: null,
    subject: null,
    issuer_session_id: null,
    auth_time: null,
    account_id: null,
    workspace_id: null,
    workspace_ref: null,
    state: "active",
    terminal_reason: null,
    terminal_at: null,
    terminal_ref: null,
  });
  const companion = createCredentialAuthorityClassStore({
    sql: request.sql,
  }).directKeyFromOwnerSessionStatement(
    origin,
    { id, digest, scopesJson, createdAt },
    selected.organizationId,
    anchor,
    anchor.verificationDomain,
    sourceRecord,
    captured,
    { name: selected.name },
  );
  const tokenPostimage = postimage("auth_tokens", tokenFields);
  const classPostimage = postimage("credential_authority_classes", classFields);
  const closure = `(${nativeCurrent.sql}) AND (${sourceCurrent.sql})`;
  const closureParams = [...nativeCurrent.params, ...sourceCurrent.params];
  const writes = await request.sql.batch([
    {
      sql: `INSERT INTO auth_tokens
      (secret_digest,id,kind,principal_id,org_id,name,scopes_json,created_at,expires_at)
      VALUES (?,?,'api_key',CASE WHEN ${closure} THEN ? ELSE NULL END,?,?,?,?,?)
      RETURNING ${Object.keys(tokenFields).join(",")}`,
      params: [
        digest,
        id,
        ...closureParams,
        captured.principalId,
        selected.organizationId,
        selected.name,
        scopesJson,
        createdAt,
        expiresAt,
      ],
    },
    {
      sql: `${companion.sql} RETURNING ${Object.keys(classFields).join(",")}`,
      ...(companion.params === undefined ? {} : { params: companion.params }),
    },
    {
      sql: `UPDATE auth_tokens SET principal_id=CASE WHEN ${closure}
      AND (${tokenPostimage.sql}) AND (${classPostimage.sql}) THEN principal_id ELSE NULL END
      WHERE secret_digest=? AND id=? RETURNING ${Object.keys(tokenFields).join(",")}`,
      params: [...closureParams, ...tokenPostimage.params, ...classPostimage.params, digest, id],
    },
  ]);
  request.assertCurrent();
  if (
    writes.length !== 3 ||
    !exact(writes[0], tokenFields) ||
    !exact(writes[1], classFields) ||
    !exact(writes[2], tokenFields)
  )
    throw new AuthError("invalid");
  return Object.freeze({
    apiKey: Object.freeze({
      id,
      organizationId: selected.organizationId,
      name: selected.name,
      scopes: selected.scopes,
      createdAt,
      expiresAt,
    }),
    secret,
  });
}

const directKeyCaptureBrand: unique symbol = Symbol("worker-request-direct-key");
export interface WorkerRequestDirectKeyCapture {
  readonly [directKeyCaptureBrand]: true;
}
export interface WorkerRequestRetainedDirectKeyData {
  readonly backend: "auth-token";
  readonly record: TokenAuthorityRecord;
  readonly captured: CapturedAuthTokenRow;
}
const captures = new WeakMap<
  object,
  {
    readonly connection: WorkerRequestSql;
    readonly request: OriginalRequest;
    readonly data: WorkerRequestRetainedDirectKeyData;
  }
>();

/** Actual native-target key/class/anchor reads, no supplied family or row DTO. */
export async function captureWorkerRequestRetainedDirectKey(
  connection: WorkerRequestSql,
  authorization: string | null,
): Promise<WorkerRequestDirectKeyCapture | null> {
  const request = await originalRequest(connection);
  if (!authorization?.startsWith("Bearer ")) return null;
  const secret = authorization.slice(7);
  if (secret.length < 16 || secret.length > 512) return null;
  const digest = await bytesDigest(new TextEncoder().encode(secret));
  request.assertCurrent();
  const rows = await request.sql.query(
    `SELECT id,kind,principal_id,org_id,scopes_json,created_at,expires_at
    FROM auth_tokens WHERE secret_digest=? AND kind='api_key' AND revoked_at IS NULL
      AND expires_at>?`,
    [digest, request.inputs.clock().toISOString()],
  );
  const row = rows[0];
  if (!row) return null;
  if (
    rows.length !== 1 ||
    typeof row.id !== "string" ||
    row.kind !== "api_key" ||
    typeof row.principal_id !== "string" ||
    typeof row.org_id !== "string" ||
    typeof row.scopes_json !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.expires_at !== "string"
  )
    throw new AuthError("invalid");
  let rawScopes: unknown;
  try {
    rawScopes = JSON.parse(row.scopes_json);
  } catch {
    throw new AuthError("invalid");
  }
  if (!Array.isArray(rawScopes) || rawScopes.length < 1 || rawScopes.length > API_KEY_SCOPES.length)
    throw new AuthError("invalid");
  const scopes: ApiKeyScope[] = [];
  for (const rawScope of rawScopes) {
    const scope = API_KEY_SCOPES.find((value) => value === rawScope);
    if (!scope || scopes.includes(scope)) throw new AuthError("invalid");
    scopes.push(scope);
  }
  const captured: CapturedAuthTokenRow = Object.freeze({
    tokenId: row.id,
    digest,
    kind: "api_key",
    principalId: row.principal_id,
    organizationId: row.org_id,
    scopesJson: row.scopes_json,
    scopes: Object.freeze(scopes),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  });
  const refs = await request.sql.query(
    `SELECT authority_ref FROM credential_authority_classes
    WHERE token_id=? AND token_digest=? AND class='direct-exact-org-key' AND state='active'`,
    [captured.tokenId, digest],
  );
  if (refs.length !== 1 || typeof refs[0]?.authority_ref !== "string") return null;
  const record = await createCredentialAuthorityClassStore({ sql: request.sql }).readRetained(
    refs[0].authority_ref,
  );
  if (
    !record ||
    record.backend !== "auth-token" ||
    record.class !== "direct-exact-org-key" ||
    record.state !== "active" ||
    record.origin.targetRef !== request.native.targetRef ||
    record.token.id !== captured.tokenId ||
    record.token.digest !== captured.digest ||
    record.origin.principalId !== captured.principalId ||
    record.organizationId !== captured.organizationId ||
    record.token.createdAt !== captured.createdAt ||
    record.token.scopesJson !== captured.scopesJson
  )
    return null;
  const anchor = await createSharedPrincipalAuthorityStore({ sql: request.sql }).readAnchor(
    captured.principalId,
  );
  if (!anchor || anchor.originKind !== "fresh-local" || anchor.state !== "active") return null;
  const credentialCurrent = directCredentialCurrentness(
    record,
    anchor,
    anchor.verificationDomain,
    captured.expiresAt,
  );
  const nativeCurrent = request.currentness();
  const current = await request.sql.query(
    `SELECT CASE WHEN (${credentialCurrent.sql}) AND (${nativeCurrent.sql}) THEN 1 ELSE 0 END AS valid`,
    [...credentialCurrent.params, ...nativeCurrent.params],
  );
  if (
    current.length !== 1 ||
    current[0]?.valid !== 1 ||
    Date.parse(captured.expiresAt) <= request.inputs.clock().getTime()
  )
    return null;
  request.assertCurrent();
  const capture: WorkerRequestDirectKeyCapture = { [directKeyCaptureBrand]: true };
  Object.freeze(capture);
  captures.set(
    capture,
    Object.freeze({
      connection,
      request,
      data: Object.freeze({ backend: "auth-token", record, captured }),
    }),
  );
  return capture;
}

/** Historical DATA only. It does not grant current admission, human or payer authority. */
export function readWorkerRequestRetainedDirectKeyCapture(
  connection: WorkerRequestSql,
  capture: unknown,
): WorkerRequestRetainedDirectKeyData | null {
  if (!capture || typeof capture !== "object") return null;
  // The private map accepts only handles emitted by the actual read path above.
  const original = captures.get(capture);
  if (!original || original.connection !== connection) return null;
  original.request.assertCurrent();
  return original.data;
}
