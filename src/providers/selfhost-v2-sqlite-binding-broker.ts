import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { parseStrictJson } from "../strict-json.ts";
import type {
  V2WorkerInvocationHandle,
  V2WorkerInvocationRecord,
  V2WorkerInvocationRetirementIdentity,
  V2WorkerSQLiteDrainInput,
} from "../worker-invocation-port.ts";
import {
  createSelfhostV2SqlitePlane,
  type EdgeSqlValue,
  SelfhostV2SqliteError,
  type SelfhostV2SqliteStatement,
} from "./selfhost-v2-sqlite-plane.ts";
import {
  checkedSqlStagingRoot,
  readSqlRequestBody,
  type SqlRequestBody,
} from "./selfhost-v2-sqlite-staged-input.ts";
import {
  type SelfhostV2SQLiteStore,
  SelfhostV2SQLiteStoreError,
  SQLITE_MIGRATION_LEDGER,
} from "./selfhost-v2-sqlite-store.ts";
import {
  SELFHOST_DATA_PLANE_CONTENT_TYPE,
  SELFHOST_DATA_PLANE_PROTOCOL,
  SELFHOST_DATA_PLANE_SQL_PATH,
} from "./selfhost-worker-wrapper.ts";

const UID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BINDING = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;
type ErrorCode = "sql_error" | "numeric_out_of_range" | "busy" | "backend_unavailable";

/** Host-issued, immutable selected-Version identity. DB generation is deliberately absent. */
export interface V2SqliteBindingGrant {
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly workerUid: string;
  readonly workerVersionUid: string;
  readonly nativeVersionId: string;
  readonly incarnationId: string;
  readonly servingSourceOperationId: string;
  readonly bindings: readonly { readonly name: string; readonly resourceUid: string }[];
  /** Host-private WfP selection; absent from the existing self-host grant. */
  readonly invocation?: {
    readonly handle: V2WorkerInvocationHandle;
    readonly expected: V2WorkerInvocationRetirementIdentity;
  };
}

export interface V2SqliteInvocationAuthority {
  /** Fixed D1 read of the exact existing custody row, not an arbitrary query. */
  read(handle: V2WorkerInvocationHandle): Promise<V2WorkerInvocationRecord | null>;
  /** Core statement-time CAS, called only after terminal proof and Node recovery. */
  confirmSQLiteDrained(input: V2WorkerSQLiteDrainInput): Promise<boolean>;
}

export interface V2SqliteSelectedVersionObservation {
  readonly kind: "confirmed";
  readonly workerUid: string;
  readonly versionId: string;
  readonly incarnationId: string;
  readonly servingSourceOperationId: string;
  readonly status: "active" | "draining";
}

export interface V2SqliteBindingBrokerOptions {
  readonly store: SelfhostV2SQLiteStore;
  /** Existing operator-private real directory; never chosen by a Worker. */
  readonly stagingRoot: string;
  /** A Host-private persistent key; never project it into a Worker service. */
  readonly signingKey: Uint8Array;
  /** Native owner readback, not a caller-supplied process-map assertion. */
  readonly observeVersionTarget: (input: {
    readonly workerUid: string;
    readonly versionId: string;
    readonly incarnationId: string;
    readonly servingSourceOperationId: string;
  }) => Promise<V2SqliteSelectedVersionObservation | { readonly kind: "unknown" }>;
  /** Core/current-publication proof mapping the accepted Version UID to native ID. */
  readonly graphStillCurrent: (grant: V2SqliteBindingGrant) => Promise<boolean>;
  /** Core-owned current settled Version-reference and database vector. */
  readonly resolveCurrentBinding: (
    grant: V2SqliteBindingGrant,
    binding: string,
  ) => Promise<{ readonly resourceUid: string; readonly vector: string } | null>;
  /** Opt-in WfP custody; require invocation-scoped grants when configured. */
  readonly invocationAuthority?: V2SqliteInvocationAuthority;
}

/**
 * Only this Host-private HTTP gate may open a UID database. The workerd
 * companion service holds the bearer; tenant code receives only three facade
 * methods and can never choose a database path, a raw handle, or a ledger.
 */
