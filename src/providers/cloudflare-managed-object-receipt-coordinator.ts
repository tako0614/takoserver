import {
  MANAGED_OBJECT_ACTIVE_RETENTION_MS,
  type ManagedObjectReceiptAuthority,
  type ManagedObjectReceiptCore,
  type ManagedObjectReceiptResult,
} from "./cloudflare-managed-object-receipt.ts";
import type {
  CloudflareManagedObjectS3,
  ManagedObjectMultipartUpload,
} from "./cloudflare-managed-object-s3.ts";

const CREATE_RECOVERY_DELAY_MS = 1_000;

export interface ManagedObjectReceiptAlarmStorage {
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface ManagedObjectReceiptProvider {
  listMultipartUploads(input: {
    readonly bucketName: string;
    readonly key?: string;
  }): Promise<readonly ManagedObjectMultipartUpload[]>;
  listMultipartUploadPage(input: { readonly bucketName: string }): Promise<{
    readonly uploads: readonly ManagedObjectMultipartUpload[];
    readonly truncated: boolean;
  }>;
  createMultipartUpload(input: {
    readonly bucketName: string;
    readonly key: string;
    readonly contentType: string | null;
    readonly marker: string;
  }): Promise<{ readonly uploadId: string }>;
  abortMultipartUpload(input: {
    readonly bucketName: string;
    readonly key: string;
    readonly uploadId: string;
  }): Promise<void>;
  bucketPresent(bucketName: string): Promise<boolean>;
}

export interface ManagedObjectReceiptCreateInput {
  readonly authority: ManagedObjectReceiptAuthority;
  readonly bucketName: string;
  readonly key: string;
  readonly contentType: string | null;
  readonly receiptId: string;
  readonly marker: string;
}

/**
 * Sole orchestration authority for native multipart creation and cleanup.
 *
 * The core durably grants exactly one create. The coordinator always records
 * an alarm before consuming that grant, then resolves the provider-owned list
 * delta before it returns an opaque receipt to a tenant Worker.
 */
export class ManagedObjectReceiptCoordinator {
  readonly #core: ManagedObjectReceiptCore;
  readonly #provider: ManagedObjectReceiptProvider;
  readonly #storage: ManagedObjectReceiptAlarmStorage;
  readonly #now: () => number;

  constructor(options: {
    readonly core: ManagedObjectReceiptCore;
    readonly provider: ManagedObjectReceiptProvider | CloudflareManagedObjectS3;
    readonly storage: ManagedObjectReceiptAlarmStorage;
    readonly now?: () => number;
  }) {
    this.#core = options.core;
    this.#provider = options.provider;
    this.#storage = options.storage;
    this.#now = options.now ?? (() => Date.now());
  }

