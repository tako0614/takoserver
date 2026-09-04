import { canonicalDigest } from "./json.ts";
import type { Clock, Sql } from "./ports.ts";
import type { SponsorshipCredentialIssuer } from "./sponsorship-credential.ts";
import type {
  SponsorshipIssuanceReceiptIssuer,
  SponsorshipReceiptChannel,
} from "./sponsorship-issuance-receipt.ts";

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CREDENTIAL_TTL_SECONDS = 300;
const MAX_REQUIRED_AVAILABLE_MINOR = 1_000_000_000;

export interface SponsorshipAuthorityCredential {
  readonly token: string;
  readonly expiresAt: string;
  readonly issuanceReceipt: string;
}

export interface SponsorshipAuthority {
  issueTenantRunCredential(input: unknown): Promise<SponsorshipAuthorityCredential>;
}

export type SponsorshipAuthorityErrorCode =
  | "invalid_input"
  | "authority_denied"
  | "operation_conflict"
  | "invalid_credential";

export class SponsorshipAuthorityError extends Error {
  constructor(readonly code: SponsorshipAuthorityErrorCode) {
    super(code);
    this.name = "SponsorshipAuthorityError";
  }
}

/**
 * One narrow Hosted authority operation.
 *
 * The deployment, not the caller, selects the Takoserver organization. The
 * guarded INSERT is the complete admission decision: it binds a previously
 * unseen opaque tenant only while the pinned organization's wallet satisfies
 * the requested floor, accepts an exact replay for that same organization,
 * and changes zero rows for a conflicting owner or unavailable credit. Only a
 * successful decision reaches the signing authority.
 */
