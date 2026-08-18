import type { Clock, Row, Sql } from "../ports.ts";
import { OPERATION_TTL_MILLISECONDS, REPLAY_TTL_MILLISECONDS, SWEEP_ROW_LIMIT } from "./limits.ts";
import type { TakoformStoredResource } from "./types.ts";

/**
 * Durable Takoform state.
 *
 * A resource row stores the wire document whole, because that document *is* the
 * contract; columns exist only where something is queried, fenced, or made
 * unique. That keeps the schema honest — every column earns its place — and
 * means a wire field can be added without a migration.
 *
 * Writes are guarded rather than transactional. D1 has no interactive
 * transaction, so a fence is carried in the `WHERE` clause of the write itself
 * and confirmed through the changed-row count. This closes a race the in-memory
 * predecessor had: it checked a fence, awaited the provider, and only then
 * wrote, leaving a window in which two concurrent applies could both pass the
 * same fence.
 */

export interface ResourceAddress {
  readonly tenantId: string;
  readonly space: string;
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
}

export interface StoredPrepare {
  readonly fingerprint: string;
  readonly expectedGeneration?: string;
  readonly currentUid?: string;
}

export interface OperationRecord {
  readonly id: string;
  readonly operation: string;
  readonly state: "succeeded" | "failed";
  readonly createdAt: string;
  readonly resource?: TakoformStoredResource;
}

/** A resource as an inventory shows it: address, lineage, and last movement. */
export interface ResourceListing {
  readonly space: string;
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
  readonly uid: string;
  readonly generation: string;
  readonly revision: string;
  readonly nativeId: string | null;
  readonly updatedAt: string;
  readonly resource: TakoformStoredResource;
}

export interface OperationListing {
  readonly id: string;
  readonly operation: string;
  readonly state: string;
  readonly createdAt: string;
}

export interface StoredReplay {
  readonly fingerprint: string;
  readonly status: number;
  readonly resource?: TakoformStoredResource;
  readonly boundUid?: string;
}

export interface TakoformStore {
  readResource(address: ResourceAddress): Promise<TakoformStoredResource | null>;
  /**
   * Writes a resource under an optimistic fence. `expectedRevision` is null for
   * a create, which then requires the row to be absent. Returns false when the
   * fence lost, meaning another writer moved the resource first.
   */
  writeResource(input: {
    readonly address: ResourceAddress;
    readonly resource: TakoformStoredResource;
    readonly expectedRevision: string | null;
    readonly nativeId?: string | undefined;
  }): Promise<boolean>;
  deleteResource(address: ResourceAddress, expectedRevision: string): Promise<boolean>;
  /** The address currently claiming a native id within a tenant, if any. */
  nativeClaim(tenantId: string, nativeId: string): Promise<ResourceAddress | null>;
  nativeIdOf(address: ResourceAddress): Promise<string | null>;

  putPrepare(
    tenantId: string,
    prepareDigest: string,
    prepare: StoredPrepare,
    expiresAt: number,
  ): Promise<void>;
  readPrepare(tenantId: string, prepareDigest: string): Promise<StoredPrepare | null>;

  /**
   * Records a settled operation so `GET /operations/{id}` can answer with the
   * truth. Every mutation writes one, including the synchronous ones, because a
   * caller cannot tell from the outside which kind it made.
   */
  putOperation(tenantId: string, record: OperationRecord): Promise<void>;
  readOperation(tenantId: string, id: string): Promise<OperationRecord | null>;

  /**
   * Resources whose Form is no longer installed.
   *
   * These are not broken rows — they are declarations the Host can no longer
   * resolve, so the customer cannot read, update, or delete them while the
   * backend resource keeps running and keeps billing. It happens when a Form's
   * schema is changed without minting a new definition version, and it is
   * silent unless something looks for it.
   */
  orphanedResources(
    installedDigests: readonly string[],
    limit: number,
  ): Promise<readonly { readonly space: string; readonly name: string; readonly kind: string }[]>;