export function createSelfhostV2SqliteBindingBroker(options: V2SqliteBindingBrokerOptions) {
  if (
    !options?.store ||
    !(options.signingKey instanceof Uint8Array) ||
    options.signingKey.byteLength < 32 ||
    typeof options.observeVersionTarget !== "function" ||
    typeof options.graphStillCurrent !== "function" ||
    typeof options.resolveCurrentBinding !== "function"
  )
    throw new TypeError("private SQLite binding broker authority is required");
  const key = Buffer.from(options.signingKey);
  const stagingRoot = checkedSqlStagingRoot(options.stagingRoot);

  function issueGrant(input: V2SqliteBindingGrant): string {
    const grant = checkedGrant(input, options.store.targetKey, !!options.invocationAuthority);
    const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
    const signature = createHmac("sha256", key).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  function authenticate(request: Request): V2SqliteBindingGrant | null {
    const header = request.headers.get("authorization");
    if (!header?.startsWith("Bearer ") || header.length > 32768) return null;
    const parts = header.slice(7).split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const signature = createHmac("sha256", key).update(parts[0]).digest();
    let offered: Buffer;
    try {
      offered = Buffer.from(parts[1], "base64url");
    } catch {
      return null;
    }
    if (
      offered.length !== signature.length ||
      offered.toString("base64url") !== parts[1] ||
      !timingSafeEqual(offered, signature)
    )
      return null;
    try {
      return checkedGrant(
        JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
        options.store.targetKey,
        !!options.invocationAuthority,
      );
    } catch {
      return null;
    }
  }

  async function authorizedVector(
    grant: V2SqliteBindingGrant,
    binding: string,
  ): Promise<{
    readonly resourceUid: string;
    readonly vector: string;
  } | null> {
    const desired = grant.bindings.find((entry) => entry.name === binding);
    if (!desired) return null;
    const observation = await options.observeVersionTarget({
      workerUid: grant.workerUid,
      versionId: grant.nativeVersionId,
      incarnationId: grant.incarnationId,
      servingSourceOperationId: grant.servingSourceOperationId,
    });
    if (
      observation.kind !== "confirmed" ||
      observation.workerUid !== grant.workerUid ||
      observation.versionId !== grant.nativeVersionId ||
      observation.incarnationId !== grant.incarnationId ||
      observation.servingSourceOperationId !== grant.servingSourceOperationId ||
      !["active", "draining"].includes(observation.status) ||
      !(await options.graphStillCurrent(grant))
    )
      return null;

    return await options.resolveCurrentBinding(grant, binding);
  }

  async function invocationProof(
    grant: V2SqliteBindingGrant,
    terminal: boolean,
  ): Promise<V2WorkerInvocationRecord | null> {
    if (!options.invocationAuthority) return null;
    const selected = grant.invocation;
    if (!selected) return null;
    const row = await options.invocationAuthority.read(selected.handle);
    if (
      !row ||
      row.handle.invocationId !== selected.handle.invocationId ||
      row.handle.custodyToken !== selected.handle.custodyToken ||
      !sameInvocationIdentity(row, selected.expected) ||
      row.principal !== grant.principal ||
      row.space !== grant.space ||
      row.targetKey !== grant.targetKey ||
      row.workerUid !== grant.workerUid ||
      row.versionUid !== grant.workerVersionUid ||
      row.sourceOperationId !== grant.servingSourceOperationId ||
      row.phase !== "send_authorized" ||
      row.noNativeDispatchAtMs !== null ||
      (terminal
        ? row.sqliteDrainState !== "pending" && row.sqliteDrainState !== "drained"
        : row.sqliteDrainState !== "pending") ||
      (terminal ? row.retirement === null : row.retirement !== null)
    )
      return null;
    return row;
  }

  async function handle(request: Request): Promise<Response | null> {
    if (new URL(request.url).pathname !== SELFHOST_DATA_PLANE_SQL_PATH) return null;
    if (request.method !== "POST") return refusal("backend_unavailable", 405);
    const grant = authenticate(request);
    if (!grant) return refusal("backend_unavailable", 401);
    let body: SqlRequestBody | undefined;
    let payload: Record<string, unknown>;
    try {
      body = await readSqlRequestBody(request, stagingRoot);
      const parsed: unknown =
        body.kind === "inline"
          ? parseStrictJson(body.bytes, 1_048_576)
          : { protocol: body.protocol, binding: body.binding, op: body.op };
      if (!record(parsed) || parsed.protocol !== SELFHOST_DATA_PLANE_PROTOCOL) throw new Error();
      if (body.kind === "inline") {
        const keys = Object.keys(parsed).sort().join(",");
        if (
          ((parsed.op === "execute" || parsed.op === "query") &&
            keys !== "binding,op,protocol,statement") ||
          (parsed.op === "transaction" && keys !== "binding,op,protocol,statements") ||
          (parsed.op !== "execute" && parsed.op !== "query" && parsed.op !== "transaction")
        )
          throw new Error();
      }
      payload = parsed;
    } catch {
      body?.dispose();
      return refusal("backend_unavailable", 400);
    }
    const binding = payload.binding;
    const op = payload.op;
    try {
      if (typeof binding !== "string" || typeof op !== "string")
        return refusal("backend_unavailable", 400);
      const execute = async () => {
        const captured = await authorizedVector(grant, binding);
        if (!captured) throw new SelfhostV2SqliteError("backend_unavailable");
        const stillAuthorized = async () => {
          if (options.invocationAuthority && !(await invocationProof(grant, false))) return false;
          const current = await authorizedVector(grant, binding);
          return (
            current?.resourceUid === captured.resourceUid && current.vector === captured.vector
          );
        };
        return await options.store.withAuthorizedDatabase({
          resourceUid: captured.resourceUid,
          stillAuthorized,
          use: async (database) => {
            if (!(await stillAuthorized())) throw new SelfhostV2SqliteError("backend_unavailable");
            const plane = createSelfhostV2SqlitePlane({
              database,
              migrationLedger: SQLITE_MIGRATION_LEDGER,
            });
            let result: unknown;
            if (op === "execute" || op === "query") {
              const statement = body.kind === "staged" ? body.statementAt(0) : payload.statement;
              if (!record(statement)) throw new SelfhostV2SqliteError("sql_error");
              result =
                op === "execute"
                  ? await plane.execute(
                      statement.sql as string,
                      statement.params as readonly EdgeSqlValue[] | undefined,
                    )
                  : await plane.query(
                      statement.sql as string,
                      statement.params as readonly EdgeSqlValue[] | undefined,
                    );
            } else if (op === "transaction") {
              if (body.kind === "staged") {
                result = await plane.transactionStaged(function* () {
                  for (let index = 0; index < body.count; index += 1) yield body.statementAt(index);
                });
              } else {
                result = await plane.transaction(
                  payload.statements as readonly SelfhostV2SqliteStatement[],
                );
              }
            } else throw new SelfhostV2SqliteError("sql_error");
            if (!(await stillAuthorized())) throw new SelfhostV2SqliteError("backend_unavailable");
            return result;
          },
        });
      };
      const value = options.invocationAuthority
        ? await options.store.withInvocationLock(
            grant.invocation?.handle.invocationId ?? "",
            execute,
          )
        : await execute();
      return new Response(JSON.stringify({ ok: true, value }), {
        status: 200,
        headers: { "content-type": SELFHOST_DATA_PLANE_CONTENT_TYPE },
      });
    } catch (error) {
      const code: ErrorCode =
        error instanceof SelfhostV2SqliteError
          ? error.code
          : error instanceof SelfhostV2SQLiteStoreError && error.code === "busy"
            ? "busy"
            : "backend_unavailable";
      return refusal(code, 200);
    } finally {
      body.dispose();
    }
  }

  /** Trusted Tail path only; the HTTP handler never calls or exposes this. */
  async function drainInvocation(input: V2SqliteBindingGrant): Promise<boolean> {
    const authority = options.invocationAuthority;
    if (!authority) throw new TypeError("SQLite invocation authority is not configured");
    const grant = checkedGrant(input, options.store.targetKey, true);
    const selected = grant.invocation;
    if (!selected) return false;
    return options.store.withInvocationLock(selected.handle.invocationId, async () => {
      const terminal = await invocationProof(grant, true);
      if (!terminal?.retirement) return false;
      const expected = selected.expected;
      const receiptDigest = `sha256:${createHash("sha256")
        .update(
          JSON.stringify([
            1,
            selected.handle.invocationId,
            selected.handle.custodyToken,
            expected.backendId,
            expected.targetKey,
            expected.principal,
            expected.space,
            expected.workerUid,
            expected.deploymentUid,
            expected.deploymentGeneration,
            expected.sourceOperationId,
            Object.entries(expected.ingress).sort(),
            expected.versionUid,
            expected.versionGeneration,
            expected.versionOperationId,
            expected.nativeIdentity,
            expected.closureDigest,
            expected.confirmedReceipt,
            terminal.retirement.receiptDigest,
            [...new Set(grant.bindings.map((entry) => entry.resourceUid))].sort(),
          ]),
        )
        .digest("hex")}` as const;
      if (terminal.sqliteDrainState === "drained") {
        return terminal.sqliteDrainReceiptDigest === receiptDigest;
      }
      for (const uid of [...new Set(grant.bindings.map((entry) => entry.resourceUid))].sort()) {
        if (!(await options.store.recoverOwnedDatabase(uid))) return false;
      }
      return await authority.confirmSQLiteDrained({
        handle: selected.handle,
        expected: selected.expected,
        receiptDigest,
      });
    });
  }

  return Object.freeze({ issueGrant, handle, drainInvocation });
}

function checkedGrant(
  input: unknown,
  targetKey: string,
  requireInvocation: boolean,
): V2SqliteBindingGrant {
  if (
    !record(input) ||
    Object.keys(input).sort().join(",") !==
      (requireInvocation
        ? "bindings,incarnationId,invocation,nativeVersionId,principal,servingSourceOperationId,space,targetKey,workerUid,workerVersionUid"
        : "bindings,incarnationId,nativeVersionId,principal,servingSourceOperationId,space,targetKey,workerUid,workerVersionUid")
  ) {
    throw new TypeError("invalid SQLite binding grant");
  }
  for (const key of [
    "principal",
    "space",
    "targetKey",
    "workerUid",
    "workerVersionUid",
    "nativeVersionId",
    "incarnationId",
    "servingSourceOperationId",
  ] as const) {
    if (typeof input[key] !== "string" || input[key].length === 0 || input[key].length > 256)
      throw new TypeError("invalid SQLite binding grant identity");
  }
  for (const key of ["workerUid", "workerVersionUid", "servingSourceOperationId"] as const) {
    if (!UID.test(input[key] as string)) throw new TypeError("invalid SQLite binding grant UID");
  }
  if (
    input.targetKey !== targetKey ||
    !Array.isArray(input.bindings) ||
    input.bindings.length < 1 ||
    input.bindings.length > 64
  ) {
    throw new TypeError("invalid SQLite binding grant target");
  }
  const names = new Set<string>();
  const bindings = input.bindings.map((value) => {
    if (
      !record(value) ||
      Object.keys(value).sort().join(",") !== "name,resourceUid" ||
      typeof value.name !== "string" ||
      !BINDING.test(value.name) ||
      typeof value.resourceUid !== "string" ||
      !UID.test(value.resourceUid) ||
      names.has(value.name)
    ) {
      throw new TypeError("invalid SQLite binding grant entry");
    }
    names.add(value.name);
    return { name: value.name, resourceUid: value.resourceUid };
  });
  let invocation: V2SqliteBindingGrant["invocation"];
  if (requireInvocation) {
    const selected = input.invocation;
    if (
      !record(selected) ||
      Object.keys(selected).sort().join(",") !== "expected,handle" ||
      !record(selected.handle) ||
      Object.keys(selected.handle).sort().join(",") !== "custodyToken,invocationId" ||
      typeof selected.handle.invocationId !== "string" ||
      selected.handle.invocationId.length < 1 ||
      selected.handle.invocationId.length > 255 ||
      typeof selected.handle.custodyToken !== "string" ||
      selected.handle.custodyToken.length < 16 ||
      selected.handle.custodyToken.length > 255 ||
      !record(selected.expected) ||
      selected.expected.targetKey !== targetKey ||
      selected.expected.principal !== input.principal ||
      selected.expected.space !== input.space ||
      selected.expected.workerUid !== input.workerUid ||
      selected.expected.versionUid !== input.workerVersionUid ||
      selected.expected.sourceOperationId !== input.servingSourceOperationId
    )
      throw new TypeError("invalid SQLite invocation grant");
    invocation = {
      handle: selected.handle as unknown as V2WorkerInvocationHandle,
      expected: selected.expected as unknown as V2WorkerInvocationRetirementIdentity,
    };
  }
  return {
    principal: input.principal as string,
    space: input.space as string,
    targetKey: input.targetKey as string,
    workerUid: input.workerUid as string,
    workerVersionUid: input.workerVersionUid as string,
    nativeVersionId: input.nativeVersionId as string,
    incarnationId: input.incarnationId as string,
    servingSourceOperationId: input.servingSourceOperationId as string,
    bindings,
    ...(invocation ? { invocation } : {}),
  };
}

function sameInvocationIdentity(
  actual: V2WorkerInvocationRetirementIdentity,
  expected: V2WorkerInvocationRetirementIdentity,
): boolean {
  for (const key of [
    "backendId",
    "targetKey",
    "principal",
    "space",
    "workerUid",
    "deploymentUid",
    "deploymentGeneration",
    "sourceOperationId",
    "versionUid",
    "versionGeneration",
    "versionOperationId",
    "nativeIdentity",
    "closureDigest",
    "confirmedReceipt",
  ] as const) {
    if (actual[key] !== expected[key]) return false;
  }
  return (
    actual.ingress.kind === expected.ingress.kind &&
    JSON.stringify(Object.entries(actual.ingress).sort()) ===
      JSON.stringify(Object.entries(expected.ingress).sort())
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function refusal(code: ErrorCode, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error: { code } }), {
    status,
    headers: { "content-type": SELFHOST_DATA_PLANE_CONTENT_TYPE },
  });
}