export function createSponsorshipAuthority(options: {
  readonly sql: Sql;
  readonly organizationId: string;
  readonly credentialIssuer: SponsorshipCredentialIssuer;
  readonly receipts: SponsorshipIssuanceReceiptIssuer;
  readonly credentialPublicJwk: {
    readonly kty: "OKP";
    readonly crv: "Ed25519";
    readonly x: string;
  };
  readonly issuanceAuthority: {
    readonly workerName: string;
    readonly versionId: string;
    readonly sourceCommit: string;
    readonly artifactSha256: `sha256:${string}`;
    readonly credentialKeyId: string;
    readonly receiptKeyId: string;
  };
  readonly clock: Clock;
}): SponsorshipAuthority {
  const organizationId = reference(options.organizationId);
  const issuanceAuthority = exactIssuanceAuthority(options.issuanceAuthority);

  return {
    async issueTenantRunCredential(value) {
      const input = credentialInput(value);
      const now = options.clock();
      const issuedAtEpochSeconds = Math.floor(now.getTime() / 1_000);
      if (!Number.isSafeInteger(issuedAtEpochSeconds)) {
        throw new SponsorshipAuthorityError("authority_denied");
      }
      const expiresAtEpochSeconds = issuedAtEpochSeconds + CREDENTIAL_TTL_SECONDS;
      const createdAt = new Date(issuedAtEpochSeconds * 1_000).toISOString();
      const requestNonceSha256 = await digestText(input.channel.requestNonce);
      const expectedOperationId = await canonicalDigest({
        kind: "takosumi-hosted.sponsorship-issuance-operation@v1",
        requestSha256: input.channel.requestSha256,
      });
      if (input.channel.issuanceOperationId !== expectedOperationId) {
        throw new SponsorshipAuthorityError("invalid_input");
      }
      const { issuanceOperationId: _issuanceOperationId, ...logicalChannel } = input.channel;
      const inputSha256 = await canonicalDigest({
        organizationId,
        request: { ...input, channel: logicalChannel },
      });
      const tokenId = `tok_sponsor_${input.channel.issuanceOperationId.slice(7)}`;
      await options.sql.run(
        `WITH wallet AS (
           SELECT
             organization.id AS org_id,
             COALESCE((
               SELECT SUM(CASE
                 WHEN lot.expires_at IS NULL OR lot.expires_at > ? THEN
                   lot.amount_minor - COALESCE((
                     SELECT SUM(allocation.amount_minor)
                     FROM wallet_credit_allocations AS allocation
                     WHERE allocation.org_id = lot.org_id
                       AND allocation.lot_ref = lot.ref
                       AND allocation.debit_type IN ('capture', 'usage_debit')
                   ), 0)
                 ELSE COALESCE((
                   SELECT SUM(allocation.amount_minor)
                   FROM wallet_credit_allocations AS allocation
                   WHERE allocation.org_id = lot.org_id
                     AND allocation.lot_ref = lot.ref
                     AND allocation.debit_type = 'hold'
                 ), 0)
               END)
               FROM wallet_credit_lots AS lot
               WHERE lot.org_id = organization.id
             ), 0) AS settled_minor,
             COALESCE((
               SELECT SUM(entry.held_delta)
               FROM ledger AS entry
               WHERE entry.org_id = organization.id
             ), 0) AS held_minor,
             COALESCE((
               SELECT SUM(allocation.amount_minor)
               FROM wallet_credit_allocations AS allocation
               WHERE allocation.org_id = organization.id
                 AND allocation.debit_type = 'hold'
             ), 0) AS allocated_held_minor
           FROM orgs AS organization
           WHERE organization.id = ?
         )
         INSERT INTO sponsorship_credential_issuance_operations
           (issuance_operation_id, input_sha256, request_sha256,
            request_nonce_sha256, tenant_ref, org_id, hosted_version_id,
            issued_at_epoch_seconds, expires_at_epoch_seconds, token_id,
            credential_key_id, receipt_key_id, authority_version_id,
            authority_source_commit, authority_artifact_sha256, created_at)
         SELECT ?, ?, ?, ?, ?, org_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM wallet
         WHERE settled_minor >= 0
           AND held_minor >= 0
           AND allocated_held_minor = held_minor
           AND settled_minor - held_minor >= ?
           AND (
             NOT EXISTS (
               SELECT 1 FROM sponsorship_tenants WHERE tenant_ref = ?
             ) OR EXISTS (
               SELECT 1 FROM sponsorship_tenants
               WHERE tenant_ref = ? AND org_id = wallet.org_id
             )
           )
         ON CONFLICT DO NOTHING`,
        [
          now.toISOString(),
          organizationId,
          input.channel.issuanceOperationId,
          inputSha256,
          input.channel.requestSha256,
          requestNonceSha256,
          input.tenantRef,
          input.channel.hostedVersionId,
          issuedAtEpochSeconds,
          expiresAtEpochSeconds,
          tokenId,
          issuanceAuthority.credentialKeyId,
          issuanceAuthority.receiptKeyId,
          issuanceAuthority.versionId,
          issuanceAuthority.sourceCommit,
          issuanceAuthority.artifactSha256,
          createdAt,
          input.requiredAvailableMinor,
          input.tenantRef,
          input.tenantRef,
        ],
      );
      const operation = await readIssuanceOperation(options.sql, input.channel.issuanceOperationId);
      if (operation === null) {
        throw new SponsorshipAuthorityError("authority_denied");
      }
      if (
        operation.inputSha256 !== inputSha256 ||
        operation.requestSha256 !== input.channel.requestSha256 ||
        operation.requestNonceSha256 !== requestNonceSha256 ||
        operation.tenantRef !== input.tenantRef ||
        operation.organizationId !== organizationId ||
        operation.hostedVersionId !== input.channel.hostedVersionId ||
        operation.tokenId !== tokenId ||
        operation.credentialKeyId !== issuanceAuthority.credentialKeyId ||
        operation.receiptKeyId !== issuanceAuthority.receiptKeyId ||
        operation.authorityVersionId !== issuanceAuthority.versionId ||
        operation.authoritySourceCommit !== issuanceAuthority.sourceCommit ||
        operation.authorityArtifactSha256 !== issuanceAuthority.artifactSha256 ||
        operation.expiresAtEpochSeconds - operation.issuedAtEpochSeconds !== CREDENTIAL_TTL_SECONDS
      ) {
        throw new SponsorshipAuthorityError("operation_conflict");
      }

      const credential = await options.credentialIssuer.issue({
        organizationId,
        tenantRef: input.tenantRef,
        spaceRef: input.spaceRef,
        runRef: input.runRef,
        ...(input.workerEndpointOriginReservationId === undefined
          ? {}
          : {
              workerEndpointOriginReservationId: input.workerEndpointOriginReservationId,
            }),
        ttlSeconds: CREDENTIAL_TTL_SECONDS,
        issuedAtEpochSeconds: operation.issuedAtEpochSeconds,
        tokenId: operation.tokenId,
      });
      const issuedAt = new Date(operation.issuedAtEpochSeconds * 1_000);
      const validated = validatedCredential(credential, issuedAt);
      const issuanceReceipt = await options.receipts.issue({
        channel: input.channel,
        token: validated.token,
        issuedAt,
        expiresAt: validated.expiresAt,
        credentialPublicJwk: options.credentialPublicJwk,
        organizationId,
        tenantRef: input.tenantRef,
        spaceRef: input.spaceRef,
        runRef: input.runRef,
        requiredAvailableMinor: input.requiredAvailableMinor,
        ...(input.workerEndpointOriginReservationId === undefined
          ? {}
          : { workerEndpointOriginReservationId: input.workerEndpointOriginReservationId }),
      });
      if (
        typeof issuanceReceipt !== "string" ||
        issuanceReceipt.length < 16 ||
        issuanceReceipt.length > 16_384 ||
        !/^[A-Za-z0-9._-]+$/u.test(issuanceReceipt)
      ) {
        throw new SponsorshipAuthorityError("invalid_credential");
      }
      return { ...validated, issuanceReceipt };
    },
  };
}

