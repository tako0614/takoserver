import type { Sql } from "../ports.ts";
import {
  v2ConfiguredUpdateDiscardObjects,
  v2ConfiguredUpdateDiscardSchema,
} from "./configured-update-inputs-schema.ts";

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

/** Internal source-only input. The native retirement verifier owns its proof. */
export interface V2RetiredConfiguredUpdateInput extends V2ConfiguredPrivateInputIdentity {
  readonly backendId: string;
  readonly targetKey: string;
  readonly operationId: string;
  readonly generation: number;
}

const DISCARD_TABLE = "tf_v2_operation_configured_private_inputs";
const DISCARD_GATE = v2ConfiguredUpdateDiscardObjects.gate;
const DISCARD_FIELDS = [
  "backendId",
  "form",
  "generation",
  "name",
  "operationId",
  "principal",
  "resourceUid",
  "space",
  "targetKey",
] as const;

function discardUnavailable(): never {
  throw new Error("configured UPDATE discard unavailable");
}

function validDiscardToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    ![...value].some((char) => {
      const point = char.codePointAt(0) ?? 0;
      return point < 32 || point === 127 || (point >= 0xd800 && point <= 0xdfff);
    })
  );
}

function captureDiscardInput(
  value: V2RetiredConfiguredUpdateInput,
): V2RetiredConfiguredUpdateInput {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join() !== DISCARD_FIELDS.join() ||
    ![
      value.principal,
      value.space,
      value.name,
      value.form,
      value.resourceUid,
      value.backendId,
      value.targetKey,
      value.operationId,
    ].every(validDiscardToken) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 2
  )
    discardUnavailable();
  return Object.freeze({
    principal: value.principal,
    space: value.space,
    name: value.name,
    form: value.form,
    resourceUid: value.resourceUid,
    backendId: value.backendId,
    targetKey: value.targetKey,
    operationId: value.operationId,
    generation: value.generation,
  });
}

const DISCARD_SCHEMA = Object.freeze([
  [
    v2ConfiguredUpdateDiscardObjects.gate,
    "table",
    DISCARD_GATE,
    v2ConfiguredUpdateDiscardSchema.gate,
  ],
  [
    v2ConfiguredUpdateDiscardObjects.index,
    "index",
    DISCARD_TABLE,
    v2ConfiguredUpdateDiscardSchema.index,
  ],
  [
    v2ConfiguredUpdateDiscardObjects.insertGuard,
    "trigger",
    DISCARD_GATE,
    v2ConfiguredUpdateDiscardSchema.insertGuard,
  ],
  [
    v2ConfiguredUpdateDiscardObjects.deleteGuard,
    "trigger",
    DISCARD_TABLE,
    v2ConfiguredUpdateDiscardSchema.deleteGuard,
  ],
  [
    v2ConfiguredUpdateDiscardObjects.consume,
    "trigger",
    DISCARD_TABLE,
    v2ConfiguredUpdateDiscardSchema.consume,
  ],
] as const);

const schemaReadySql = `SELECT name, type, tbl_name, sql FROM sqlite_schema
  WHERE name IN (?, ?, ?, ?, ?)`;

function schemaReady(rows: readonly Record<string, unknown>[]): boolean {
  return (
    rows.length === DISCARD_SCHEMA.length &&
    DISCARD_SCHEMA.every(([name, type, table, ddl]) =>
      rows.some(
        (row) =>
          row.name === name && row.type === type && row.tbl_name === table && row.sql === ddl,
      ),
    )
  );
}

/**
 * Backend-only exact-row discard. The required trusted owner callback must
 * re-read the physical coordinator/native retirement original and throw for
 * unknown, missing, ambiguous or still-serving revisions. It is deliberately
 * not a caller-supplied boolean/lease/receipt or a public authority grant.
 * Core independently fences accepted-map/currentness in the atomic SQL batch.
 */
export function createV2RetiredConfiguredUpdateDiscard(options: {
  readonly sql: Sql;
  readonly assertRetired: (input: V2RetiredConfiguredUpdateInput) => Promise<void>;
}): {
  readonly discard: (input: V2RetiredConfiguredUpdateInput) => Promise<void>;
} {
  if (
    !options?.sql ||
    typeof options.sql.query !== "function" ||
    typeof options.sql.batch !== "function" ||
    typeof options.assertRetired !== "function"
  )
    discardUnavailable();
  const query = options.sql.query.bind(options.sql);
  const batch = options.sql.batch.bind(options.sql);
  const assertRetired = options.assertRetired.bind(options);

  return Object.freeze({
    async discard(value: V2RetiredConfiguredUpdateInput): Promise<void> {
      const input = captureDiscardInput(value);
      const schemaNames = DISCARD_SCHEMA.map(([name]) => name);
      try {
        if (!schemaReady(await query(schemaReadySql, schemaNames))) discardUnavailable();
      } catch {
        discardUnavailable();
      }
      try {
        if ((await assertRetired(input)) !== undefined) discardUnavailable();
      } catch {
        discardUnavailable();
      }
      const params = [
        input.operationId,
        input.resourceUid,
        input.generation,
        input.principal,
        input.space,
        input.name,
        input.form,
        input.backendId,
        input.targetKey,
      ] as const;
      let writes: Awaited<ReturnType<Sql["batch"]>>;
      try {
        writes = await batch([
          {
            sql: `INSERT INTO ${DISCARD_GATE}
            (operation_id, resource_uid, generation, principal, space, name, form_url, backend_id, target_key)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE (SELECT COUNT(*) FROM sqlite_schema WHERE
              (name = ? AND type = 'table' AND tbl_name = ? AND sql = ?) OR
              (name = ? AND type = 'index' AND tbl_name = ? AND sql = ?) OR
              (name = ? AND type = 'trigger' AND tbl_name = ? AND sql = ?) OR
              (name = ? AND type = 'trigger' AND tbl_name = ? AND sql = ?) OR
              (name = ? AND type = 'trigger' AND tbl_name = ? AND sql = ?)) = 5`,
            params: [
              ...params,
              ...DISCARD_SCHEMA.flatMap(([name, _type, table, ddl]) => [name, table, ddl]),
            ],
          },
          {
            sql: `DELETE FROM ${DISCARD_TABLE}
            WHERE operation_id = ? AND resource_uid = ? AND generation = ?
              AND EXISTS (SELECT 1 FROM ${DISCARD_GATE} gate
                WHERE gate.operation_id = ? AND gate.resource_uid = ? AND gate.generation = ?
                  AND gate.principal = ? AND gate.space = ? AND gate.name = ?
                  AND gate.form_url = ? AND gate.backend_id = ? AND gate.target_key = ?)`,
            params: [input.operationId, input.resourceUid, input.generation, ...params],
          },
          {
            // Failed or zero-row DELETE must roll the gate insertion back.
            sql: `INSERT INTO ${DISCARD_GATE} (operation_id) SELECT NULL
              WHERE EXISTS (SELECT 1 FROM ${DISCARD_GATE}
                WHERE operation_id = ? AND resource_uid = ? AND generation = ?)`,
            params: [input.operationId, input.resourceUid, input.generation],
          },
        ]);
      } catch {
        discardUnavailable();
      }
      if (writes.length !== 3 || writes[0]?.changes !== 1 || writes[1]?.changes !== 1)
        discardUnavailable();
    },
  });
}
