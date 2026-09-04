import { DurableObject } from "cloudflare:workers";
import {
  type ManagedObjectReceiptAdminOperation,
  type ManagedObjectReceiptAuthority,
  ManagedObjectReceiptCore,
  type ManagedObjectReceiptResult,
  type ManagedObjectReceiptState,
  verifyManagedObjectReceiptAdminProof,
  verifyManagedObjectReceiptRuntimeProof,
} from "./cloudflare-managed-object-receipt.ts";
import { ManagedObjectReceiptCoordinator } from "./cloudflare-managed-object-receipt-coordinator.ts";
import { CloudflareManagedObjectS3 } from "./cloudflare-managed-object-s3.ts";

interface ManagedObjectReceiptObjectEnv {
  readonly MANAGED_PROVIDER_ID?: string;
  readonly TAKOSERVER_MANAGED_OBJECT_ACCOUNT_ID?: string;
  readonly TAKOSERVER_MANAGED_OBJECT_ACCESS_KEY_ID?: string;
  readonly TAKOSERVER_MANAGED_OBJECT_SECRET_ACCESS_KEY?: string;
  readonly TAKOSERVER_MANAGED_OBJECT_PROOF_SECRET?: string;
  /** Test-only service transport; production uses the global provider endpoint. */
  readonly TAKOSERVER_MANAGED_OBJECT_S3_TRANSPORT?: {
    fetch(request: Request): Promise<Response>;
  };
}

/**
 * Bun's ambient `cloudflare:workers` declaration omits `alarm`, while the
 * generated Worker declaration includes it. Normalize that base surface here
 * so `noImplicitOverride` remains enabled in both compilation environments.
 */
type ManagedObjectReceiptDurableObject = DurableObject<ManagedObjectReceiptObjectEnv> & {
  alarm?(alarmInfo?: unknown): void | Promise<void>;
};
const DurableObjectWithAlarm = DurableObject as unknown as abstract new (
  ctx: never,
  env: never,
) => ManagedObjectReceiptDurableObject;

interface AuthorizedRequest {
  readonly authority: ManagedObjectReceiptAuthority;
  readonly bucketName: string;
  readonly body: Record<string, unknown>;
}

interface ReceiptConfiguration {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly proofSecret: string;
}

/**
 * Provider-owned, route-less multipart receipt authority exported only by the
 * dedicated receipt-authority Worker. Tenant code receives closed wrapper
 * methods through the gateway; raw provider credentials and native-create
 * operations stay behind this private service-binding boundary.
 */
export class TakoserverManagedObjectReceipt extends DurableObjectWithAlarm {
  readonly #state: ManagedObjectReceiptState;
  readonly #env: ManagedObjectReceiptObjectEnv;
  readonly #core: ManagedObjectReceiptCore;

  constructor(ctx: ManagedObjectReceiptState, env: ManagedObjectReceiptObjectEnv) {
    super(ctx as never, env as never);
    this.#state = ctx;
    this.#env = env;
    // Proof and credential checks must happen before even an internal schema
    // upgrade mutates storage, so initialization is deliberately lazy.
    this.#core = new ManagedObjectReceiptCore(this.#state, { initialize: false });
  }

  override fetch(_request?: Request): Response {
    return new Response(null, { status: 404 });
  }