interface CredentialInput {
  readonly tenantRef: string;
  readonly spaceRef: string;
  readonly runRef: string;
  readonly requiredAvailableMinor: number;
  readonly workerEndpointOriginReservationId?: string;
  readonly channel: SponsorshipReceiptChannel;
}

interface SponsorshipCredentialIssuanceOperation {
  readonly inputSha256: string;
  readonly requestSha256: string;
  readonly requestNonceSha256: string;
  readonly tenantRef: string;
  readonly organizationId: string;
  readonly hostedVersionId: string;
  readonly issuedAtEpochSeconds: number;
  readonly expiresAtEpochSeconds: number;
  readonly tokenId: string;
  readonly credentialKeyId: string;
  readonly receiptKeyId: string;
  readonly authorityVersionId: string;
  readonly authoritySourceCommit: string;
  readonly authorityArtifactSha256: string;
}

function credentialInput(value: unknown): CredentialInput {
  if (!record(value)) invalidInput();
  const keys = Object.keys(value).sort();
  const expected = ["channel", "requiredAvailableMinor", "runRef", "spaceRef", "tenantRef"];
  const withReservation = [...expected, "workerEndpointOriginReservationId"].sort();
  if (
    JSON.stringify(keys) !== JSON.stringify(expected) &&
    JSON.stringify(keys) !== JSON.stringify(withReservation)
  ) {
    invalidInput();
  }
  const requiredAvailableMinor = value.requiredAvailableMinor;
  if (
    !Number.isSafeInteger(requiredAvailableMinor) ||
    (requiredAvailableMinor as number) < 0 ||
    (requiredAvailableMinor as number) > MAX_REQUIRED_AVAILABLE_MINOR
  ) {
    invalidInput();
  }
  try {
    return {
      tenantRef: reference(value.tenantRef),
      spaceRef: reference(value.spaceRef),
      runRef: reference(value.runRef),
      requiredAvailableMinor: requiredAvailableMinor as number,
      channel: receiptChannel(value.channel),
      ...(value.workerEndpointOriginReservationId === undefined
        ? {}
        : {
            workerEndpointOriginReservationId: reference(value.workerEndpointOriginReservationId),
          }),
    };
  } catch {
    invalidInput();
  }
}

function receiptChannel(value: unknown): SponsorshipReceiptChannel {
  if (
    !record(value) ||
    Object.keys(value).sort().join("\0") !==
      "hostedVersionId\0issuanceOperationId\0kind\0requestNonce\0requestSha256" ||
    value.kind !== "takosumi-hosted.sponsorship-authority-rpc@v1" ||
    typeof value.hostedVersionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value.hostedVersionId,
    ) ||
    typeof value.requestNonce !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.requestNonce) ||
    typeof value.issuanceOperationId !== "string" ||
    !SHA256.test(value.issuanceOperationId) ||
    typeof value.requestSha256 !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.requestSha256)
  ) {
    invalidInput();
  }
  return value as unknown as SponsorshipReceiptChannel;
}

