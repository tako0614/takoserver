import { createHmac, timingSafeEqual } from "node:crypto";
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
    const grant = checkedGrant(input, options.store.targetKey);
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

  async function handle(request: Request): Promise<Response | null> {
    if (new URL(request.url).pathname !== SELFHOST_DATA_PLANE_SQL_PATH) return null;
    if (request.method !== "POST") return refusal("backend_unavailable", 405);
    const grant = authenticate(request);
    if (!grant) return refusal("backend_unavailable", 401);
    let body: SqlRequestBody | undefined;
    let payload: Record<string, unknown>;
    try {
      body = await readSqlRequestBody(request, stagingRoot);
      payload =
        body.kind === "inline"
          ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes))
          : { protocol: body.protocol, binding: body.binding, op: body.op };
      if (!record(payload) || payload.protocol !== SELFHOST_DATA_PLANE_PROTOCOL) throw new Error();
    } catch {
      body?.dispose();
      return refusal("backend_unavailable", 400);
    }
    const binding = payload.binding;
    const op = payload.op;
    try {
      if (typeof binding !== "string" || typeof op !== "string")
        return refusal("backend_unavailable", 400);
      const captured = await authorizedVector(grant, binding);
      if (!captured) return refusal("backend_unavailable", 200);
      const stillAuthorized = async () => {
        const current = await authorizedVector(grant, binding);
        return current?.resourceUid === captured.resourceUid && current.vector === captured.vector;
      };
      const value = await options.store.withAuthorizedDatabase({
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

  return Object.freeze({ issueGrant, handle });
}

function checkedGrant(input: unknown, targetKey: string): V2SqliteBindingGrant {
  if (
    !record(input) ||
    Object.keys(input).sort().join(",") !==
      "bindings,incarnationId,nativeVersionId,principal,servingSourceOperationId,space,targetKey,workerUid,workerVersionUid"
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
  };
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