  async createMultipartUpload(raw: unknown): Promise<ManagedObjectReceiptResult<unknown>> {
    const request = await this.#runtime(raw, [
      "authority",
      "bucketName",
      "proof",
      "key",
      "contentType",
      "receiptId",
      "marker",
    ]);
    if (!request.ok) return request.result;
    return await request.coordinator.createMultipartUpload(
      withoutRuntimeProof(request.authorized.body) as never,
    );
  }

  async beginPart(raw: unknown): Promise<ManagedObjectReceiptResult<unknown>> {
    return await this.#coreRuntime(
      raw,
      ["authority", "bucketName", "proof", "key", "receiptId", "partNumber", "size", "attemptId"],
      (body) => this.#core.beginPart(body),
    );
  }

  async commitPart(raw: unknown): Promise<ManagedObjectReceiptResult<unknown>> {
    return await this.#coreRuntime(
      raw,
      [
        "authority",
        "bucketName",
        "proof",
        "key",
        "receiptId",
        "partNumber",
        "size",
        "attemptId",
        "etag",
      ],
      (body) => this.#core.commitPart(body),
    );
  }

  async releasePart(raw: unknown): Promise<ManagedObjectReceiptResult<unknown>> {
    return await this.#coreRuntime(
      raw,
      ["authority", "bucketName", "proof", "key", "receiptId", "partNumber", "size", "attemptId"],
      (body) => this.#core.releasePart(body),
    );
  }

  async beginComplete(raw: unknown): Promise<ManagedObjectReceiptResult<unknown>> {
    return await this.#coreRuntime(
      raw,
      ["authority", "bucketName", "proof", "key", "receiptId", "parts"],
      (body) => this.#core.beginComplete(body),
    );
  }

  async commitComplete(raw: unknown): Promise<ManagedObjectReceiptResult<unknown>> {
    return await this.#coreRuntime(
      raw,
      ["authority", "bucketName", "proof", "key", "receiptId", "parts", "etag", "size"],
      (body) => this.#core.commitComplete(body),
    );
  }

  async failComplete(raw: unknown): Promise<ManagedObjectReceiptResult<unknown>> {
    return await this.#coreRuntime(
      raw,
      ["authority", "bucketName", "proof", "key", "receiptId", "parts"],
      (body) => this.#core.failComplete(body),
    );
  }

  async markCompleteLost(raw: unknown): Promise<ManagedObjectReceiptResult<unknown>> {
    return await this.#coreRuntime(
      raw,
      ["authority", "bucketName", "proof", "key", "receiptId", "parts"],
      (body) => this.#core.markCompleteLost(body),
    );
  }

  async beginAbort(raw: unknown): Promise<ManagedObjectReceiptResult<unknown>> {
    const keys = recordHas(raw, "nativeUploadId")
      ? ["authority", "bucketName", "proof", "key", "receiptId", "nativeUploadId"]
      : ["authority", "bucketName", "proof", "key", "receiptId"];
    return await this.#coreRuntime(raw, keys, (body) => this.#core.beginAbort(body));
  }

  async commitAbort(raw: unknown): Promise<ManagedObjectReceiptResult<unknown>> {
    return await this.#coreRuntime(
      raw,
      ["authority", "bucketName", "proof", "key", "receiptId"],
      (body) => this.#core.commitAbort(body),
    );
  }

  async takoserverObjectReceiptInspect(raw: unknown): Promise<ManagedObjectReceiptResult<unknown>> {
    const request = await this.#admin(raw, "inspect");
    if (!request.ok) return request.result;
    const inspected = this.#core.inspect();
    if (!inspected.ok) return inspected;
    return authorityMatchesInspect(inspected.value, request.authorized) ? inspected : conflict();
  }

  async takoserverObjectReceiptPrepareDestroy(
    raw: unknown,
  ): Promise<ManagedObjectReceiptResult<unknown>> {
    const request = await this.#admin(raw, "prepare-destroy");
    if (!request.ok) return request.result;
    return await request.coordinator.prepareDestroy(request.authorized);
  }

  async takoserverObjectReceiptCommitDestroy(
    raw: unknown,
  ): Promise<ManagedObjectReceiptResult<unknown>> {
    const request = await this.#admin(raw, "commit-destroy");
    if (!request.ok) return request.result;
    return await request.coordinator.commitDestroy(request.authorized);
  }

  override async alarm(): Promise<void> {
    // Validate every provider-private credential before a schema upgrade or
    // provider call. Throwing asks the platform to retry the alarm.
    await this.#coordinator().alarm();
  }

  async #coreRuntime(
    raw: unknown,
    keys: readonly string[],
    operation: (body: Record<string, unknown>) => ManagedObjectReceiptResult<unknown>,
  ): Promise<ManagedObjectReceiptResult<unknown>> {
    const request = await this.#runtime(raw, keys);
    if (!request.ok) return request.result;
    const inspected = this.#core.inspect();
    if (!inspected.ok) return inspected;
    if (!authorityMatchesInspect(inspected.value, request.authorized)) return conflict();
    return operation(withoutProof(request.authorized.body));
  }

  async #runtime(
    raw: unknown,
    keys: readonly string[],
  ): Promise<
    | {
        readonly ok: true;
        readonly authorized: AuthorizedRequest;
        readonly coordinator: ManagedObjectReceiptCoordinator;
      }
    | { readonly ok: false; readonly result: ManagedObjectReceiptResult<never> }
  > {
    const body = exactRecord(raw, keys);
    const authority = body ? authorityValue(body.authority) : null;
    if (
      !body ||
      !authority ||
      typeof body.bucketName !== "string" ||
      typeof body.proof !== "string"
    ) {
      return { ok: false, result: invalid() };
    }
    const configuration = this.#configuration(authority);
    if (!configuration) return { ok: false, result: unavailable() };
    if (
      !(await verifyManagedObjectReceiptRuntimeProof({
        secret: configuration.proofSecret,
        proof: body.proof,
        authority,
        bucketName: body.bucketName,
      }))
    ) {
      return { ok: false, result: conflict() };
    }
    const authorized = { authority, bucketName: body.bucketName, body };
    const claimed = this.#core.claimBucket(authorized);
    if (!claimed.ok) return { ok: false, result: claimed };
    return { ok: true, authorized, coordinator: this.#coordinator(configuration) };
  }

  async #admin(
    raw: unknown,
    operation: ManagedObjectReceiptAdminOperation,
  ): Promise<
    | {
        readonly ok: true;
        readonly authorized: {
          readonly authority: ManagedObjectReceiptAuthority;
          readonly bucketName: string;
        };
        readonly coordinator: ManagedObjectReceiptCoordinator;
      }
    | { readonly ok: false; readonly result: ManagedObjectReceiptResult<never> }
  > {
    const body = exactRecord(raw, ["authority", "bucketName", "proof"]);
    const authority = body ? authorityValue(body.authority) : null;
    if (
      !body ||
      !authority ||
      typeof body.bucketName !== "string" ||
      typeof body.proof !== "string"
    ) {
      return { ok: false, result: invalid() };
    }
    const configuration = this.#configuration(authority);
    if (!configuration) return { ok: false, result: unavailable() };
    if (
      !(await verifyManagedObjectReceiptAdminProof({
        secret: configuration.proofSecret,
        proof: body.proof,
        operation,
        authority,
        bucketName: body.bucketName,
      }))
    ) {
      return { ok: false, result: conflict() };
    }
    const authorized = { authority, bucketName: body.bucketName };
    // An empty, freshly recreated schema is the explicit lost-ack retry lane
    // for commit-destroy. Preserve that markerless state so the coordinator
    // can verify bucket absence and complete the idempotent retry.
    let preserveEmptyCommitRetry = false;
    if (operation === "commit-destroy") {
      const inspected = this.#core.inspect();
      if (!inspected.ok) return { ok: false, result: inspected };
      preserveEmptyCommitRetry =
        inspected.value.authority === null &&
        inspected.value.bucketName === null &&
        inspected.value.receiptCount === 0;
    }
    if (!preserveEmptyCommitRetry) {
      const claimed = this.#core.claimBucket(authorized);
      if (!claimed.ok) return { ok: false, result: claimed };
    }
    return { ok: true, authorized, coordinator: this.#coordinator(configuration) };
  }

  #coordinator(configuration?: ReceiptConfiguration) {
    const selected = configuration ?? this.#configuration();
    if (!selected) throw new Error("managed ObjectBucket receipt configuration unavailable");
    const transport = this.#env.TAKOSERVER_MANAGED_OBJECT_S3_TRANSPORT;
    const provider = new CloudflareManagedObjectS3({
      accountId: selected.accountId,
      accessKeyId: selected.accessKeyId,
      secretAccessKey: selected.secretAccessKey,
      maximumCandidates: 64,
      ...(transport ? { fetch: (request: Request) => transport.fetch(request) } : {}),
    });
    return new ManagedObjectReceiptCoordinator({
      core: this.#core,
      provider,
      storage: requiredAlarmStorage(this.#state),
    });
  }

  #configuration(authority?: ManagedObjectReceiptAuthority): ReceiptConfiguration | null {
    const providerId = this.#env.MANAGED_PROVIDER_ID;
    const accountId = this.#env.TAKOSERVER_MANAGED_OBJECT_ACCOUNT_ID;
    const accessKeyId = this.#env.TAKOSERVER_MANAGED_OBJECT_ACCESS_KEY_ID;
    const secretAccessKey = this.#env.TAKOSERVER_MANAGED_OBJECT_SECRET_ACCESS_KEY;
    const proofSecret = this.#env.TAKOSERVER_MANAGED_OBJECT_PROOF_SECRET;
    if (
      !authorityToken(providerId) ||
      (authority !== undefined && providerId !== authority.providerId) ||
      !plain(accountId, 128) ||
      !plain(accessKeyId, 512) ||
      !plain(secretAccessKey, 4_096) ||
      !authorityToken(proofSecret)
    ) {
      return null;
    }
    return { accountId, accessKeyId, secretAccessKey, proofSecret };
  }
}

