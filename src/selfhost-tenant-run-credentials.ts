import type { Clock, Sql } from "./ports.ts";
import {
  createTenantRunCredentialSigner,
  MAX_TENANT_RUN_CREDENTIAL_LIFETIME_SECONDS,
} from "./tenant-run-credential.ts";
import {
  type SigningKey,
  type TenantRunCredentialAdmission,
  type TenantRunCredentialIssuance,
  TokenError,
} from "./token.ts";
import {
  WorkerEndpointOriginReservationError,
  type WorkerEndpointOriginReservations,
} from "./worker-endpoint-origin-reservations.ts";

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const KEY_BINDING_CHALLENGE = new TextEncoder().encode(
  "takoserver.selfhost-tenant-run-credential-key-binding.v1",
);

export interface SelfhostTenantRunCredentials
  extends TenantRunCredentialAdmission,
    TenantRunCredentialIssuance {}

/** Validate before a key path is derived or a key is generated. */
export function assertSelfhostTenantRunCredentialKeyConfiguration(input: {
  readonly credentialKeyId: string;
  readonly ordinarySigningKeyId: string;
}): void {
  if (!KEY_ID.test(input.credentialKeyId)) {
    throw new TypeError("self-host tenant-run credential key id is invalid");
  }
  if (input.credentialKeyId === input.ordinarySigningKeyId) {
    throw new TypeError(
      "self-host tenant-run credential key id must differ from the ordinary runtime signing key",
    );
  }
}

/**
 * Prove that the private issuer key is the exact currently-active public key
 * registered for its dedicated id. `ensureSigningKey()` deliberately never
 * overwrites or revives an existing registry row, so a stale file, a reused
 * id, or an operator revocation must stop this authority instead of returning
 * a bearer that the verifier immediately refuses.
 */
export async function assertActiveSelfhostTenantRunCredentialSigningKey(input: {
  readonly signingKey: SigningKey;
  readonly runtimeGrantKeys: Pick<Sql, "query">;
}): Promise<void> {
  let rows: readonly Record<string, unknown>[];
  try {
    rows = await input.runtimeGrantKeys.query(
      `SELECT public_jwk, revoked_at_epoch_seconds
       FROM runtime_grant_keys
       WHERE key_id = ?
       LIMIT 2`,
      [input.signingKey.keyId],
    );
  } catch {
    signingKeyAuthorityError();
  }
  const row = rows.length === 1 ? rows[0] : undefined;
  if (!row || typeof row.public_jwk !== "string" || row.revoked_at_epoch_seconds !== null) {
    signingKeyAuthorityError();
  }

  let matches = false;
  try {
    const parsed = JSON.parse(row.public_jwk) as Record<string, unknown>;
    if (parsed.kty !== "OKP" || parsed.crv !== "Ed25519" || typeof parsed.x !== "string") {
      signingKeyAuthorityError();
    }
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x: parsed.x },
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const signature = await crypto.subtle.sign(
      "Ed25519",
      input.signingKey.privateKey,
      KEY_BINDING_CHALLENGE,
    );
    matches = await crypto.subtle.verify("Ed25519", publicKey, signature, KEY_BINDING_CHALLENGE);
  } catch {
    signingKeyAuthorityError();
  }
  if (!matches) signingKeyAuthorityError();
}

/**
 * Self-host's short-lived delegation authority.
 *
 * The caller has already authenticated an organization API key. This module
 * owns the remaining authority: an optional endpoint reservation must be live
 * under that exact organization, the JWT is signed only by the dedicated key,
 * and verification pins both that key and the self-host claim shape. There is
 * deliberately no fallback to the sponsorship issuance ledger.
 */
export function createSelfhostTenantRunCredentials(options: {
  readonly issuer: string;
  readonly signingKey: SigningKey;
  readonly ordinarySigningKeyId: string;
  readonly runtimeGrantKeys: Pick<Sql, "query">;
  readonly originReservations: Pick<WorkerEndpointOriginReservations, "read">;
  readonly clock: Clock;
  readonly randomId: () => string;
}): SelfhostTenantRunCredentials {
  assertSelfhostTenantRunCredentialKeyConfiguration({
    credentialKeyId: options.signingKey.keyId,
    ordinarySigningKeyId: options.ordinarySigningKeyId,
  });
  const signer = createTenantRunCredentialSigner({
    issuer: options.issuer,
    signingKey: options.signingKey,
    clock: options.clock,
    allowLoopbackHttp: true,
  });

  return {
    async issue(input) {
      await assertActiveSelfhostTenantRunCredentialSigningKey({
        signingKey: options.signingKey,
        runtimeGrantKeys: options.runtimeGrantKeys,
      });
      if (input.workerEndpointOriginReservationId !== undefined) {
        const reservation = await options.originReservations.read(
          input.organizationId,
          input.workerEndpointOriginReservationId,
        );
        const expiresAt = reservation ? Date.parse(reservation.expiresAt) : Number.NaN;
        if (
          !reservation ||
          reservation.reservationId !== input.workerEndpointOriginReservationId ||
          !["prepared", "bound", "activated"].includes(reservation.status) ||
          !Number.isFinite(expiresAt) ||
          (reservation.status !== "activated" && expiresAt <= options.clock().getTime())
        ) {
          throw new WorkerEndpointOriginReservationError("not_found", 404);
        }
      }
      const issuedAtEpochSeconds = Math.floor(options.clock().getTime() / 1_000);
      return await signer.issue({
        organizationId: input.organizationId,
        tenantRef: input.spaceRef,
        spaceRef: input.spaceRef,
        runRef: input.runRef,
        ...(input.workerEndpointOriginReservationId === undefined
          ? {}
          : { workerEndpointOriginReservationId: input.workerEndpointOriginReservationId }),
        issuedAtEpochSeconds,
        tokenId: `selfhost_${options.randomId()}`,
        ttlSeconds: MAX_TENANT_RUN_CREDENTIAL_LIFETIME_SECONDS,
      });
    },

    async assertAdmitted({ claims, keyId }) {
      if (
        keyId !== options.signingKey.keyId ||
        claims.tenantRef !== claims.spaceRef ||
        claims.expiresAtEpochSeconds - claims.issuedAtEpochSeconds >
          MAX_TENANT_RUN_CREDENTIAL_LIFETIME_SECONDS
      ) {
        throw new TokenError("invalid_credential_authority");
      }
    },
  };
}

function signingKeyAuthorityError(): never {
  throw new Error("self-host tenant-run credential key is not the exact active runtime grant key");
}