async function readIssuanceOperation(
  sql: Sql,
  issuanceOperationId: string,
): Promise<SponsorshipCredentialIssuanceOperation | null> {
  const rows = await sql.query(
    `SELECT input_sha256, request_sha256, request_nonce_sha256, tenant_ref,
            org_id, hosted_version_id, issued_at_epoch_seconds,
            expires_at_epoch_seconds, token_id, credential_key_id,
            receipt_key_id, authority_version_id, authority_source_commit,
            authority_artifact_sha256
     FROM sponsorship_credential_issuance_operations
     WHERE issuance_operation_id = ? LIMIT 2`,
    [issuanceOperationId],
  );
  if (rows.length === 0) return null;
  const row = rows.length === 1 ? rows[0] : undefined;
  if (
    !row ||
    typeof row.input_sha256 !== "string" ||
    !SHA256.test(row.input_sha256) ||
    typeof row.request_sha256 !== "string" ||
    !SHA256.test(row.request_sha256) ||
    typeof row.request_nonce_sha256 !== "string" ||
    !SHA256.test(row.request_nonce_sha256) ||
    typeof row.tenant_ref !== "string" ||
    !REFERENCE.test(row.tenant_ref) ||
    typeof row.org_id !== "string" ||
    !REFERENCE.test(row.org_id) ||
    typeof row.hosted_version_id !== "string" ||
    !VERSION_ID.test(row.hosted_version_id) ||
    !Number.isSafeInteger(row.issued_at_epoch_seconds) ||
    (row.issued_at_epoch_seconds as number) < 0 ||
    !Number.isSafeInteger(row.expires_at_epoch_seconds) ||
    (row.expires_at_epoch_seconds as number) <= (row.issued_at_epoch_seconds as number) ||
    typeof row.token_id !== "string" ||
    !REFERENCE.test(row.token_id) ||
    typeof row.credential_key_id !== "string" ||
    !REFERENCE.test(row.credential_key_id) ||
    typeof row.receipt_key_id !== "string" ||
    !REFERENCE.test(row.receipt_key_id) ||
    typeof row.authority_version_id !== "string" ||
    !VERSION_ID.test(row.authority_version_id) ||
    typeof row.authority_source_commit !== "string" ||
    !COMMIT.test(row.authority_source_commit) ||
    typeof row.authority_artifact_sha256 !== "string" ||
    !SHA256.test(row.authority_artifact_sha256)
  ) {
    throw new SponsorshipAuthorityError("authority_denied");
  }
  return {
    inputSha256: String(row.input_sha256),
    requestSha256: String(row.request_sha256),
    requestNonceSha256: String(row.request_nonce_sha256),
    tenantRef: row.tenant_ref,
    organizationId: row.org_id,
    hostedVersionId: row.hosted_version_id,
    issuedAtEpochSeconds: row.issued_at_epoch_seconds as number,
    expiresAtEpochSeconds: row.expires_at_epoch_seconds as number,
    tokenId: row.token_id,
    credentialKeyId: row.credential_key_id,
    receiptKeyId: row.receipt_key_id,
    authorityVersionId: row.authority_version_id,
    authoritySourceCommit: row.authority_source_commit,
    authorityArtifactSha256: row.authority_artifact_sha256,
  };
}

function exactIssuanceAuthority(value: {
  readonly workerName: string;
  readonly versionId: string;
  readonly sourceCommit: string;
  readonly artifactSha256: `sha256:${string}`;
  readonly credentialKeyId: string;
  readonly receiptKeyId: string;
}): typeof value {
  if (
    !REFERENCE.test(value.workerName) ||
    !VERSION_ID.test(value.versionId) ||
    !COMMIT.test(value.sourceCommit) ||
    !SHA256.test(value.artifactSha256) ||
    !REFERENCE.test(value.credentialKeyId) ||
    !REFERENCE.test(value.receiptKeyId)
  ) {
    throw new TypeError("sponsorship issuance authority identity is invalid");
  }
  if (value.credentialKeyId === value.receiptKeyId) {
    throw new TypeError("sponsorship issuance authority must use a dedicated receipt key");
  }
  return value;
}

async function digestText(value: string): Promise<`sha256:${string}`> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function validatedCredential(
  value: unknown,
  issuedAt: Date,
): Omit<SponsorshipAuthorityCredential, "issuanceReceipt"> {
  if (!record(value) || Object.keys(value).sort().join("\0") !== "expiresAt\0token") {
    throw new SponsorshipAuthorityError("invalid_credential");
  }
  if (
    typeof value.token !== "string" ||
    value.token.length < 3 ||
    value.token.length > 16_384 ||
    !/^[A-Za-z0-9._-]+$/u.test(value.token) ||
    typeof value.expiresAt !== "string"
  ) {
    throw new SponsorshipAuthorityError("invalid_credential");
  }
  const expiresAt = new Date(value.expiresAt);
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.toISOString() !== value.expiresAt ||
    expiresAt.getTime() <= issuedAt.getTime() ||
    expiresAt.getTime() - issuedAt.getTime() > CREDENTIAL_TTL_SECONDS * 1_000
  ) {
    throw new SponsorshipAuthorityError("invalid_credential");
  }
  return { token: value.token, expiresAt: value.expiresAt };
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !REFERENCE.test(value)) {
    invalidInput();
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidInput(): never {
  throw new SponsorshipAuthorityError("invalid_input");
}