function requiredAlarmStorage(state: ManagedObjectReceiptState) {
  const { setAlarm, deleteAlarm, deleteAll } = state.storage;
  if (!setAlarm || !deleteAlarm || !deleteAll) {
    throw new Error("managed ObjectBucket receipt alarm storage unavailable");
  }
  return {
    setAlarm: (time: number | Date) => setAlarm.call(state.storage, time),
    deleteAlarm: () => deleteAlarm.call(state.storage),
    deleteAll: () => deleteAll.call(state.storage),
  };
}

function authorityMatchesInspect(
  inspected: {
    readonly authority: ManagedObjectReceiptAuthority | null;
    readonly bucketName: string | null;
  },
  expected: { readonly authority: ManagedObjectReceiptAuthority; readonly bucketName: string },
): boolean {
  const actual = inspected.authority;
  return (
    actual !== null &&
    actual.schema === expected.authority.schema &&
    actual.providerId === expected.authority.providerId &&
    actual.resourceUid === expected.authority.resourceUid &&
    actual.incarnationId === expected.authority.incarnationId &&
    actual.generation === expected.authority.generation &&
    inspected.bucketName === expected.bucketName
  );
}

function withoutProof(body: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key !== "proof" && key !== "bucketName") result[key] = value;
  }
  return result;
}

