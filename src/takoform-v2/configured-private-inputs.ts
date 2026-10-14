import type { Sql } from "../ports.ts";

/** Opaque Form-sealed configured material, distinct from expiring transfer custody. */
export interface V2ConfiguredPrivateInputs {
  readonly keyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
}

export interface V2ConfiguredPrivateInputIdentity {
  readonly principal: string;
  readonly space: string;
  readonly name: string;
  readonly form: string;
  readonly resourceUid: string;
}

/**
 * Trusted backend-only ciphertext read, never an authorization grant or public state.
 * Without a selector this preserves the existing live Resource-owned CREATE read.
 * A selector reads only exact accepted UPDATE history, including after soft deletion;
 * missing history never falls back to CREATE, current, or latest material.
 */
export async function readV2ConfiguredPrivateInputs(
  sql: Sql,
  identity: V2ConfiguredPrivateInputIdentity,
  acceptedUpdate?: { readonly operationId: string; readonly generation: number },
): Promise<V2ConfiguredPrivateInputs | null> {
  if (
    acceptedUpdate !== undefined &&
    (!acceptedUpdate ||
      typeof acceptedUpdate.operationId !== "string" ||
      !acceptedUpdate.operationId ||
      !Number.isSafeInteger(acceptedUpdate.generation) ||
      acceptedUpdate.generation < 1)
  )
    throw new TypeError("invalid configured private input operation selector");
  const row = (
    await sql.query(
      acceptedUpdate
        ? `SELECT material.key_id, material.nonce, material.ciphertext
       FROM tf_v2_operation_configured_private_inputs material
       JOIN tf_v2_operations op ON op.id = material.operation_id
       JOIN tf_v2_resources resource ON resource.uid = material.resource_uid
      WHERE resource.uid = ? AND resource.principal = ? AND resource.space = ?
        AND resource.name = ? AND resource.form_url = ?
        AND op.id = ? AND op.generation = ? AND material.generation = op.generation
        AND op.resource_uid = resource.uid AND op.principal = resource.principal
        AND op.backend_id = resource.backend_id AND op.target_key = resource.target_key
        AND op.action = 'update'`
        : `SELECT material.key_id, material.nonce, material.ciphertext
       FROM tf_v2_configured_private_inputs material
       JOIN tf_v2_resources resource ON resource.uid = material.resource_uid
      WHERE resource.uid = ? AND resource.principal = ? AND resource.space = ?
        AND resource.name = ? AND resource.form_url = ? AND resource.deleted_at IS NULL`,
      [
        identity.resourceUid,
        identity.principal,
        identity.space,
        identity.name,
        identity.form,
        ...(acceptedUpdate ? [acceptedUpdate.operationId, acceptedUpdate.generation] : []),
      ],
    )
  )[0];
  if (!row) return null;
  if (
    typeof row.key_id !== "string" ||
    typeof row.nonce !== "string" ||
    typeof row.ciphertext !== "string"
  ) {
    throw new TypeError("invalid configured private input custody");
  }
  return { keyId: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext };
}
