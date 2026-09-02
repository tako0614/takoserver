import { DurableObject } from "cloudflare:workers";
import {
  type ManagedWorkerSqliteAdminResult,
  ManagedWorkerSqliteCore,
  type ManagedWorkerSqliteInspectResult,
  type ManagedWorkerSqliteMigrationIdentity,
  type ManagedWorkerSqliteState,
  type ManagedWorkerSqlResult,
  type ManagedWorkerSqlRpcResult,
} from "./cloudflare-managed-worker-sqlite.ts";

/**
 * Takoserver's provider-owned SQLite Durable Object.
 *
 * It must extend `DurableObject` from `cloudflare:workers`: a Durable Object
 * class that does not is reachable only through `fetch`, so every call below
 * would fail on a real stub however correct its body is. The gateway's
 * `SQLITE_DATABASES` binding names this exact export, and
 * `tests/cloudflare-managed-worker-sqlite-object.test.ts` calls each method as
 * RPC under the pinned workerd so the base class cannot be dropped again
 * without a test saying so.
 *
 * The behaviour lives in `ManagedWorkerSqliteCore`, which has no Cloudflare
 * intrinsic in it and is therefore testable against a faithful fake storage.
 * This class is identity and delegation, and nothing else — `fetch` is
 * deliberately inert so no HTTP path reaches customer tables or the migration
 * ledger.
 */
export class TakoserverManagedWorkerSqlite extends DurableObject {
  readonly #core: ManagedWorkerSqliteCore;

  constructor(ctx: ManagedWorkerSqliteState, env: unknown) {
    super(ctx as never, env as never);
    this.#core = new ManagedWorkerSqliteCore(ctx, env);
  }

  override fetch(_request?: Request): Response {
    return new Response(null, { status: 404 });
  }

  edgeSqlExecute(input: unknown): Promise<ManagedWorkerSqlRpcResult<ManagedWorkerSqlResult>> {
    return this.#core.edgeSqlExecute(input);
  }

  edgeSqlQuery(input: unknown): Promise<ManagedWorkerSqlRpcResult<ManagedWorkerSqlResult>> {
    return this.#core.edgeSqlQuery(input);
  }

  edgeSqlTransaction(
    input: unknown,
  ): Promise<ManagedWorkerSqlRpcResult<{ readonly results: readonly ManagedWorkerSqlResult[] }>> {
    return this.#core.edgeSqlTransaction(input);
  }

  takoserverSqliteInitialize(
    input: unknown,
  ): Promise<ManagedWorkerSqliteAdminResult<{ readonly state: "active" }>> {
    return this.#core.takoserverSqliteInitialize(input);
  }

  takoserverSqliteInspect(
    input: unknown,
  ): Promise<ManagedWorkerSqliteAdminResult<ManagedWorkerSqliteInspectResult>> {
    return this.#core.takoserverSqliteInspect(input);
  }

  takoserverSqliteReadMigrationLedger(
    input: unknown,
  ): Promise<ManagedWorkerSqliteAdminResult<readonly ManagedWorkerSqliteMigrationIdentity[]>> {
    return this.#core.takoserverSqliteReadMigrationLedger(input);
  }

  takoserverSqliteApplyMigrationSuffix(
    input: unknown,
  ): Promise<ManagedWorkerSqliteAdminResult<undefined>> {
    return this.#core.takoserverSqliteApplyMigrationSuffix(input);
  }

  takoserverSqliteDestroy(
    input: unknown,
  ): Promise<ManagedWorkerSqliteAdminResult<{ readonly destroyed: true }>> {
    return this.#core.takoserverSqliteDestroy(input);
  }
}