function withoutRuntimeProof(body: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key !== "proof") result[key] = value;
  }
  return result;
}

function authorityValue(value: unknown): ManagedObjectReceiptAuthority | null {
  const body = exactRecord(value, [
    "schema",
    "providerId",
    "resourceUid",
    "incarnationId",
    "generation",
  ]);
  if (
    !body ||
    typeof body.schema !== "string" ||
    typeof body.providerId !== "string" ||
    typeof body.resourceUid !== "string" ||
    typeof body.incarnationId !== "string" ||
    typeof body.generation !== "string"
  ) {
    return null;
  }
  return body as unknown as ManagedObjectReceiptAuthority;
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return null;
  const expected = [...expectedKeys].sort();
  const actual = (keys as string[]).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
    ? (value as Record<string, unknown>)
    : null;
}

function recordHas(value: unknown, key: string): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, key);
}

function plain(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    hasNoControlCharacters(value)
  );
}

function hasNoControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

function authorityToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u.test(value);
}

function invalid(): ManagedObjectReceiptResult<never> {
  return { ok: false, error: { code: "invalid_argument" } };
}

function conflict(): ManagedObjectReceiptResult<never> {
  return { ok: false, error: { code: "conflict" } };
}

function unavailable(): ManagedObjectReceiptResult<never> {
  return { ok: false, error: { code: "backend_unavailable" } };
}
