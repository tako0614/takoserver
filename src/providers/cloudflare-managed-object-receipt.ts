export const MANAGED_OBJECT_RECEIPT_AUTHORITY_SCHEMA =
  "takoserver.managed-object-receipt-authority@v1" as const;
export const MANAGED_OBJECT_RECEIPT_INTERNAL_SCHEMA_VERSION = 2 as const;
export const MANAGED_OBJECT_RECEIPT_RUNTIME_PROOF_BINDING =
  "TAKOSERVER_MANAGED_OBJECT_PROOF_SECRET" as const;

const MANAGED_OBJECT_RUNTIME_PROOF_LABEL = "takoserver.managed-object-runtime-proof@v1";
const MANAGED_OBJECT_ADMIN_PROOF_LABEL = "takoserver.managed-object-admin-proof@v1";

export interface ManagedObjectReceiptAuthority {
  readonly schema: typeof MANAGED_OBJECT_RECEIPT_AUTHORITY_SCHEMA;
  readonly providerId: string;
  readonly resourceUid: string;
  /** Provider deployment identity. Replacements never inherit an old ledger. */
  readonly incarnationId: string;
  /** Positive Host Resource generation. */
  readonly generation: string;
}

type ManagedObjectReceiptStorageValue = string | number | null;

interface ManagedObjectReceiptStorageCursor<
  T extends Record<string, ManagedObjectReceiptStorageValue>,
> {
  toArray(): T[];
  readonly rowsWritten: number;
}

export interface ManagedObjectReceiptStorage {
  exec<T extends Record<string, ManagedObjectReceiptStorageValue>>(
    query: string,
    ...bindings: ManagedObjectReceiptStorageValue[]
  ): ManagedObjectReceiptStorageCursor<T>;
}

export interface ManagedObjectReceiptState {
  readonly storage: {
    readonly sql: ManagedObjectReceiptStorage;
    transactionSync<T>(callback: () => T): T;
    setAlarm?(scheduledTime: number | Date): Promise<void>;
    getAlarm?(): Promise<number | null>;
    deleteAlarm?(): Promise<void>;
    deleteAll?(): Promise<void>;
  };
}

export type ManagedObjectReceiptErrorCode =
  | "invalid_argument"
  | "conflict"
  | "not_found"
  | "invalid_part"
  | "value_too_large"
  | "backend_unavailable";

export type ManagedObjectReceiptLifecycleState =
  | "preparing"
  | "creating"
  | "create_reconciling"
  | "active"
  | "completing"
  | "completion_reconciling"
  | "completed"
  | "aborting"
  | "aborted"
  | "operator_reconciliation_required"
  | "destroying";

export type ManagedObjectReceiptAdminOperation = "inspect" | "prepare-destroy" | "commit-destroy";

export type ManagedObjectReceiptResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: ManagedObjectReceiptErrorCode } };

export interface ManagedObjectReceiptPart {
  readonly partNumber: number;
  readonly etag: string;
}

const MAX_OBJECT_KEY_BYTES = 979;
const MAX_OBJECT_BYTES = 5_368_709_120;
const MAX_OBJECT_PARTS = 10_000;
const MIN_NON_FINAL_PART_BYTES = 5_242_880;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u;
const RECEIPT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,511}$/u;
const MARKER = /^[A-Za-z0-9_-]{43}$/u;
const GENERATION = /^[1-9][0-9]{0,18}$/u;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const PROOF = /^[A-Za-z0-9_-]{43}$/u;
const AUTHORITY_COLUMNS = "provider_id, resource_uid, incarnation_id, resource_generation" as const;
const DAY_MS = 24 * 60 * 60 * 1_000;
export const MANAGED_OBJECT_ACTIVE_RETENTION_MS = 7 * DAY_MS;
export const MANAGED_OBJECT_TERMINAL_RETENTION_MS = 7 * DAY_MS;
export const MANAGED_OBJECT_ALARM_BATCH = 64;
const MAX_DISCOVERED_UPLOADS = 256;

interface AuthorityRow extends Record<string, ManagedObjectReceiptStorageValue> {
  readonly provider_id: string;
  readonly resource_uid: string;
  readonly incarnation_id: string;
  readonly resource_generation: string;
}

interface UploadRow extends Record<string, ManagedObjectReceiptStorageValue> {
  readonly receipt_id: string;
  readonly object_key: string;
  readonly marker: string;
  readonly content_type: string | null;
  readonly native_upload_id: string | null;
  readonly state: string;
  readonly completion_parts: string | null;
  readonly expected_size: number | null;
  readonly completed_etag: string | null;
  readonly completed_size: number | null;
  readonly baseline_upload_ids: string | null;
  readonly create_granted: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly terminal_at: number | null;
  readonly next_action_at: number | null;
  readonly attempts: number;
}

interface ControlRow extends Record<string, ManagedObjectReceiptStorageValue> {
  readonly lifecycle: string;
  readonly bucket_name: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface PartRow extends Record<string, ManagedObjectReceiptStorageValue> {
  readonly state: string;
  readonly attempt_id: string;
  readonly etag: string | null;
  readonly expected_size: number | null;
  readonly size: number | null;
  readonly previous_etag: string | null;
  readonly previous_size: number | null;
}

/**
 * A bounded opaque DO identity selected only from provider-owned identity.
 * Bucket display names and R2 native names are deliberately absent.
 */
export async function managedObjectReceiptInstanceName(
  authority: ManagedObjectReceiptAuthority,
): Promise<string> {
  if (!validAuthority(authority)) throw new TypeError("invalid managed ObjectBucket authority");
  const payload = [
    authority.providerId,
    authority.resourceUid,
    authority.incarnationId,
    authority.generation,
  ]
    .map((part) => `${new TextEncoder().encode(part).byteLength}:${part}`)
    .join("|");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)),
  );
  return `tsobj-${base64Url(digest).slice(0, 43)}`;
}

/** HMAC capability handed only to the exact generated Worker binding closure. */
export async function managedObjectReceiptRuntimeProof(input: {
  readonly secret: string;
  readonly authority: ManagedObjectReceiptAuthority;
  readonly bucketName: string;
}): Promise<string> {
  if (!token(input.secret) || !validAuthority(input.authority) || !bucketName(input.bucketName)) {
    throw new TypeError("invalid managed ObjectBucket runtime proof input");
  }
  return await hmacProof(input.secret, [
    MANAGED_OBJECT_RUNTIME_PROOF_LABEL,
    ...authorityProofParts(input.authority),
    input.bucketName,
  ]);
}

/** Admin proofs are operation-scoped; runtime authority can never become destroy authority. */
export async function managedObjectReceiptAdminProof(input: {
  readonly secret: string;
  readonly operation: ManagedObjectReceiptAdminOperation;
  readonly authority: ManagedObjectReceiptAuthority;
  readonly bucketName: string;
}): Promise<string> {
  if (
    !token(input.secret) ||
    !["inspect", "prepare-destroy", "commit-destroy"].includes(input.operation) ||
    !validAuthority(input.authority) ||
    !bucketName(input.bucketName)
  ) {
    throw new TypeError("invalid managed ObjectBucket admin proof input");
  }
  return await hmacProof(input.secret, [
    MANAGED_OBJECT_ADMIN_PROOF_LABEL,
    input.operation,
    ...authorityProofParts(input.authority),
    input.bucketName,
  ]);
}

export async function verifyManagedObjectReceiptRuntimeProof(input: {
  readonly secret: string;
  readonly proof: string;
  readonly authority: ManagedObjectReceiptAuthority;
  readonly bucketName: string;
}): Promise<boolean> {
  if (!PROOF.test(input.proof)) return false;
  try {
    return sameProof(
      await managedObjectReceiptRuntimeProof({
        secret: input.secret,
        authority: input.authority,
        bucketName: input.bucketName,
      }),
      input.proof,
    );
  } catch {
    return false;
  }
}

export async function verifyManagedObjectReceiptAdminProof(input: {
  readonly secret: string;
  readonly proof: string;
  readonly operation: ManagedObjectReceiptAdminOperation;
  readonly authority: ManagedObjectReceiptAuthority;
  readonly bucketName: string;
}): Promise<boolean> {
  if (!PROOF.test(input.proof)) return false;
  try {
    return sameProof(
      await managedObjectReceiptAdminProof({
        secret: input.secret,
        operation: input.operation,
        authority: input.authority,
        bucketName: input.bucketName,
      }),
      input.proof,
    );
  } catch {
    return false;
  }
}

/** Durable multipart lifecycle. All methods are closed RPC shapes. */
export class ManagedObjectReceiptCore {
  readonly #state: ManagedObjectReceiptState;
  readonly #sql: ManagedObjectReceiptStorage;
  readonly #now: () => number;
  #initialized = false;