  async createMultipartUpload(
    input: ManagedObjectReceiptCreateInput,
  ): Promise<ManagedObjectReceiptResult<{ readonly state: "active" }>> {
    const began = this.#core.beginCreate(input);
    if (!began.ok) return began;
    if (began.value.state === "active") return ok({ state: "active" as const });
    if (began.value.state !== "preparing") return unavailable();

    let baseline: readonly ManagedObjectMultipartUpload[];
    try {
      baseline = await this.#provider.listMultipartUploads({
        bucketName: input.bucketName,
        key: input.key,
      });
      // The recovery alarm exists before the native create grant can be
      // consumed. A configuration without working alarms cannot create.
      await this.#storage.setAlarm(this.#time() + CREATE_RECOVERY_DELAY_MS);
    } catch {
      this.#core.beginAbort({
        authority: input.authority,
        key: input.key,
        receiptId: input.receiptId,
      });
      return unavailable();
    }

    const granted = this.#core.grantCreate({
      ...input,
      baselineUploadIds: baseline.map((upload) => upload.uploadId),
    });
    if (!granted.ok) return unavailable();

    let acknowledgedUploadId: string | null = null;
    let definitiveFailure = false;
    try {
      acknowledgedUploadId = (
        await this.#provider.createMultipartUpload({
          bucketName: input.bucketName,
          key: input.key,
          contentType: input.contentType,
          marker: input.marker,
        })
      ).uploadId;
    } catch (error) {
      definitiveFailure = definitiveCreateFailure(error);
    }

    let observedUploadIds: readonly string[];
    try {
      observedUploadIds = (
        await this.#provider.listMultipartUploads({
          bucketName: input.bucketName,
          key: input.key,
        })
      ).map((upload) => upload.uploadId);
    } catch {
      observedUploadIds = baseline.map((upload) => upload.uploadId);
      definitiveFailure = false;
    }

    const resolved = this.#core.resolveCreate({
      ...input,
      observedUploadIds,
      acknowledgedUploadId,
      recovery: false,
      definitiveFailure,
    });
    await this.#syncAlarmBestEffort();
    return resolved.ok && resolved.value.action === "active"
      ? ok({ state: "active" as const })
      : unavailable();
  }

  /** One bounded alarm turn. Platform retries remain safe and never recreate. */
  async alarm(): Promise<void> {
    const inspected = this.#core.inspect();
    if (!inspected.ok) throw new Error("managed ObjectBucket receipt storage unavailable");
    if (inspected.value.lifecycle === "destroying") {
      if (!inspected.value.authority || !inspected.value.bucketName) {
        throw new Error("managed ObjectBucket destroy authority unavailable");
      }
      await this.#drainDestroy(inspected.value.bucketName);
      return;
    }
    const authority = inspected.value.authority;
    const bucketName = inspected.value.bucketName;
    if (!authority || !bucketName) {
      await this.#syncAlarm();
      return;
    }
    const now = this.#time();
    const due = this.#core.dueReceipts(now);
    if (!due.ok) throw new Error("managed ObjectBucket receipt storage unavailable");
    for (const receipt of due.value) {
      if (receipt.state === "preparing") {
        this.#core.beginAbort({ authority, key: receipt.key, receiptId: receipt.receiptId });
        continue;
      }
      if (receipt.state === "creating" || receipt.state === "create_reconciling") {
        if (now >= receipt.createdAt + MANAGED_OBJECT_ACTIVE_RETENTION_MS) {
          this.#core.requireOperator(receipt.receiptId);
          continue;
        }
        try {
          const observedUploadIds = (
            await this.#provider.listMultipartUploads({ bucketName, key: receipt.key })
          ).map((upload) => upload.uploadId);
          const resolved = this.#core.resolveCreate({
            authority,
            bucketName,
            key: receipt.key,
            contentType: receipt.contentType,
            receiptId: receipt.receiptId,
            marker: receipt.marker,
            observedUploadIds,
            acknowledgedUploadId: null,
            recovery: true,
            definitiveFailure: false,
          });
          if (resolved.ok && resolved.value.action === "abort") {
            await this.#abortAndCommit(
              authority,
              bucketName,
              receipt.key,
              receipt.receiptId,
              resolved.value.nativeUploadId,
            );
          }
        } catch {
          this.#core.rearmReceipt(receipt.receiptId, now + retryDelay(receipt.attempts));
        }
        continue;
      }
      if (receipt.state === "active" || receipt.state === "aborting") {
        try {
          const begun = this.#core.beginAbort({
            authority,
            key: receipt.key,
            receiptId: receipt.receiptId,
            ...(receipt.nativeUploadId === null ? {} : { nativeUploadId: receipt.nativeUploadId }),
          });
          if (begun.ok && begun.value.action === "execute") {
            await this.#abortAndCommit(
              authority,
              bucketName,
              receipt.key,
              receipt.receiptId,
              begun.value.nativeUploadId,
            );
          }
        } catch {
          this.#core.rearmReceipt(receipt.receiptId, now + retryDelay(receipt.attempts));
        }
        continue;
      }
      if (receipt.state === "completing" || receipt.state === "completion_reconciling") {
        // A completion may have committed after its acknowledgement was lost.
        // Expiry cannot safely turn that ambiguity into a native abort.
        this.#core.requireOperator(receipt.receiptId);
      }
    }
    this.#core.gcTerminal(now);
    await this.#syncAlarm();
  }

  async prepareDestroy(input: {
    readonly authority: ManagedObjectReceiptAuthority;
    readonly bucketName: string;
  }): Promise<ManagedObjectReceiptResult<{ readonly state: "draining" | "prepared" }>> {
    const begun = this.#core.beginDestroy(input);
    if (!begun.ok) return begun;
    try {
      const remaining = await this.#drainDestroy(input.bucketName);
      return ok({ state: remaining ? ("draining" as const) : ("prepared" as const) });
    } catch {
      try {
        await this.#storage.setAlarm(this.#time() + CREATE_RECOVERY_DELAY_MS);
      } catch {}
      return unavailable();
    }
  }

  async commitDestroy(input: {
    readonly authority: ManagedObjectReceiptAuthority;
    readonly bucketName: string;
  }): Promise<ManagedObjectReceiptResult<{ readonly destroyed: true }>> {
    const inspected = this.#core.inspect();
    if (!inspected.ok) return inspected;
    const isLostAckRetry =
      inspected.value.authority === null &&
      inspected.value.bucketName === null &&
      inspected.value.receiptCount === 0;
    if (
      !isLostAckRetry &&
      (inspected.value.lifecycle !== "destroying" ||
        !sameAuthority(inspected.value.authority, input.authority) ||
        inspected.value.bucketName !== input.bucketName)
    ) {
      return { ok: false, error: { code: "conflict" } };
    }
    let deleteAllAttempted = false;
    try {
      if (await this.#provider.bucketPresent(input.bucketName)) {
        return { ok: false, error: { code: "conflict" } };
      }
      await this.#storage.deleteAlarm();
      deleteAllAttempted = true;
      await this.#storage.deleteAll();
      if (!this.#core.revalidateSchemaAfterDeleteAll().ok) return unavailable();
      return ok({ destroyed: true as const });
    } catch {
      if (deleteAllAttempted) this.#core.revalidateSchemaAfterDeleteAll();
      return unavailable();
    }
  }

  async #abortAndCommit(
    authority: ManagedObjectReceiptAuthority,
    bucketName: string,
    key: string,
    receiptId: string,
    nativeUploadId: string,
  ): Promise<void> {
    await this.#provider.abortMultipartUpload({ bucketName, key, uploadId: nativeUploadId });
    const committed = this.#core.commitAbort({ authority, key, receiptId });
    if (!committed.ok) throw new Error("managed ObjectBucket abort receipt unavailable");
  }

  /** Returns true until a subsequent authoritative empty page is observed. */
  async #drainDestroy(bucketName: string): Promise<boolean> {
    const page = await this.#provider.listMultipartUploadPage({ bucketName });
    for (const upload of page.uploads) {
      await this.#provider.abortMultipartUpload({
        bucketName,
        key: upload.key,
        uploadId: upload.uploadId,
      });
    }
    const remaining = page.truncated || page.uploads.length > 0;
    if (remaining) await this.#storage.setAlarm(this.#time() + CREATE_RECOVERY_DELAY_MS);
    else await this.#storage.deleteAlarm();
    return remaining;
  }

  async #syncAlarmBestEffort(): Promise<void> {
    try {
      await this.#syncAlarm();
    } catch {
      // A safety alarm was installed before the native grant. Failure to move
      // it later leaves that earlier alarm in place.
    }
  }

  async #syncAlarm(): Promise<void> {
    const next = this.#core.nextActionAt();
    if (!next.ok) throw new Error("managed ObjectBucket receipt storage unavailable");
    if (next.value === null) await this.#storage.deleteAlarm();
    else await this.#storage.setAlarm(next.value);
  }

  #time(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("managed ObjectBucket receipt clock unavailable");
    }
    return now;
  }
}

function definitiveCreateFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = Reflect.get(error, "status");
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 409 &&
    status !== 425 &&
    status !== 429
  );
}

function retryDelay(attempts: number): number {
  return Math.min(60 * 60 * 1_000, 1_000 * 2 ** Math.min(12, Math.max(0, attempts)));
}

function sameAuthority(
  left: ManagedObjectReceiptAuthority | null,
  right: ManagedObjectReceiptAuthority,
): boolean {
  return (
    left !== null &&
    left.schema === right.schema &&
    left.providerId === right.providerId &&
    left.resourceUid === right.resourceUid &&
    left.incarnationId === right.incarnationId &&
    left.generation === right.generation
  );
}

function ok<T>(value: T): ManagedObjectReceiptResult<T> {
  return { ok: true, value };
}

function unavailable(): ManagedObjectReceiptResult<never> {
  return { ok: false, error: { code: "backend_unavailable" } };
}