  /**
   * One page of a tenant's resources, newest change first.
   *
   * The exact-pin lanes address a resource by its full quad, which is the right
   * shape for a machine that already knows what it declared and the wrong shape
   * for a person asking what they have. Paging is keyed on `(updated_at, uid)`
   * rather than an offset so a concurrent write cannot make a row appear twice
   * or vanish across pages.
   */
  listResources(
    tenantId: string,
    options: {
      readonly space?: string | undefined;
      readonly limit: number;
      readonly cursor?: string | undefined;
    },
  ): Promise<{ readonly resources: readonly ResourceListing[]; readonly cursor: string | null }>;

  /** Exact resource lookup for a credential broker; a uid is not a list cursor. */
  resourceByUid(tenantId: string, uid: string): Promise<ResourceListing | null>;

  /** The most recent settled operations for a tenant, newest first. */
  listOperations(tenantId: string, limit: number): Promise<readonly OperationListing[]>;

  readReplay(key: string): Promise<StoredReplay | null>;
  putReplay(key: string, replay: StoredReplay): Promise<void>;
  deleteReplay(key: string): Promise<void>;
}

export function createTakoformStore(sql: Sql, clock: Clock): TakoformStore {
  const now = (): number => clock().getTime();

  return {
    async readResource(address): Promise<TakoformStoredResource | null> {
      const rows = await sql.query(
        `SELECT resource_json FROM tf_resources
         WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?`,
        [address.tenantId, address.space, address.apiVersion, address.kind, address.name],
      );
      const row = rows[0];
      return row ? (JSON.parse(text(row.resource_json)) as TakoformStoredResource) : null;
    },

    async writeResource({ address, resource, expectedRevision, nativeId }): Promise<boolean> {
      const key = [address.tenantId, address.space, address.apiVersion, address.kind, address.name];
      if (expectedRevision === null) {
        const written = await sql.run(
          `INSERT OR IGNORE INTO tf_resources
             (tenant_id, space, api_version, kind, name, uid, generation, revision,
              resource_json, native_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ...key,
            resource.metadata.uid,
            resource.metadata.generation,
            resource.metadata.revision,
            JSON.stringify(resource),
            nativeId ?? null,
            now(),
          ],
        );
        return written.changes === 1;
      }
      const written = await sql.run(
        `UPDATE tf_resources
         SET uid = ?, generation = ?, revision = ?, resource_json = ?, native_id = ?, updated_at = ?
         WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?
           AND revision = ?`,
        [
          resource.metadata.uid,
          resource.metadata.generation,
          resource.metadata.revision,
          JSON.stringify(resource),
          nativeId ?? null,
          now(),
          ...key,
          expectedRevision,
        ],
      );
      return written.changes === 1;
    },

    async deleteResource(address, expectedRevision): Promise<boolean> {
      const written = await sql.run(
        `DELETE FROM tf_resources
         WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?
           AND revision = ?`,
        [
          address.tenantId,
          address.space,
          address.apiVersion,
          address.kind,
          address.name,
          expectedRevision,
        ],
      );
      return written.changes === 1;
    },

    async nativeClaim(tenantId, nativeId): Promise<ResourceAddress | null> {
      const rows = await sql.query(
        `SELECT space, api_version, kind, name FROM tf_resources
         WHERE tenant_id = ? AND native_id = ?`,
        [tenantId, nativeId],
      );
      const row = rows[0];
      return row
        ? {
            tenantId,
            space: text(row.space),
            apiVersion: text(row.api_version),
            kind: text(row.kind),
            name: text(row.name),
          }
        : null;
    },

    async nativeIdOf(address): Promise<string | null> {
      const rows = await sql.query(
        `SELECT native_id FROM tf_resources
         WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?`,
        [address.tenantId, address.space, address.apiVersion, address.kind, address.name],
      );
      const value = rows[0]?.native_id;
      return typeof value === "string" ? value : null;
    },

    async putPrepare(tenantId, prepareDigest, prepare, expiresAt): Promise<void> {
      // Expired reviews are swept opportunistically and in bounded batches, so
      // the table cannot grow without limit and no single request pays for a
      // full scan.
      await sql.run(
        `DELETE FROM tf_prepares WHERE rowid IN (
           SELECT rowid FROM tf_prepares WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
         )`,
        [now(), SWEEP_ROW_LIMIT],
      );
      await sql.run(
        `INSERT INTO tf_prepares
           (tenant_id, prepare_digest, fingerprint, expected_generation, current_uid, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, prepare_digest) DO UPDATE SET
           fingerprint = excluded.fingerprint,
           expected_generation = excluded.expected_generation,
           current_uid = excluded.current_uid,
           expires_at = excluded.expires_at`,
        [
          tenantId,
          prepareDigest,
          prepare.fingerprint,
          prepare.expectedGeneration ?? null,
          prepare.currentUid ?? null,
          expiresAt,
        ],
      );
    },

    async readPrepare(tenantId, prepareDigest): Promise<StoredPrepare | null> {
      const rows = await sql.query(
        `SELECT fingerprint, expected_generation, current_uid FROM tf_prepares
         WHERE tenant_id = ? AND prepare_digest = ? AND expires_at > ?`,
        [tenantId, prepareDigest, now()],
      );
      const row = rows[0];
      if (!row) return null;
      const expectedGeneration = row.expected_generation;
      const currentUid = row.current_uid;
      return {
        fingerprint: text(row.fingerprint),
        ...(typeof expectedGeneration === "string" ? { expectedGeneration } : {}),
        ...(typeof currentUid === "string" ? { currentUid } : {}),
      };
    },

    async putOperation(tenantId, record): Promise<void> {
      await sql.run(
        `DELETE FROM tf_operations WHERE rowid IN (
           SELECT rowid FROM tf_operations WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
         )`,
        [now(), SWEEP_ROW_LIMIT],
      );
      await sql.run(
        `INSERT OR IGNORE INTO tf_operations
           (id, tenant_id, operation, state, resource_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          tenantId,
          record.operation,
          record.state,
          record.resource ? JSON.stringify(record.resource) : null,
          record.createdAt,
          now() + OPERATION_TTL_MILLISECONDS,
        ],
      );
    },

    async readOperation(tenantId, id): Promise<OperationRecord | null> {
      const rows = await sql.query(
        `SELECT id, operation, state, resource_json, created_at FROM tf_operations
         WHERE tenant_id = ? AND id = ? AND expires_at > ?`,
        [tenantId, id, now()],
      );
      const row = rows[0];
      if (!row) return null;
      const resourceJson = row.resource_json;
      return {
        id: text(row.id),
        operation: text(row.operation),
        state: text(row.state) === "failed" ? "failed" : "succeeded",
        createdAt: text(row.created_at),
        ...(typeof resourceJson === "string"
          ? { resource: JSON.parse(resourceJson) as TakoformStoredResource }
          : {}),
      };
    },

    async orphanedResources(installedDigests, limit) {
      if (installedDigests.length === 0) return [];
      const placeholders = installedDigests.map(() => "?").join(", ");
      const rows = await sql.query(
        `SELECT space, name, kind FROM tf_resources
         WHERE json_extract(resource_json, '$.form.formRef.schemaDigest') NOT IN (${placeholders})
         ORDER BY updated_at DESC LIMIT ?`,
        [...installedDigests, limit],
      );
      return rows.map((row) => ({
        space: text(row.space),
        name: text(row.name),
        kind: text(row.kind),
      }));
    },

    async listResources(tenantId, { space, limit, cursor }) {
      const page = Math.min(Math.max(limit, 1), 200);
      const seek = decodeCursor(cursor);
      const rows = await sql.query(
        `SELECT space, api_version, kind, name, uid, generation, revision, native_id,
                updated_at, resource_json
         FROM tf_resources
         WHERE tenant_id = ?
           ${space === undefined ? "" : "AND space = ?"}
           ${seek === null ? "" : "AND (updated_at < ? OR (updated_at = ? AND uid < ?))"}
         ORDER BY updated_at DESC, uid DESC
         LIMIT ?`,
        [
          tenantId,
          ...(space === undefined ? [] : [space]),
          ...(seek === null ? [] : [seek.updatedAt, seek.updatedAt, seek.uid]),
          page + 1,
        ],
      );
      // One row past the page is read only to learn whether another page
      // exists. Handing back a cursor that leads nowhere is worse than none.
      const visible = rows.slice(0, page);
      const last = visible[visible.length - 1];
      return {
        resources: visible.map(resourceListing),
        cursor:
          rows.length > page && last
            ? encodeCursor({ updatedAt: Number(last.updated_at), uid: text(last.uid) })
            : null,
      };
    },

    async resourceByUid(tenantId, uid) {
      // LIMIT 2 is an integrity check: uid generation is expected to be unique,
      // but old schemas did not enforce it. Ambiguity must never mint reach to
      // one arbitrary backend resource.
      const rows = await sql.query(
        `SELECT space, api_version, kind, name, uid, generation, revision, native_id,
                updated_at, resource_json
         FROM tf_resources
         WHERE tenant_id = ? AND uid = ?
         LIMIT 2`,
        [tenantId, uid],
      );
      if (rows.length === 0) return null;
      if (rows.length !== 1) throw new Error("duplicate_resource_uid");
      return resourceListing(rows[0] as Row);
    },

    async listOperations(tenantId, limit) {
      const rows = await sql.query(
        `SELECT id, operation, state, created_at FROM tf_operations
         WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
        [tenantId, Math.min(Math.max(limit, 1), 200)],
      );
      return rows.map((row) => ({
        id: text(row.id),
        operation: text(row.operation),
        state: text(row.state),
        createdAt: text(row.created_at),
      }));
    },

    async readReplay(key): Promise<StoredReplay | null> {
      const rows = await sql.query(
        "SELECT fingerprint, status, resource_json, bound_uid FROM tf_replays WHERE replay_key = ? AND expires_at > ?",
        [key, now()],
      );
      const row = rows[0];
      if (!row) return null;
      const resourceJson = row.resource_json;
      const boundUid = row.bound_uid;
      return {
        fingerprint: text(row.fingerprint),
        status: Number(row.status),
        ...(typeof resourceJson === "string"
          ? { resource: JSON.parse(resourceJson) as TakoformStoredResource }
          : {}),
        ...(typeof boundUid === "string" ? { boundUid } : {}),
      };
    },

    async putReplay(key, replay): Promise<void> {
      await sql.run(
        `DELETE FROM tf_replays WHERE rowid IN (
           SELECT rowid FROM tf_replays WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
         )`,
        [now(), SWEEP_ROW_LIMIT],
      );
      await sql.run(
        `INSERT INTO tf_replays (replay_key, fingerprint, status, resource_json, bound_uid, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (replay_key) DO UPDATE SET
           fingerprint = excluded.fingerprint,
           status = excluded.status,
           resource_json = excluded.resource_json,
           bound_uid = excluded.bound_uid,
           expires_at = excluded.expires_at`,
        [
          key,
          replay.fingerprint,
          replay.status,
          replay.resource ? JSON.stringify(replay.resource) : null,
          replay.boundUid ?? null,
          now() + REPLAY_TTL_MILLISECONDS,
        ],
      );
    },

    async deleteReplay(key): Promise<void> {
      await sql.run("DELETE FROM tf_replays WHERE replay_key = ?", [key]);
    },
  };
}

function resourceListing(row: Row): ResourceListing {
  return {
    space: text(row.space),
    apiVersion: text(row.api_version),
    kind: text(row.kind),
    name: text(row.name),
    uid: text(row.uid),
    generation: text(row.generation),
    revision: text(row.revision),
    nativeId: row.native_id === null || row.native_id === undefined ? null : text(row.native_id),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    resource: JSON.parse(text(row.resource_json)) as TakoformStoredResource,
  };
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("expected a text column");
  return value;
}

/**
 * Page cursors carry the sort key, not an offset.
 *
 * An opaque string keeps a caller from treating it as a position they may
 * compute, and an unreadable one is ignored, which reads as "start from the
 * beginning" rather than an error a person can do nothing about.
 */
function encodeCursor(seek: { readonly updatedAt: number; readonly uid: string }): string {
  return btoa(`${seek.updatedAt}:${seek.uid}`)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursor(
  cursor: string | undefined,
): { readonly updatedAt: number; readonly uid: string } | null {
  if (cursor === undefined || cursor === "") return null;
  let decoded: string;
  try {
    decoded = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  const updatedAt = Number(decoded.slice(0, separator));
  const uid = decoded.slice(separator + 1);
  if (separator < 1 || !Number.isSafeInteger(updatedAt) || uid === "") return null;
  return { updatedAt, uid };
}
