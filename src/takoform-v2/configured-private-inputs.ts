import type { Sql } from "../ports.ts";

/** Opaque Form-sealed stable Resource material, distinct from one-Operation transfer custody. */
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

/** Trusted backend-only read; never route this material through HTTP or public state. */
export async function readV2ConfiguredPrivateInputs(
  sql: Sql,
  identity: V2ConfiguredPrivateInputIdentity,
): Promise<V2ConfiguredPrivateInputs | null> {
  const row = (
    await sql.query(
      `SELECT material.key_id, material.nonce, material.ciphertext
       FROM tf_v2_configured_private_inputs material
       JOIN tf_v2_resources resource ON resource.uid = material.resource_uid
      WHERE resource.uid = ? AND resource.principal = ? AND resource.space = ?
        AND resource.name = ? AND resource.form_url = ? AND resource.deleted_at IS NULL`,
      [identity.resourceUid, identity.principal, identity.space, identity.name, identity.form],
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