  constructor(
    state: ManagedObjectReceiptState,
    options: { readonly now?: () => number; readonly initialize?: boolean } = {},
  ) {
    this.#state = state;
    this.#sql = state.storage.sql;
    this.#now = options.now ?? (() => Date.now());
    if (options.initialize !== false) this.#ensureSchema();
  }

  beginCreate(raw: unknown): ManagedObjectReceiptResult<{
    readonly state:
      | "preparing"
      | "active"
      | "create_reconciling"
      | "operator_reconciliation_required";
  }> {
    const input = createInput(raw);
    if (!input) return failure("invalid_argument");
    return this.#safely<{
      readonly state:
        | "preparing"
        | "active"
        | "create_reconciling"
        | "operator_reconciliation_required";
    }>(() =>
      this.#state.storage.transactionSync(() => {
        const authority = this.#claimAuthority(input.authority, input.bucketName);
        if (authority !== "ok") return failure(authority);
        const current = this.#upload(input.receiptId);
        if (current) {
          if (!sameCreate(current, input)) return failure("conflict");
          if (current.state === "active") return success({ state: "active" as const });
          if (current.state === "create_reconciling") {
            return success({ state: "create_reconciling" as const });
          }
          if (current.state === "operator_reconciliation_required") {
            return success({ state: "operator_reconciliation_required" as const });
          }
          // A preparing row has not received a native-create grant. A creating
          // row has. Neither retry gets a second grant or a second native call.
          return current.state === "preparing"
            ? success({ state: "preparing" as const })
            : failure("conflict");
        }
        const unresolved = this.#sql
          .exec<{ readonly total: number }>(
            `SELECT count(*) AS total FROM managed_object_uploads
             WHERE object_key = ? AND state NOT IN ('completed','aborted')`,
            input.key,
          )
          .toArray()[0]?.total;
        if (unresolved !== 0) return failure("conflict");
        const now = this.#time();
        this.#sql.exec(
          `INSERT INTO managed_object_uploads
             (receipt_id, object_key, marker, content_type, state,
              create_granted, created_at, updated_at, next_action_at, attempts)
           VALUES (?, ?, ?, ?, 'preparing', 0, ?, ?, ?, 0)`,
          input.receiptId,
          input.key,
          input.marker,
          input.contentType,
          now,
          now,
          now + 1_000,
        );
        this.#sql.exec(
          "INSERT INTO managed_object_key_fences (object_key, receipt_id) VALUES (?, ?)",
          input.key,
          input.receiptId,
        );
        return success({ state: "preparing" as const });
      }),
    );
  }

  /** Persist the exact baseline and atomically issue the one native-create grant. */
  grantCreate(raw: unknown): ManagedObjectReceiptResult<{ readonly action: "execute" }> {
    const input = createGrantInput(raw);
    if (!input) return failure("invalid_argument");
    return this.#safely(() =>
      this.#state.storage.transactionSync(() => {
        if (!this.#runtimeAuthorityMatches(input.authority, input.bucketName)) {
          return failure("conflict");
        }
        const current = this.#upload(input.receiptId);
        if (!current || !sameCreate(current, input) || current.state !== "preparing") {
          return failure("conflict");
        }
        const now = this.#time();
        this.#sql.exec(
          `UPDATE managed_object_uploads
           SET state = 'creating', baseline_upload_ids = ?, create_granted = 1,
               updated_at = ?, next_action_at = ?, attempts = attempts + 1
           WHERE receipt_id = ? AND state = 'preparing' AND create_granted = 0`,
          JSON.stringify(input.baselineUploadIds),
          now,
          now + 1_000,
          input.receiptId,
        );
        return success({ action: "execute" as const });
      }),
    );
  }

  /** Resolve a create only from a provider-owned list delta against the persisted baseline. */
  resolveCreate(
    raw: unknown,
  ): ManagedObjectReceiptResult<
    | { readonly action: "active"; readonly nativeUploadId: string }
    | { readonly action: "abort"; readonly nativeUploadId: string }
    | { readonly action: "retry" }
    | { readonly action: "aborted" }
    | { readonly action: "operator_reconciliation_required" }
  > {
    const input = createResolutionInput(raw);
    if (!input) return failure("invalid_argument");
    return this.#safely<
      | { readonly action: "active"; readonly nativeUploadId: string }
      | { readonly action: "abort"; readonly nativeUploadId: string }
      | { readonly action: "retry" }
      | { readonly action: "aborted" }
      | { readonly action: "operator_reconciliation_required" }
    >(() =>
      this.#state.storage.transactionSync(() => {
        if (!this.#runtimeAuthorityMatches(input.authority, input.bucketName)) {
          return failure("conflict");
        }
        const upload = this.#upload(input.receiptId);
        if (
          !upload ||
          !sameCreate(upload, input) ||
          (upload.state !== "creating" && upload.state !== "create_reconciling") ||
          upload.create_granted !== 1 ||
          upload.baseline_upload_ids === null
        ) {
          return failure("conflict");
        }
        const baseline = uploadIdArray(upload.baseline_upload_ids);
        if (!baseline) return failure("backend_unavailable");
        const baselineSet = new Set(baseline);
        const delta = input.observedUploadIds.filter((candidate) => !baselineSet.has(candidate));
        const now = this.#time();
        if (
          delta.length > 1 ||
          (input.acknowledgedUploadId && delta[0] !== input.acknowledgedUploadId)
        ) {
          this.#sql.exec(
            `UPDATE managed_object_uploads
             SET state = 'operator_reconciliation_required', updated_at = ?,
                 next_action_at = NULL, attempts = attempts + 1
             WHERE receipt_id = ?`,
            now,
            input.receiptId,
          );
          return success({ action: "operator_reconciliation_required" as const });
        }
        if (delta.length === 1) {
          const nativeUploadId = delta[0] as string;
          const owner = this.#sql
            .exec<{ readonly receipt_id: string }>(
              "SELECT receipt_id FROM managed_object_native_upload_fences WHERE native_upload_id = ?",
              nativeUploadId,
            )
            .toArray()[0]?.receipt_id;
          if (owner !== undefined && owner !== input.receiptId) {
            this.#sql.exec(
              `UPDATE managed_object_uploads
               SET state = 'operator_reconciliation_required', updated_at = ?, next_action_at = NULL
               WHERE receipt_id = ?`,
              now,
              input.receiptId,
            );
            return success({ action: "operator_reconciliation_required" as const });
          }
          this.#sql.exec(
            "INSERT OR IGNORE INTO managed_object_native_upload_fences (native_upload_id, receipt_id) VALUES (?, ?)",
            nativeUploadId,
            input.receiptId,
          );
          const state = input.recovery ? "aborting" : "active";
          this.#sql.exec(
            `UPDATE managed_object_uploads
             SET native_upload_id = ?, state = ?, updated_at = ?, next_action_at = ?, attempts = attempts + 1
             WHERE receipt_id = ?`,
            nativeUploadId,
            state,
            now,
            input.recovery ? now : upload.created_at + MANAGED_OBJECT_ACTIVE_RETENTION_MS,
            input.receiptId,
          );
          return success({
            action: input.recovery ? ("abort" as const) : ("active" as const),
            nativeUploadId,
          });
        }
        if (input.definitiveFailure) {
          this.#terminal(input.receiptId, "aborted", now);
          return success({ action: "aborted" as const });
        }
        this.#sql.exec(
          `UPDATE managed_object_uploads
           SET state = 'create_reconciling', updated_at = ?, next_action_at = ?, attempts = attempts + 1
           WHERE receipt_id = ?`,
          now,
          now + createRetryDelay(upload.attempts + 1),
          input.receiptId,
        );
        return success({ action: "retry" as const });
      }),
    );
  }

  beginPart(raw: unknown): ManagedObjectReceiptResult<{
    readonly nativeUploadId: string;
    readonly attemptId: string;
  }> {
    const input = partAttemptInput(raw);
    if (!input) return failure("invalid_argument");
    return this.#safely(() =>
      this.#state.storage.transactionSync(() => {
        if (!this.#authorityMatches(input.authority)) return failure("conflict");
        const upload = this.#activeUpload(input.receiptId, input.key);
        if (!upload) return failure("not_found");
        const previous = this.#part(input.receiptId, input.partNumber);
        const previousEtag = previous?.state === "ready" ? previous.etag : previous?.previous_etag;
        const previousSize = previous?.state === "ready" ? previous.size : previous?.previous_size;
        this.#sql.exec(
          `INSERT INTO managed_object_parts
             (receipt_id, part_number, state, attempt_id, etag, expected_size, size, previous_etag, previous_size)
           VALUES (?, ?, 'uploading', ?, NULL, ?, NULL, ?, ?)
           ON CONFLICT(receipt_id, part_number) DO UPDATE SET
             state = 'uploading', attempt_id = excluded.attempt_id,
             etag = NULL, expected_size = excluded.expected_size, size = NULL,
             previous_etag = excluded.previous_etag,
             previous_size = excluded.previous_size`,
          input.receiptId,
          input.partNumber,
          input.attemptId,
          input.size,
          previousEtag ?? null,
          previousSize ?? null,
        );
        return success({
          nativeUploadId: upload.native_upload_id as string,
          attemptId: input.attemptId,
        });
      }),
    );
  }

  commitPart(
    raw: unknown,
  ): ManagedObjectReceiptResult<{ readonly etag: string; readonly partNumber: number }> {
    const input = committedPartInput(raw);
    if (!input) return failure("invalid_argument");
    return this.#safely(() =>
      this.#state.storage.transactionSync(() => {
        if (!this.#authorityMatches(input.authority)) return failure("conflict");
        const upload = this.#activeUpload(input.receiptId, input.key);
        if (!upload) return failure("not_found");
        const current = this.#part(input.receiptId, input.partNumber);
        if (
          current?.state === "ready" &&
          current.attempt_id === input.attemptId &&
          current.etag === input.etag &&
          current.expected_size === input.size &&
          current.size === input.size
        ) {
          return success({ etag: input.etag, partNumber: input.partNumber });
        }
        if (
          current?.state !== "uploading" ||
          current.attempt_id !== input.attemptId ||
          current.expected_size !== input.size ||
          input.size > MAX_OBJECT_BYTES
        ) {
          return failure("conflict");
        }
        this.#sql.exec(
          `UPDATE managed_object_parts
             SET state = 'ready', etag = ?, size = ?, previous_etag = NULL, previous_size = NULL
           WHERE receipt_id = ? AND part_number = ? AND state = 'uploading' AND attempt_id = ?`,
          input.etag,
          input.size,
          input.receiptId,
          input.partNumber,
          input.attemptId,
        );
        return success({ etag: input.etag, partNumber: input.partNumber });
      }),
    );
  }

  releasePart(raw: unknown): ManagedObjectReceiptResult<{ readonly state: "active" }> {
    const input = partAttemptInput(raw);
    if (!input) return failure("invalid_argument");
    return this.#safely(() =>
      this.#state.storage.transactionSync(() => {
        if (!this.#authorityMatches(input.authority)) return failure("conflict");
        if (!this.#activeUpload(input.receiptId, input.key)) return failure("not_found");
        const current = this.#part(input.receiptId, input.partNumber);
        if (current?.state !== "uploading" || current.attempt_id !== input.attemptId) {
          return failure("conflict");
        }
        if (current.previous_etag !== null && current.previous_size !== null) {
          this.#sql.exec(
            `UPDATE managed_object_parts
               SET state = 'ready', etag = previous_etag, size = previous_size,
                   previous_etag = NULL, previous_size = NULL
             WHERE receipt_id = ? AND part_number = ? AND attempt_id = ?`,
            input.receiptId,
            input.partNumber,
            input.attemptId,
          );
        } else {
          this.#sql.exec(
            "DELETE FROM managed_object_parts WHERE receipt_id = ? AND part_number = ? AND attempt_id = ?",
            input.receiptId,
            input.partNumber,
            input.attemptId,
          );
        }
        return success({ state: "active" as const });
      }),
    );
  }

  beginComplete(raw: unknown): ManagedObjectReceiptResult<
    | {
        readonly action: "execute" | "reconcile";
        readonly nativeUploadId: string;
        readonly marker: string;
        readonly expectedSize: number;
      }
    | { readonly action: "done"; readonly etag: string; readonly size: number }
  > {
    const input = completionInput(raw);
    if (!input) return failure("invalid_part");
    const serialized = JSON.stringify(input.parts);
    return this.#safely<
      | {
          readonly action: "execute" | "reconcile";
          readonly nativeUploadId: string;
          readonly marker: string;
          readonly expectedSize: number;
        }
      | { readonly action: "done"; readonly etag: string; readonly size: number }
    >(() =>
      this.#state.storage.transactionSync(() => {
        if (!this.#authorityMatches(input.authority)) return failure("conflict");
        const upload = this.#upload(input.receiptId);
        if (!upload || upload.object_key !== input.key || upload.state === "aborted") {
          return failure("not_found");
        }
        if (upload.state === "completed") {
          return upload.completion_parts === serialized &&
            upload.completed_etag !== null &&
            upload.completed_size !== null
            ? success({
                action: "done" as const,
                etag: upload.completed_etag,
                size: upload.completed_size,
              })
            : failure("invalid_part");
        }
        if (upload.state === "completion_reconciling") {
          return upload.completion_parts === serialized &&
            upload.native_upload_id !== null &&
            upload.expected_size !== null
            ? success({
                action: "reconcile" as const,
                nativeUploadId: upload.native_upload_id,
                marker: upload.marker,
                expectedSize: upload.expected_size,
              })
            : failure("conflict");
        }
        if (upload.state === "completing") {
          return upload.completion_parts === serialized &&
            upload.native_upload_id !== null &&
            upload.expected_size !== null
            ? success({
                action: "reconcile" as const,
                nativeUploadId: upload.native_upload_id,
                marker: upload.marker,
                expectedSize: upload.expected_size,
              })
            : failure("conflict");
        }
        if (upload.state !== "active" || upload.native_upload_id === null) {
          return failure("not_found");
        }
        const uploading = this.#sql
          .exec<{ readonly total: number }>(
            "SELECT count(*) AS total FROM managed_object_parts WHERE receipt_id = ? AND state != 'ready'",
            input.receiptId,
          )
          .toArray()[0]?.total;
        if (uploading !== 0) return failure("conflict");
        let total = 0;
        for (let index = 0; index < input.parts.length; index += 1) {
          const wanted = input.parts[index] as ManagedObjectReceiptPart;
          const recorded = this.#part(input.receiptId, wanted.partNumber);
          if (
            recorded?.state !== "ready" ||
            recorded.etag !== wanted.etag ||
            recorded.size === null ||
            (index < input.parts.length - 1 && recorded.size < MIN_NON_FINAL_PART_BYTES)
          ) {
            return failure("invalid_part");
          }
          if (recorded.size > MAX_OBJECT_BYTES - total) return failure("value_too_large");
          total += recorded.size;
        }
        const now = this.#time();
        this.#sql.exec(
          `UPDATE managed_object_uploads
             SET state = 'completing', completion_parts = ?, expected_size = ?,
                 updated_at = ?, next_action_at = ?
           WHERE receipt_id = ? AND state = 'active'`,
          serialized,
          total,
          now,
          now + 60_000,
          input.receiptId,
        );
        return success({
          action: "execute" as const,
          nativeUploadId: upload.native_upload_id,
          marker: upload.marker,
          expectedSize: total,
        });
      }),
    );
  }

  commitComplete(
    raw: unknown,
  ): ManagedObjectReceiptResult<{ readonly etag: string; readonly size: number }> {
    const input = completedInput(raw);
    if (!input) return failure("invalid_argument");
    const serialized = JSON.stringify(input.parts);
    return this.#safely(() =>
      this.#state.storage.transactionSync(() => {
        if (!this.#authorityMatches(input.authority)) return failure("conflict");
        const upload = this.#upload(input.receiptId);
        if (!upload || upload.object_key !== input.key) return failure("not_found");
        if (upload.state === "completed") {
          return upload.completion_parts === serialized &&
            upload.completed_etag === input.etag &&
            upload.completed_size === input.size
            ? success({ etag: input.etag, size: input.size })
            : failure("conflict");
        }
        if (
          (upload.state !== "completing" && upload.state !== "completion_reconciling") ||
          upload.completion_parts !== serialized ||
          upload.expected_size !== input.size
        ) {
          return failure("conflict");
        }
        const now = this.#time();
        this.#sql.exec(
          `UPDATE managed_object_uploads
           SET state = 'completed', completed_etag = ?, completed_size = ?,
               updated_at = ?, terminal_at = COALESCE(terminal_at, ?), next_action_at = ?
           WHERE receipt_id = ? AND state IN ('completing', 'completion_reconciling')`,
          input.etag,
          input.size,
          now,
          now,
          now + MANAGED_OBJECT_TERMINAL_RETENTION_MS,
          input.receiptId,
        );
        this.#sql.exec(
          "DELETE FROM managed_object_key_fences WHERE object_key = ? AND receipt_id = ?",
          upload.object_key,
          input.receiptId,
        );
        this.#sql.exec("DELETE FROM managed_object_parts WHERE receipt_id = ?", input.receiptId);
        return success({ etag: input.etag, size: input.size });
      }),
    );
  }

  failComplete(raw: unknown): ManagedObjectReceiptResult<{ readonly state: "active" }> {
    const input = completionInput(raw);
    if (!input) return failure("invalid_argument");
    const serialized = JSON.stringify(input.parts);
    return this.#safely(() =>
      this.#state.storage.transactionSync(() => {
        if (!this.#authorityMatches(input.authority)) return failure("conflict");
        const upload = this.#upload(input.receiptId);
        if (
          !upload ||
          upload.object_key !== input.key ||
          upload.state !== "completing" ||
          upload.completion_parts !== serialized
        ) {
          return failure("conflict");
        }
        const now = this.#time();
        this.#sql.exec(
          `UPDATE managed_object_uploads
             SET state = 'active', completion_parts = NULL, expected_size = NULL,
                 updated_at = ?, next_action_at = ?
           WHERE receipt_id = ? AND state = 'completing'`,
          now,
          upload.created_at + MANAGED_OBJECT_ACTIVE_RETENTION_MS,
          input.receiptId,
        );
        return success({ state: "active" as const });
      }),
    );
  }

  /**
   * Keep a completion in the provider-reconciliation lane instead of
   * reopening it for another native complete. This covers a definitive
   * native upload loss and a provider/object readback disagreement. The
   * marker/size remain durable so a later readback can still adopt a
   * completion whose acknowledgement was merely delayed; otherwise the only
   * recovery is an explicit abort.
   */
  markCompleteLost(
    raw: unknown,
  ): ManagedObjectReceiptResult<{ readonly state: "completion_reconciling" }> {
    const input = completionInput(raw);
    if (!input) return failure("invalid_part");
    const serialized = JSON.stringify(input.parts);
    return this.#safely(() =>
      this.#state.storage.transactionSync(() => {
        if (!this.#authorityMatches(input.authority)) return failure("conflict");
        const upload = this.#upload(input.receiptId);
        if (
          !upload ||
          upload.object_key !== input.key ||
          (upload.state !== "completing" && upload.state !== "completion_reconciling") ||
          upload.completion_parts !== serialized ||
          upload.native_upload_id === null ||
          upload.expected_size === null
        ) {
          return failure("conflict");
        }
        const now = this.#time();
        this.#sql.exec(
          `UPDATE managed_object_uploads
             SET state = 'completion_reconciling', updated_at = ?, next_action_at = ?
           WHERE receipt_id = ? AND state IN ('completing', 'completion_reconciling')`,
          now,
          now + 60_000,
          input.receiptId,
        );
        return success({ state: "completion_reconciling" as const });
      }),
    );
  }

  beginAbort(
    raw: unknown,
  ): ManagedObjectReceiptResult<
    | { readonly action: "execute"; readonly nativeUploadId: string; readonly marker: string }
    | { readonly action: "done" }
  > {
    const input = abortInput(raw);
    if (!input) return failure("invalid_argument");
    return this.#safely<
      | { readonly action: "execute"; readonly nativeUploadId: string; readonly marker: string }
      | { readonly action: "done" }
    >(() =>
      this.#state.storage.transactionSync(() => {
        if (!this.#authorityMatches(input.authority)) return failure("conflict");
        const upload = this.#upload(input.receiptId);
        if (!upload || upload.object_key !== input.key) return failure("not_found");
        if (upload.state === "aborted") return success({ action: "done" as const });
        if (
          input.nativeUploadId !== undefined &&
          upload.native_upload_id !== null &&
          upload.native_upload_id !== input.nativeUploadId
        ) {
          return failure("conflict");
        }
        if (upload.state === "preparing" && upload.native_upload_id === null) {
          if (input.nativeUploadId !== undefined) return failure("conflict");
          this.#terminal(input.receiptId, "aborted", this.#time());
          this.#sql.exec("DELETE FROM managed_object_parts WHERE receipt_id = ?", input.receiptId);
          return success({ action: "done" as const });
        }
        if (
          (upload.state === "active" || upload.state === "completion_reconciling") &&
          upload.native_upload_id !== null
        ) {
          const now = this.#time();
          this.#sql.exec(
            "UPDATE managed_object_uploads SET state = 'aborting', updated_at = ?, next_action_at = ? WHERE receipt_id = ? AND state IN ('active', 'completion_reconciling')",
            now,
            now,
            input.receiptId,
          );
          return success({
            action: "execute" as const,
            nativeUploadId: upload.native_upload_id,
            marker: upload.marker,
          });
        }
        if (upload.state === "aborting" && upload.native_upload_id !== null) {
          return success({
            action: "execute" as const,
            nativeUploadId: upload.native_upload_id,
            marker: upload.marker,
          });
        }
        return failure("conflict");
      }),
    );
  }

  commitAbort(raw: unknown): ManagedObjectReceiptResult<{ readonly state: "aborted" }> {
    const input = uploadIdentityInput(raw);
    if (!input) return failure("invalid_argument");
    return this.#safely(() =>
      this.#state.storage.transactionSync(() => {
        if (!this.#authorityMatches(input.authority)) return failure("conflict");
        const upload = this.#upload(input.receiptId);
        if (!upload || upload.object_key !== input.key) return failure("not_found");
        if (upload.state === "aborted") return success({ state: "aborted" as const });
        if (upload.state !== "aborting") return failure("conflict");
        this.#terminal(input.receiptId, "aborted", this.#time());
        this.#sql.exec("DELETE FROM managed_object_parts WHERE receipt_id = ?", input.receiptId);
        return success({ state: "aborted" as const });
      }),
    );
  }

  /** Provider/operator status. The permanent ambiguity fence is explicit and never GC'd. */
  inspect(): ManagedObjectReceiptResult<{
    readonly schemaVersion: typeof MANAGED_OBJECT_RECEIPT_INTERNAL_SCHEMA_VERSION;
    readonly lifecycle: "active" | "destroying";
    readonly authority: ManagedObjectReceiptAuthority | null;
    readonly bucketName: string | null;
    readonly receiptCount: number;
    readonly operatorReconciliationRequired: number;
    readonly nextActionAt: number | null;
  }> {
    return this.#safely(() => {
      const control = this.#control();
      const authority = this.#authority();
      const counts = this.#sql
        .exec<{ readonly total: number; readonly ambiguous: number }>(
          `SELECT count(*) AS total,
                  sum(CASE WHEN state = 'operator_reconciliation_required' THEN 1 ELSE 0 END) AS ambiguous
           FROM managed_object_uploads`,
        )
        .toArray()[0];
      const nextActionAt = this.#sql
        .exec<{ readonly next_action_at: number | null }>(
          "SELECT min(next_action_at) AS next_action_at FROM managed_object_uploads WHERE next_action_at IS NOT NULL",
        )
        .toArray()[0]?.next_action_at;
      return success({
        schemaVersion: MANAGED_OBJECT_RECEIPT_INTERNAL_SCHEMA_VERSION,
        lifecycle: control?.lifecycle === "destroying" ? "destroying" : "active",
        authority: authority
          ? {
              schema: MANAGED_OBJECT_RECEIPT_AUTHORITY_SCHEMA,
              providerId: authority.provider_id,
              resourceUid: authority.resource_uid,
              incarnationId: authority.incarnation_id,
              generation: authority.resource_generation,
            }
          : null,
        bucketName: control?.bucket_name ?? null,
        receiptCount: counts?.total ?? 0,
        operatorReconciliationRequired: counts?.ambiguous ?? 0,
        nextActionAt: nextActionAt ?? null,
      });
    });
  }

  dueReceipts(now = this.#time()): ManagedObjectReceiptResult<
    readonly {
      readonly receiptId: string;
      readonly key: string;
      readonly marker: string;
      readonly contentType: string | null;
      readonly nativeUploadId: string | null;
      readonly state: ManagedObjectReceiptLifecycleState;
      readonly baselineUploadIds: readonly string[] | null;
      readonly createdAt: number;
      readonly attempts: number;
    }[]
  > {
    if (!Number.isSafeInteger(now) || now < 0) return failure("invalid_argument");
    return this.#safely(() => {
      const rows = this.#sql
        .exec<UploadRow>(
          `SELECT receipt_id, object_key, marker, content_type, native_upload_id, state,
                  completion_parts, expected_size, completed_etag, completed_size,
                  baseline_upload_ids, create_granted, created_at, updated_at,
                  terminal_at, next_action_at, attempts
           FROM managed_object_uploads
           WHERE next_action_at IS NOT NULL AND next_action_at <= ?
           ORDER BY next_action_at, receipt_id LIMIT ?`,
          now,
          MANAGED_OBJECT_ALARM_BATCH,
        )
        .toArray();
      const due = [];
      for (const row of rows) {
        const baseline =
          row.baseline_upload_ids === null ? null : uploadIdArray(row.baseline_upload_ids);
        if (row.baseline_upload_ids !== null && !baseline) return failure("backend_unavailable");
        due.push({
          receiptId: row.receipt_id,
          key: row.object_key,
          marker: row.marker,
          contentType: row.content_type,
          nativeUploadId: row.native_upload_id,
          state: row.state as ManagedObjectReceiptLifecycleState,
          baselineUploadIds: baseline,
          createdAt: row.created_at,
          attempts: row.attempts,
        });
      }
      return success(due);
    });
  }

  rearmReceipt(receiptId: string, at: number): ManagedObjectReceiptResult<undefined> {
    if (!RECEIPT.test(receiptId) || !Number.isSafeInteger(at) || at < 0) {
      return failure("invalid_argument");
    }
    return this.#safely(() => {
      const now = this.#time();
      this.#sql.exec(
        `UPDATE managed_object_uploads SET updated_at = ?, next_action_at = ?, attempts = attempts + 1
         WHERE receipt_id = ? AND state NOT IN ('completed','aborted','operator_reconciliation_required','destroying')`,
        now,
        at,
        receiptId,
      );
      return success(undefined);
    });
  }

  requireOperator(receiptId: string): ManagedObjectReceiptResult<{
    readonly state: "operator_reconciliation_required";
  }> {
    if (!RECEIPT.test(receiptId)) return failure("invalid_argument");
    return this.#safely(() => {
      const row = this.#upload(receiptId);
      if (!row || row.state === "completed" || row.state === "aborted") return failure("conflict");
      this.#sql.exec(
        `UPDATE managed_object_uploads
         SET state = 'operator_reconciliation_required', updated_at = ?, next_action_at = NULL
         WHERE receipt_id = ?`,
        this.#time(),
        receiptId,
      );
      return success({ state: "operator_reconciliation_required" as const });
    });
  }

  gcTerminal(now = this.#time()): ManagedObjectReceiptResult<{ readonly deleted: number }> {
    if (!Number.isSafeInteger(now) || now < 0) return failure("invalid_argument");
    return this.#safely(() =>
      this.#state.storage.transactionSync(() => {
        const rows = this.#sql
          .exec<{ readonly receipt_id: string; readonly native_upload_id: string | null }>(
            `SELECT receipt_id, native_upload_id FROM managed_object_uploads
             WHERE state IN ('completed','aborted') AND terminal_at IS NOT NULL
               AND terminal_at + ? <= ?
             ORDER BY terminal_at, receipt_id LIMIT ?`,
            MANAGED_OBJECT_TERMINAL_RETENTION_MS,
            now,
            MANAGED_OBJECT_ALARM_BATCH,
          )
          .toArray();
        for (const row of rows) {
          if (row.native_upload_id !== null) {
            this.#sql.exec(
              "DELETE FROM managed_object_native_upload_fences WHERE native_upload_id = ? AND receipt_id = ?",
              row.native_upload_id,
              row.receipt_id,
            );
          }
          this.#sql.exec("DELETE FROM managed_object_parts WHERE receipt_id = ?", row.receipt_id);
          this.#sql.exec("DELETE FROM managed_object_uploads WHERE receipt_id = ?", row.receipt_id);
        }
        return success({ deleted: rows.length });
      }),
    );
  }

  nextActionAt(): ManagedObjectReceiptResult<number | null> {
    return this.#safely(() =>
      success(
        this.#sql
          .exec<{ readonly next_action_at: number | null }>(
            "SELECT min(next_action_at) AS next_action_at FROM managed_object_uploads WHERE next_action_at IS NOT NULL",
          )
          .toArray()[0]?.next_action_at ?? null,
      ),
    );
  }

  beginDestroy(input: {
    readonly authority: ManagedObjectReceiptAuthority;
    readonly bucketName: string;
  }): ManagedObjectReceiptResult<{ readonly state: "destroying" }> {
    if (!validAuthority(input.authority) || !bucketName(input.bucketName)) {
      return failure("invalid_argument");
    }
    return this.#safely(() =>
      this.#state.storage.transactionSync(() => {
        const claimed = this.#claimAuthority(input.authority, input.bucketName, true);
        if (claimed !== "ok") return failure(claimed);
        const now = this.#time();
        this.#sql.exec(
          "UPDATE managed_object_control SET lifecycle = 'destroying', updated_at = ? WHERE singleton = 1",
          now,
        );
        this.#sql.exec(
          `UPDATE managed_object_uploads
           SET state = 'destroying', updated_at = ?, next_action_at = NULL
           WHERE state NOT IN ('completed','aborted','operator_reconciliation_required')`,
          now,
        );
        return success({ state: "destroying" as const });
      }),
    );
  }

  ensureSchema(): ManagedObjectReceiptResult<undefined> {
    try {
      this.#ensureSchema();
      return success(undefined);
    } catch {
      return failure("backend_unavailable");
    }
  }

  /**
   * Claim the exact bucket after the caller has verified its private
   * capability. Candidate schemas retain provider authority but have no
   * bucket name, so this is the resume seam for their first authorized RPC.
   * A completely fresh schema is initialized here as well; the normal create
   * path remains idempotent when it observes that claim.
   */
  claimBucket(input: {
    readonly authority: ManagedObjectReceiptAuthority;
    readonly bucketName: string;
  }): ManagedObjectReceiptResult<undefined> {
    if (!validAuthority(input.authority) || !bucketName(input.bucketName)) {
      return failure("invalid_argument");
    }
    return this.#safely(() =>
      this.#state.storage.transactionSync(() => {
        const current = this.#authority();
        const control = this.#control();
        if (current === null && control === null) {
          const orphaned = this.#sql
            .exec<{ readonly total: number }>(
              `SELECT
                 (SELECT count(*) FROM managed_object_uploads) +
                 (SELECT count(*) FROM managed_object_parts) +
                 (SELECT count(*) FROM managed_object_key_fences) +
                 (SELECT count(*) FROM managed_object_native_upload_fences) AS total`,
            )
            .toArray()[0]?.total;
          if (orphaned !== 0) return failure("backend_unavailable");
          const now = this.#time();
          this.#sql.exec(
            `INSERT INTO managed_object_authority
               (singleton, provider_id, resource_uid, incarnation_id, resource_generation)
             VALUES (1, ?, ?, ?, ?)`,
            input.authority.providerId,
            input.authority.resourceUid,
            input.authority.incarnationId,
            input.authority.generation,
          );
          this.#sql.exec(
            "INSERT INTO managed_object_control (singleton, lifecycle, bucket_name, created_at, updated_at) VALUES (1, 'active', ?, ?, ?)",
            input.bucketName,
            now,
            now,
          );
          return success(undefined);
        }
        if (current === null || control === null) return failure("backend_unavailable");
        if (!sameAuthority(current, input.authority)) return failure("conflict");
        if (control.bucket_name !== null && control.bucket_name !== input.bucketName) {
          return failure("conflict");
        }
        if (control.bucket_name === null) {
          this.#sql.exec(
            "UPDATE managed_object_control SET bucket_name = ?, updated_at = ? WHERE singleton = 1 AND bucket_name IS NULL",
            input.bucketName,
            this.#time(),
          );
        }
        return success(undefined);
      }),
    );
  }

  /**
   * `DurableObjectStorage.deleteAll()` can remove the SQLite tables and still
   * lose its acknowledgement. Drop the in-memory initialization bit and
   * verify or recreate the latest schema before a same-isolate retry runs.
   */
  revalidateSchemaAfterDeleteAll(): ManagedObjectReceiptResult<undefined> {
    this.#initialized = false;
    try {
      this.#ensureSchema();
      return success(undefined);
    } catch {
      return failure("backend_unavailable");
    }
  }

  #ensureSchema(): void {
    if (this.#initialized) return;
    const now = this.#time();
    this.#state.storage.transactionSync(() => {
      const marker = this.#tableExists("managed_object_schema_meta")
        ? this.#sql
            .exec<{ readonly version: number }>(
              "SELECT version FROM managed_object_schema_meta WHERE singleton = 1",
            )
            .toArray()[0]?.version
        : undefined;
      if (marker === MANAGED_OBJECT_RECEIPT_INTERNAL_SCHEMA_VERSION) {
        this.#assertLatestColumns();
        return;
      }
      if (marker !== undefined) throw new Error("unsupported managed ObjectBucket receipt schema");
      if (!this.#tableExists("managed_object_uploads")) {
        this.#createLatestSchema();
      } else {
        this.#migrateCandidateSchema(now);
      }
      this.#sql.exec(`CREATE TABLE managed_object_schema_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL CHECK (version = ${MANAGED_OBJECT_RECEIPT_INTERNAL_SCHEMA_VERSION})
      )`);
      this.#sql.exec(
        "INSERT INTO managed_object_schema_meta (singleton, version) VALUES (1, ?)",
        MANAGED_OBJECT_RECEIPT_INTERNAL_SCHEMA_VERSION,
      );
    });
    this.#initialized = true;
  }

  #createLatestSchema(): void {
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS managed_object_authority (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      provider_id TEXT NOT NULL,
      resource_uid TEXT NOT NULL,
      incarnation_id TEXT NOT NULL,
      resource_generation TEXT NOT NULL
    )`);
    this.#sql.exec(`CREATE TABLE managed_object_control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','destroying')),
      bucket_name TEXT,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
    )`);
    this.#sql.exec(`CREATE TABLE managed_object_uploads (
      receipt_id TEXT PRIMARY KEY,
      object_key TEXT NOT NULL,
      marker TEXT NOT NULL UNIQUE,
      content_type TEXT,
      native_upload_id TEXT,
      state TEXT NOT NULL CHECK (state IN (
        'preparing','creating','create_reconciling','active','completing',
        'completion_reconciling','completed','aborting','aborted',
        'operator_reconciliation_required','destroying'
      )),
      completion_parts TEXT,
      expected_size INTEGER,
      completed_etag TEXT,
      completed_size INTEGER,
      baseline_upload_ids TEXT,
      create_granted INTEGER NOT NULL CHECK (create_granted IN (0,1)),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      terminal_at INTEGER,
      next_action_at INTEGER,
      attempts INTEGER NOT NULL CHECK (attempts >= 0)
    )`);
    this.#sql.exec(`CREATE TABLE managed_object_parts (
      receipt_id TEXT NOT NULL,
      part_number INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('uploading','ready')),
      attempt_id TEXT NOT NULL,
      etag TEXT,
      expected_size INTEGER,
      size INTEGER,
      previous_etag TEXT,
      previous_size INTEGER,
      PRIMARY KEY (receipt_id, part_number),
      FOREIGN KEY (receipt_id) REFERENCES managed_object_uploads(receipt_id) ON DELETE CASCADE
    )`);
    this.#sql.exec(`CREATE TABLE managed_object_key_fences (
      object_key TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL UNIQUE
    )`);
    this.#sql.exec(`CREATE TABLE managed_object_native_upload_fences (
      native_upload_id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL UNIQUE
    )`);
    this.#createLatestIndexes();
  }

  #createLatestIndexes(): void {
    this.#sql.exec(
      "CREATE INDEX IF NOT EXISTS managed_object_upload_due ON managed_object_uploads (next_action_at, receipt_id)",
    );
    this.#sql.exec(
      "CREATE INDEX IF NOT EXISTS managed_object_upload_key_state ON managed_object_uploads (object_key, state, receipt_id)",
    );
    this.#sql.exec(
      "CREATE INDEX IF NOT EXISTS managed_object_upload_native ON managed_object_uploads (native_upload_id, receipt_id)",
    );
  }

  /**
   * Upgrade only the exact v2 candidate layout. Unknown layouts fail closed.
   * Old ambiguous rows are preserved but permanently fenced for an operator;
   * timestamps start at upgrade time so no pre-existing terminal row is GC'd
   * prematurely.
   */
  #migrateCandidateSchema(now: number): void {
    this.#assertColumnSet("managed_object_authority", [
      "singleton",
      "provider_id",
      "resource_uid",
      "incarnation_id",
      "resource_generation",
    ]);
    this.#assertColumnSet("managed_object_uploads", [
      "receipt_id",
      "object_key",
      "marker",
      "content_type",
      "native_upload_id",
      "state",
      "completion_parts",
      "expected_size",
      "completed_etag",
      "completed_size",
    ]);
    this.#assertColumnSet("managed_object_parts", [
      "receipt_id",
      "part_number",
      "state",
      "attempt_id",
      "etag",
      "expected_size",
      "size",
      "previous_etag",
      "previous_size",
    ]);
    this.#sql.exec("ALTER TABLE managed_object_uploads RENAME TO managed_object_uploads_candidate");
    this.#sql.exec("ALTER TABLE managed_object_parts RENAME TO managed_object_parts_candidate");
    this.#createLatestSchema();
    this.#sql.exec(
      "INSERT INTO managed_object_control (singleton, lifecycle, bucket_name, created_at, updated_at) VALUES (1, 'active', NULL, ?, ?)",
      now,
      now,
    );
    this.#sql.exec(
      `INSERT INTO managed_object_uploads
       (receipt_id, object_key, marker, content_type, native_upload_id, state,
        completion_parts, expected_size, completed_etag, completed_size,
        baseline_upload_ids, create_granted, created_at, updated_at,
        terminal_at, next_action_at, attempts)
       SELECT receipt_id, object_key, marker, content_type, native_upload_id,
         CASE
           WHEN state = 'creating' THEN 'operator_reconciliation_required'
           WHEN state = 'reconciliation_required' AND completion_parts IS NOT NULL
             AND native_upload_id IS NOT NULL THEN 'completion_reconciling'
           WHEN state = 'reconciliation_required' THEN 'operator_reconciliation_required'
           ELSE state
         END,
         completion_parts, expected_size, completed_etag, completed_size,
         NULL,
         CASE WHEN state = 'creating' OR state = 'reconciliation_required' THEN 1 ELSE 0 END,
         ?, ?,
         CASE WHEN state IN ('completed','aborted') THEN ? ELSE NULL END,
         CASE
           WHEN state IN ('completed','aborted') THEN ?
           WHEN state = 'active' THEN ?
           WHEN state IN ('completing','aborting') OR
             (state = 'reconciliation_required' AND completion_parts IS NOT NULL
               AND native_upload_id IS NOT NULL) THEN ?
           ELSE NULL
         END,
         0
       FROM managed_object_uploads_candidate`,
      now,
      now,
      now,
      now + MANAGED_OBJECT_TERMINAL_RETENTION_MS,
      now + MANAGED_OBJECT_ACTIVE_RETENTION_MS,
      now + 60_000,
    );
    this.#sql.exec(
      `INSERT INTO managed_object_parts
       (receipt_id, part_number, state, attempt_id, etag, expected_size, size,
        previous_etag, previous_size)
       SELECT receipt_id, part_number, state, attempt_id, etag, expected_size,
              size, previous_etag, previous_size
       FROM managed_object_parts_candidate`,
    );
    this.#sql.exec(
      `UPDATE managed_object_uploads
       SET state = 'operator_reconciliation_required', next_action_at = NULL
       WHERE object_key IN (
         SELECT object_key FROM managed_object_uploads
         WHERE state NOT IN ('completed','aborted') GROUP BY object_key HAVING count(*) > 1
       ) OR native_upload_id IN (
         SELECT native_upload_id FROM managed_object_uploads
         WHERE native_upload_id IS NOT NULL GROUP BY native_upload_id HAVING count(*) > 1
       )`,
    );
    this.#sql.exec(
      `INSERT OR IGNORE INTO managed_object_key_fences (object_key, receipt_id)
       SELECT object_key, min(receipt_id) FROM managed_object_uploads
       WHERE state NOT IN ('completed','aborted') GROUP BY object_key`,
    );
    this.#sql.exec(
      `INSERT OR IGNORE INTO managed_object_native_upload_fences (native_upload_id, receipt_id)
       SELECT native_upload_id, min(receipt_id) FROM managed_object_uploads
       WHERE native_upload_id IS NOT NULL GROUP BY native_upload_id`,
    );
    this.#sql.exec("DROP TABLE managed_object_parts_candidate");
    this.#sql.exec("DROP TABLE managed_object_uploads_candidate");
  }

  #assertLatestColumns(): void {
    this.#assertColumnSet("managed_object_schema_meta", ["singleton", "version"]);
    this.#assertColumnSet("managed_object_authority", [
      "singleton",
      "provider_id",
      "resource_uid",
      "incarnation_id",
      "resource_generation",
    ]);
    this.#assertColumnSet("managed_object_uploads", [
      "receipt_id",
      "object_key",
      "marker",
      "content_type",
      "native_upload_id",
      "state",
      "completion_parts",
      "expected_size",
      "completed_etag",
      "completed_size",
      "baseline_upload_ids",
      "create_granted",
      "created_at",
      "updated_at",
      "terminal_at",
      "next_action_at",
      "attempts",
    ]);
    this.#assertColumnSet("managed_object_control", [
      "singleton",
      "lifecycle",
      "bucket_name",
      "created_at",
      "updated_at",
    ]);
    this.#assertColumnSet("managed_object_parts", [
      "receipt_id",
      "part_number",
      "state",
      "attempt_id",
      "etag",
      "expected_size",
      "size",
      "previous_etag",
      "previous_size",
    ]);
    this.#assertColumnSet("managed_object_key_fences", ["object_key", "receipt_id"]);
    this.#assertColumnSet("managed_object_native_upload_fences", [
      "native_upload_id",
      "receipt_id",
    ]);
    for (const index of [
      "managed_object_upload_due",
      "managed_object_upload_key_state",
      "managed_object_upload_native",
    ]) {
      if (!this.#indexExists(index)) {
        throw new Error("managed ObjectBucket receipt schema is incomplete");
      }
    }
  }

  #assertColumnSet(table: string, expected: readonly string[]): void {
    if (!this.#tableExists(table))
      throw new Error("managed ObjectBucket receipt schema is incomplete");
    const actual = this.#sql
      .exec<{ readonly name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .map((row) => row.name)
      .sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index])) {
      throw new Error("managed ObjectBucket receipt schema is not recognized");
    }
  }

  #tableExists(name: string): boolean {
    return (
      this.#sql
        .exec<{ readonly total: number }>(
          "SELECT count(*) AS total FROM sqlite_master WHERE type = 'table' AND name = ?",
          name,
        )
        .toArray()[0]?.total === 1
    );
  }

  #indexExists(name: string): boolean {
    return (
      this.#sql
        .exec<{ readonly total: number }>(
          "SELECT count(*) AS total FROM sqlite_master WHERE type = 'index' AND name = ?",
          name,
        )
        .toArray()[0]?.total === 1
    );
  }

  #claimAuthority(
    authority: ManagedObjectReceiptAuthority,
    bucket: string,
    allowDestroying = false,
  ): "ok" | "conflict" {
    const current = this.#authority();
    if (current && !sameAuthority(current, authority)) return "conflict";
    if (!current) {
      this.#sql.exec(
        `INSERT INTO managed_object_authority
           (singleton, provider_id, resource_uid, incarnation_id, resource_generation)
         VALUES (1, ?, ?, ?, ?)`,
        authority.providerId,
        authority.resourceUid,
        authority.incarnationId,
        authority.generation,
      );
    }
    const control = this.#control();
    const now = this.#time();
    if (!control) {
      this.#sql.exec(
        "INSERT INTO managed_object_control (singleton, lifecycle, bucket_name, created_at, updated_at) VALUES (1, 'active', ?, ?, ?)",
        bucket,
        now,
        now,
      );
      return "ok";
    }
    if (control.bucket_name !== null && control.bucket_name !== bucket) return "conflict";
    if (control.lifecycle === "destroying" && !allowDestroying) return "conflict";
    if (control.bucket_name === null) {
      this.#sql.exec(
        "UPDATE managed_object_control SET bucket_name = ?, updated_at = ? WHERE singleton = 1 AND bucket_name IS NULL",
        bucket,
        now,
      );
    }
    return "ok";
  }

  #authorityMatches(authority: ManagedObjectReceiptAuthority): boolean {
    const current = this.#authority();
    const control = this.#control();
    return current !== null && sameAuthority(current, authority) && control?.lifecycle === "active";
  }

  #runtimeAuthorityMatches(authority: ManagedObjectReceiptAuthority, bucket: string): boolean {
    const control = this.#control();
    return this.#authorityMatches(authority) && control?.bucket_name === bucket;
  }

  #control(): ControlRow | null {
    return (
      this.#sql
        .exec<ControlRow>(
          "SELECT lifecycle, bucket_name, created_at, updated_at FROM managed_object_control WHERE singleton = 1",
        )
        .toArray()[0] ?? null
    );
  }

  #authority(): AuthorityRow | null {
    return (
      this.#sql
        .exec<AuthorityRow>(
          `SELECT ${AUTHORITY_COLUMNS} FROM managed_object_authority WHERE singleton = 1`,
        )
        .toArray()[0] ?? null
    );
  }

  #upload(receiptId: string): UploadRow | null {
    return (
      this.#sql
        .exec<UploadRow>(
          `SELECT receipt_id, object_key, marker, content_type, native_upload_id, state,
                  completion_parts, expected_size, completed_etag, completed_size,
                  baseline_upload_ids, create_granted, created_at, updated_at,
                  terminal_at, next_action_at, attempts
             FROM managed_object_uploads WHERE receipt_id = ?`,
          receiptId,
        )
        .toArray()[0] ?? null
    );
  }

  #activeUpload(receiptId: string, key: string): UploadRow | null {
    const upload = this.#upload(receiptId);
    return upload?.state === "active" &&
      upload.object_key === key &&
      upload.native_upload_id !== null
      ? upload
      : null;
  }

  #part(receiptId: string, partNumber: number): PartRow | null {
    return (
      this.#sql
        .exec<PartRow>(
          `SELECT state, attempt_id, etag, expected_size, size, previous_etag, previous_size
             FROM managed_object_parts WHERE receipt_id = ? AND part_number = ?`,
          receiptId,
          partNumber,
        )
        .toArray()[0] ?? null
    );
  }

  #terminal(receiptId: string, state: "completed" | "aborted", now: number): void {
    const upload = this.#upload(receiptId);
    if (!upload) return;
    this.#sql.exec(
      `UPDATE managed_object_uploads
       SET state = ?, updated_at = ?, terminal_at = COALESCE(terminal_at, ?), next_action_at = ?
       WHERE receipt_id = ?`,
      state,
      now,
      now,
      now + MANAGED_OBJECT_TERMINAL_RETENTION_MS,
      receiptId,
    );
    this.#sql.exec(
      "DELETE FROM managed_object_key_fences WHERE object_key = ? AND receipt_id = ?",
      upload.object_key,
      receiptId,
    );
  }

  #time(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("invalid managed ObjectBucket receipt clock");
    }
    return value;
  }

  #safely<T>(operation: () => ManagedObjectReceiptResult<T>): ManagedObjectReceiptResult<T> {
    try {
      this.#ensureSchema();
      return operation();
    } catch {
      return failure("backend_unavailable");
    }
  }
}

function success<T>(value: T): ManagedObjectReceiptResult<T> {
  return { ok: true, value };
}

function failure(code: ManagedObjectReceiptErrorCode): ManagedObjectReceiptResult<never> {
  return { ok: false, error: { code } };
}

function validAuthority(value: unknown): value is ManagedObjectReceiptAuthority {
  const input = exactRecord(value, [
    "schema",
    "providerId",
    "resourceUid",
    "incarnationId",
    "generation",
  ]);
  return (
    !!input &&
    input.schema === MANAGED_OBJECT_RECEIPT_AUTHORITY_SCHEMA &&
    token(input.providerId) &&
    token(input.resourceUid) &&
    token(input.incarnationId) &&
    typeof input.generation === "string" &&
    GENERATION.test(input.generation)
  );
}

function sameAuthority(row: AuthorityRow, authority: ManagedObjectReceiptAuthority): boolean {
  return (
    row.provider_id === authority.providerId &&
    row.resource_uid === authority.resourceUid &&
    row.incarnation_id === authority.incarnationId &&
    row.resource_generation === authority.generation
  );
}

function uploadIdentityInput(value: unknown): {
  readonly authority: ManagedObjectReceiptAuthority;
  readonly key: string;
  readonly receiptId: string;
} | null {
  const input = exactRecord(value, ["authority", "key", "receiptId"]);
  if (
    !input ||
    !validAuthority(input.authority) ||
    !objectKey(input.key) ||
    typeof input.receiptId !== "string" ||
    !RECEIPT.test(input.receiptId)
  ) {
    return null;
  }
  return { authority: input.authority, key: input.key, receiptId: input.receiptId };
}

function abortInput(value: unknown): {
  readonly authority: ManagedObjectReceiptAuthority;
  readonly key: string;
  readonly receiptId: string;
  readonly nativeUploadId?: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) return null;
  const hasNativeUploadId = ownKeys.includes("nativeUploadId");
  const identity = uploadIdentityInput({
    authority: (value as Record<string, unknown>).authority,
    key: (value as Record<string, unknown>).key,
    receiptId: (value as Record<string, unknown>).receiptId,
  });
  if (!identity) return null;
  if (hasNativeUploadId) {
    const expected = ["authority", "key", "nativeUploadId", "receiptId"];
    const actual = (ownKeys as string[]).sort();
    if (
      actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index]) ||
      !boundedText((value as Record<string, unknown>).nativeUploadId, 4096)
    ) {
      return null;
    }
    return {
      ...identity,
      nativeUploadId: (value as Record<string, unknown>).nativeUploadId as string,
    };
  }
  if (ownKeys.length !== 3) return null;
  return identity;
}

function createInput(value: unknown): {
  readonly authority: ManagedObjectReceiptAuthority;
  readonly bucketName: string;
  readonly key: string;
  readonly contentType: string | null;
  readonly receiptId: string;
  readonly marker: string;
} | null {
  const input = exactRecord(value, [
    "authority",
    "bucketName",
    "key",
    "contentType",
    "receiptId",
    "marker",
  ]);
  if (
    !input ||
    !validAuthority(input.authority) ||
    !bucketName(input.bucketName) ||
    !objectKey(input.key) ||
    (input.contentType !== null && !boundedText(input.contentType, 256)) ||
    typeof input.receiptId !== "string" ||
    !RECEIPT.test(input.receiptId) ||
    typeof input.marker !== "string" ||
    !MARKER.test(input.marker)
  ) {
    return null;
  }
  return {
    authority: input.authority,
    bucketName: input.bucketName,
    key: input.key,
    contentType: input.contentType,
    receiptId: input.receiptId,
    marker: input.marker,
  };
}

function createGrantInput(value: unknown):
  | (NonNullable<ReturnType<typeof createInput>> & {
      readonly baselineUploadIds: readonly string[];
    })
  | null {
  const input = exactRecord(value, [
    "authority",
    "bucketName",
    "key",
    "contentType",
    "receiptId",
    "marker",
    "baselineUploadIds",
  ]);
  if (!input) return null;
  const create = createInput({
    authority: input.authority,
    bucketName: input.bucketName,
    key: input.key,
    contentType: input.contentType,
    receiptId: input.receiptId,
    marker: input.marker,
  });
  const baselineUploadIds = create ? uniqueUploadIds(input.baselineUploadIds) : null;
  return create && baselineUploadIds ? { ...create, baselineUploadIds } : null;
}

function createResolutionInput(value: unknown):
  | (NonNullable<ReturnType<typeof createInput>> & {
      readonly observedUploadIds: readonly string[];
      readonly acknowledgedUploadId: string | null;
      readonly recovery: boolean;
      readonly definitiveFailure: boolean;
    })
  | null {
  const input = exactRecord(value, [
    "authority",
    "bucketName",
    "key",
    "contentType",
    "receiptId",
    "marker",
    "observedUploadIds",
    "acknowledgedUploadId",
    "recovery",
    "definitiveFailure",
  ]);
  if (
    !input ||
    typeof input.recovery !== "boolean" ||
    typeof input.definitiveFailure !== "boolean" ||
    (input.acknowledgedUploadId !== null && !boundedText(input.acknowledgedUploadId, 4_096))
  ) {
    return null;
  }
  const create = createInput({
    authority: input.authority,
    bucketName: input.bucketName,
    key: input.key,
    contentType: input.contentType,
    receiptId: input.receiptId,
    marker: input.marker,
  });
  const observedUploadIds = create ? uniqueUploadIds(input.observedUploadIds) : null;
  return create && observedUploadIds
    ? {
        ...create,
        observedUploadIds,
        acknowledgedUploadId: input.acknowledgedUploadId as string | null,
        recovery: input.recovery,
        definitiveFailure: input.definitiveFailure,
      }
    : null;
}

function partAttemptInput(value: unknown): {
  readonly authority: ManagedObjectReceiptAuthority;
  readonly key: string;
  readonly receiptId: string;
  readonly partNumber: number;
  readonly size: number;
  readonly attemptId: string;
} | null {
  const input = exactRecord(value, [
    "authority",
    "key",
    "receiptId",
    "partNumber",
    "size",
    "attemptId",
  ]);
  const identity = input
    ? uploadIdentityInput({
        authority: input.authority,
        key: input.key,
        receiptId: input.receiptId,
      })
    : null;
  if (
    !input ||
    !identity ||
    !integerBetween(input.partNumber, 1, MAX_OBJECT_PARTS) ||
    !integerBetween(input.size, 0, MAX_OBJECT_BYTES) ||
    typeof input.attemptId !== "string" ||
    !RECEIPT.test(input.attemptId)
  ) {
    return null;
  }
  return {
    ...identity,
    partNumber: input.partNumber,
    size: input.size,
    attemptId: input.attemptId,
  };
}

function committedPartInput(value: unknown):
  | (NonNullable<ReturnType<typeof partAttemptInput>> & {
      readonly etag: string;
    })
  | null {
  const input = exactRecord(value, [
    "authority",
    "key",
    "receiptId",
    "partNumber",
    "size",
    "attemptId",
    "etag",
  ]);
  if (!input || !boundedText(input.etag, 256)) return null;
  const attempt = partAttemptInput({
    authority: input.authority,
    key: input.key,
    receiptId: input.receiptId,
    partNumber: input.partNumber,
    size: input.size,
    attemptId: input.attemptId,
  });
  return attempt ? { ...attempt, etag: input.etag } : null;
}

function completionInput(value: unknown): {
  readonly authority: ManagedObjectReceiptAuthority;
  readonly key: string;
  readonly receiptId: string;
  readonly parts: readonly ManagedObjectReceiptPart[];
} | null {
  const input = exactRecord(value, ["authority", "key", "receiptId", "parts"]);
  const identity = input
    ? uploadIdentityInput({
        authority: input.authority,
        key: input.key,
        receiptId: input.receiptId,
      })
    : null;
  if (
    !input ||
    !identity ||
    !Array.isArray(input.parts) ||
    input.parts.length < 1 ||
    input.parts.length > MAX_OBJECT_PARTS
  ) {
    return null;
  }
  const parts: ManagedObjectReceiptPart[] = [];
  let previous = 0;
  for (const value of input.parts) {
    const part = exactRecord(value, ["partNumber", "etag"]);
    if (
      !part ||
      !integerBetween(part.partNumber, 1, MAX_OBJECT_PARTS) ||
      part.partNumber <= previous ||
      !boundedText(part.etag, 256)
    ) {
      return null;
    }
    previous = part.partNumber;
    parts.push({ partNumber: part.partNumber, etag: part.etag });
  }
  return { ...identity, parts };
}

function completedInput(value: unknown):
  | (NonNullable<ReturnType<typeof completionInput>> & {
      readonly etag: string;
      readonly size: number;
    })
  | null {
  const input = exactRecord(value, ["authority", "key", "receiptId", "parts", "etag", "size"]);
  if (!input || !boundedText(input.etag, 256) || !integerBetween(input.size, 0, MAX_OBJECT_BYTES)) {
    return null;
  }
  const completion = completionInput({
    authority: input.authority,
    key: input.key,
    receiptId: input.receiptId,
    parts: input.parts,
  });
  return completion ? { ...completion, etag: input.etag, size: input.size } : null;
}

function sameCreate(row: UploadRow, input: NonNullable<ReturnType<typeof createInput>>): boolean {
  return (
    row.receipt_id === input.receiptId &&
    row.object_key === input.key &&
    row.marker === input.marker &&
    row.content_type === input.contentType
  );
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) return null;
  const actual = (ownKeys as string[]).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return null;
  }
  return value as Record<string, unknown>;
}

function token(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !hasControlCharacters(value)
  );
}

function objectKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_OBJECT_KEY_BYTES &&
    !hasControlCharacters(value)
  );
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function integerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function bucketName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    BUCKET.test(value) &&
    !value.includes("..") &&
    !/^\d+(?:\.\d+){3}$/u.test(value)
  );
}

function uniqueUploadIds(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_DISCOVERED_UPLOADS) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!boundedText(candidate, 4_096) || seen.has(candidate)) return null;
    seen.add(candidate);
    result.push(candidate);
  }
  return result.sort();
}

function uploadIdArray(value: string): readonly string[] | null {
  try {
    return uniqueUploadIds(JSON.parse(value));
  } catch {
    return null;
  }
}

function createRetryDelay(attempt: number): number {
  return Math.min(60 * 60 * 1_000, 1_000 * 2 ** Math.min(12, Math.max(0, attempt)));
}

function authorityProofParts(authority: ManagedObjectReceiptAuthority): readonly string[] {
  return [
    authority.schema,
    authority.providerId,
    authority.resourceUid,
    authority.incarnationId,
    authority.generation,
  ];
}

async function hmacProof(secret: string, parts: readonly string[]): Promise<string> {
  const encoder = new TextEncoder();
  const encoded = parts.map((part) => encoder.encode(part));
  const message = new Uint8Array(encoded.reduce((size, part) => size + 8 + part.byteLength, 0));
  const view = new DataView(message.buffer);
  let offset = 0;
  for (const part of encoded) {
    view.setBigUint64(offset, BigInt(part.byteLength), false);
    offset += 8;
    message.set(part, offset);
    offset += part.byteLength;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, message as BufferSource)),
  ).slice(0, 43);
}

function sameProof(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
