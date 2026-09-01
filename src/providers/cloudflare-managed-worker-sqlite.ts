/** The only values that cross the customer-facing edge.sql RPC. */
export type ManagedWorkerSqlValue =
  | null
  | string
  | number
  | { readonly encoding: "base64"; readonly data: string };

type ManagedWorkerSqlStorageValue = ArrayBuffer | string | number | null;

interface ManagedWorkerSqlStorageCursor<T extends Record<string, ManagedWorkerSqlStorageValue>> {
  toArray(): T[];
  readonly rowsWritten: number;
}

export interface ManagedWorkerSqliteKvStorage {
  get<T = unknown>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
}

export interface ManagedWorkerSqliteStorage {
  exec<T extends Record<string, ManagedWorkerSqlStorageValue>>(
    query: string,
    ...bindings: ManagedWorkerSqlStorageValue[]
  ): ManagedWorkerSqlStorageCursor<T>;
}

export interface ManagedWorkerSqliteState {
  readonly storage: {
    readonly sql: ManagedWorkerSqliteStorage;
    readonly kv: ManagedWorkerSqliteKvStorage;
    transactionSync<T>(callback: () => T): T;
  };
}

export interface ManagedWorkerSqlStatement {
  readonly sql: string;
  readonly params?: readonly ManagedWorkerSqlValue[];
}

export interface ManagedWorkerSqlResult {
  readonly rows: readonly Readonly<Record<string, ManagedWorkerSqlValue>>[];
  readonly rowsWritten: number;
}

export type ManagedWorkerSqlRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "sql_error" | "numeric_out_of_range" | "busy" | "backend_unavailable";
      };
    };

export interface ManagedWorkerSqliteAuthority {
  /** Provider identity. This is not exposed through the customer facade. */
  readonly providerId: string;
  /** Opaque Host Resource UID; never used as a public DO instance name. */
  readonly resourceUid: string;
  /** Positive decimal generation selected by the Host. */
  readonly generation: string;
  readonly operationId: string;
  readonly descriptorDigest: `sha256:${string}`;
}

export interface ManagedWorkerSqliteMigrationIdentity {
  readonly path: string;
  readonly digest: `sha256:${string}`;
}

export interface ManagedWorkerSqliteMigration extends ManagedWorkerSqliteMigrationIdentity {
  readonly sql: Uint8Array;
}

export type ManagedWorkerSqliteAdminResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "invalid_argument" | "conflict" | "not_found" | "backend_unavailable";
      };
    };

export interface ManagedWorkerSqliteInspectResult {
  readonly state: "active" | "destroyed";
  readonly authority: ManagedWorkerSqliteAuthority;
  readonly migrations: readonly ManagedWorkerSqliteMigrationIdentity[];
}

export const MANAGED_SQLITE_CONTROL_KEY = "takoserver.managed-sqlite.control" as const;
export const MANAGED_SQLITE_CONTROL_SCHEMA = "takoserver.managed-sqlite-control@v2" as const;
const LEGACY_IDENTITY_TABLE = "_takoserver_sqlite_identity";
const LEGACY_LEDGER_TABLE = "_takoform_sqlite_migrations";
const LEGACY_DESTROYED_TABLE = "_takoserver_sqlite_destroyed";
const LEGACY_CONTROL_TABLE_NAMES = [
  LEGACY_IDENTITY_TABLE,
  LEGACY_DESTROYED_TABLE,
  LEGACY_LEDGER_TABLE,
] as const;
const MAX_SQL_BYTES = 100_000;
const MAX_SQL_PARAMETERS = 100;
const MAX_SQL_STATEMENTS = 100;
const MAX_MIGRATION_HISTORY = 100;
const MAX_CONTROL_RECORD_BYTES = 128 * 1024;
const MAX_SQL_ROWS = 10_000;
const MAX_SQL_COLUMNS = 100;
const MAX_SQL_VALUE_BYTES = 1_000_000;
const MAX_SQL_ROW_BYTES = 2_000_000;
const MAX_SQL_RESULT_BYTES = 8_388_608;
const MAX_PATH_BYTES = 255;
const MAX_TOKEN_BYTES = 512;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u;
const GENERATION = /^[1-9][0-9]{0,18}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SQL_ERROR = "sql_error" as const;
const NUMERIC_ERROR = "numeric_out_of_range" as const;
const BUSY_ERROR = "busy" as const;
const BACKEND_ERROR = "backend_unavailable" as const;
const QUERY_ROLLBACK = Symbol("takoserver-query-rollback");

interface ManagedWorkerSqliteControlRecord {
  readonly schema: typeof MANAGED_SQLITE_CONTROL_SCHEMA;
  readonly lifecycle: "active" | "destroyed";
  readonly authority: ManagedWorkerSqliteAuthority;
  readonly migrations: readonly ManagedWorkerSqliteMigrationIdentity[];
}

/**
 * Derives a bounded opaque SQLite DO instance name. A caller with a private
 * provider secret may pass it as `instanceSecret`; portable tests can omit the
 * secret and still get deterministic non-reversible names. Raw resource UIDs
 * never enter the Cloudflare binding or URL.
 */
export async function managedWorkerSqliteInstanceName(input: {
  readonly providerId: string;
  readonly resourceUid: string;
  readonly generation: string;
  readonly instanceSecret?: string;
}): Promise<string> {
  assertToken(input.providerId);
  assertToken(input.resourceUid);
  assertGeneration(input.generation);
  const payload = `${input.providerId}\0${input.resourceUid}\0${input.generation}`;
  const bytes = new TextEncoder().encode(payload);
  let digest: ArrayBuffer;
  if (input.instanceSecret !== undefined) {
    assertToken(input.instanceSecret);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(input.instanceSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    digest = await crypto.subtle.sign("HMAC", key, bytes);
  } else {
    digest = await crypto.subtle.digest("SHA-256", bytes);
  }
  return `tsdb-${base64Url(new Uint8Array(digest)).slice(0, 43)}`;
}

/**
 * Takoserver's provider-owned SQLite Durable Object. Runtime calls are RPC
 * methods only; `fetch` is intentionally inert so no public HTTP admin path
 * can reach customer tables or migration history.
 */
export class TakoserverManagedWorkerSqlite {
  readonly #ctx: ManagedWorkerSqliteState;
  readonly #sql: ManagedWorkerSqliteStorage;

  constructor(ctx: ManagedWorkerSqliteState, env: unknown) {
    void env;
    this.#ctx = ctx;
    this.#sql = ctx.storage.sql;
  }

  fetch(_request?: Request): Response {
    return new Response(null, { status: 404 });
  }

  async edgeSqlExecute(input: unknown): Promise<ManagedWorkerSqlRpcResult<ManagedWorkerSqlResult>> {
    return await this.#runtime(input, "execute");
  }

  async edgeSqlQuery(input: unknown): Promise<ManagedWorkerSqlRpcResult<ManagedWorkerSqlResult>> {
    return await this.#runtime(input, "query");
  }

  async edgeSqlTransaction(
    input: unknown,
  ): Promise<ManagedWorkerSqlRpcResult<{ readonly results: readonly ManagedWorkerSqlResult[] }>> {
    try {
      const statements = parseStatements(input);
      if (statements.length < 1 || statements.length > MAX_SQL_STATEMENTS) {
        return failure(SQL_ERROR);
      }
      let results: readonly ManagedWorkerSqlResult[] = [];
      this.#transactionSync(() => {
        const materialized: ManagedWorkerSqlResult[] = [];
        for (const statement of statements) {
          materialized.push(this.#executeSql(statement));
        }
        results = materialized;
      });
      return success({ results });
    } catch (error) {
      return failure(mapError(error));
    }
  }

  async takoserverSqliteInitialize(
    input: unknown,
  ): Promise<ManagedWorkerSqliteAdminResult<{ readonly state: "active" }>> {
    const authority = parseAuthority(input);
    if (!authority) return adminFailure("invalid_argument");
    try {
      this.#transactionSync(() => {
        const existing = this.#readControl();
        if (existing !== null) {
          if (existing.lifecycle !== "active" || !sameAuthority(existing.authority, authority)) {
            throw new AdminSentinel("conflict");
          }
          return;
        }
        // A pre-v2 ordinary control table is not an authority source. If it is
        // present without a v2 record, stop for operator reconciliation rather
        // than silently adopting or deleting its contents.
        this.#assertNoLegacyControlTables();
        this.#writeControl({
          lifecycle: "active",
          authority,
          migrations: [],
        });
      });
      return adminSuccess({ state: "active" });
    } catch (error) {
      return adminFailure(error instanceof AdminSentinel ? error.code : "backend_unavailable");
    }
  }

  async takoserverSqliteInspect(
    input: unknown,
  ): Promise<ManagedWorkerSqliteAdminResult<ManagedWorkerSqliteInspectResult>> {
    const authority = parseAuthority(input);
    if (!authority) return adminFailure("invalid_argument");
    try {
      const control = this.#readControl();
      if (control === null) {
        this.#assertNoLegacyControlTables();
        return adminFailure("not_found");
      }
      if (!sameAuthority(control.authority, authority)) return adminFailure("not_found");
      return adminSuccess({
        state: control.lifecycle,
        authority: control.authority,
        migrations: control.migrations,
      });
    } catch {
      return adminFailure("backend_unavailable");
    }
  }

  async takoserverSqliteReadMigrationLedger(
    input: unknown,
  ): Promise<ManagedWorkerSqliteAdminResult<readonly ManagedWorkerSqliteMigrationIdentity[]>> {
    const authority = parseAuthority(input);
    if (!authority) return adminFailure("invalid_argument");
    try {
      const control = this.#assertActiveAuthority(authority);
      return adminSuccess(control.migrations);
    } catch (error) {
      return adminFailure(error instanceof AdminSentinel ? error.code : "backend_unavailable");
    }
  }

  async takoserverSqliteApplyMigrationSuffix(
    input: unknown,
  ): Promise<ManagedWorkerSqliteAdminResult<undefined>> {
    const parsed = parseMigrationInput(input);
    if (!parsed) return adminFailure("invalid_argument");
    let digests: readonly `sha256:${string}`[];
    try {
      digests = await Promise.all(
        parsed.migrations.map(async (migration) => {
          const digest = `sha256:${hex(
            new Uint8Array(
              await crypto.subtle.digest("SHA-256", migration.sql as unknown as BufferSource),
            ),
          )}` as const;
          if (digest !== migration.digest) throw new AdminSentinel("invalid_argument");
          return digest;
        }),
      );
    } catch (error) {
      return adminFailure(error instanceof AdminSentinel ? error.code : "invalid_argument");
    }
    try {
      this.#transactionSync(() => {
        const control = this.#assertActiveAuthority(parsed.authority);
        const current = control.migrations;
        if (!sameMigrationsPrefix(current, parsed.expectedPrefix)) {
          throw new AdminSentinel("conflict");
        }
        const identities = parsed.migrations.map((migration, index) => {
          const digest = digests[index];
          if (!digest) throw new AdminSentinel("invalid_argument");
          return { path: migration.path, digest };
        });
        const requested = [...parsed.expectedPrefix, ...identities];
        // A caller may have lost the acknowledgement after the transaction
        // committed. An exact already-applied suffix is a successful retry and
        // must not execute customer SQL a second time.
        if (sameMigrations(current, requested)) return;
        if (current.length !== parsed.expectedPrefix.length) {
          throw new AdminSentinel("conflict");
        }
        if (requested.length > MAX_MIGRATION_HISTORY || hasDuplicateMigrationPath(requested)) {
          throw new AdminSentinel("invalid_argument");
        }
        const paths = new Set(current.map((entry) => entry.path));
        for (let index = 0; index < parsed.migrations.length; index += 1) {
          const migration = parsed.migrations[index];
          if (!migration) throw new AdminSentinel("invalid_argument");
          if (paths.has(migration.path)) throw new AdminSentinel("conflict");
          const digest = digests[index];
          if (!digest) throw new AdminSentinel("invalid_argument");
          const sql = decodeMigrationSql(migration.sql);
          validateMigrationSql(sql);
          this.#sql.exec(sql);
          paths.add(migration.path);
        }
        this.#writeControl({
          lifecycle: "active",
          authority: control.authority,
          migrations: requested,
        });
      });
      return adminSuccess(undefined);
    } catch (error) {
      return adminFailure(error instanceof AdminSentinel ? error.code : "backend_unavailable");
    }
  }

  async takoserverSqliteDestroy(
    input: unknown,
  ): Promise<ManagedWorkerSqliteAdminResult<{ readonly destroyed: true }>> {
    const authority = parseAuthority(input);
    if (!authority) return adminFailure("invalid_argument");
    try {
      this.#transactionSync(() => {
        const control = this.#readControl();
        if (control === null) {
          this.#assertNoLegacyControlTables();
          throw new AdminSentinel("not_found");
        }
        if (control.lifecycle === "destroyed") {
          if (!sameAuthority(control.authority, authority)) throw new AdminSentinel("conflict");
          return;
        }
        if (!sameAuthority(control.authority, authority)) {
          throw new AdminSentinel("not_found");
        }
        this.#dropCustomerObjects();
        this.#writeControl({
          lifecycle: "destroyed",
          authority: control.authority,
          migrations: control.migrations,
        });
      });
      return adminSuccess({ destroyed: true });
    } catch (error) {
      return adminFailure(error instanceof AdminSentinel ? error.code : "backend_unavailable");
    }
  }

  async #runtime(
    input: unknown,
    operation: "execute" | "query",
  ): Promise<ManagedWorkerSqlRpcResult<ManagedWorkerSqlResult>> {
    try {
      const statement = parseStatement(input);
      let result: ManagedWorkerSqlResult;
      if (operation === "query") {
        let selected: ManagedWorkerSqlResult | undefined;
        try {
          this.#transactionSync(() => {
            selected = this.#executeSql(statement);
            throw QUERY_ROLLBACK;
          });
        } catch (error) {
          if (error !== QUERY_ROLLBACK) throw error;
        }
        if (!selected) throw new Error("missing query result");
        result = { rows: selected.rows, rowsWritten: 0 };
      } else {
        result = this.#executeSql(statement);
      }
      return success(result);
    } catch (error) {
      return failure(mapError(error));
    }
  }

  #executeSql(statement: ManagedWorkerSqlStatement): ManagedWorkerSqlResult {
    this.#assertActiveRuntime();
    const cursor = this.#sql.exec<Record<string, ArrayBuffer | string | number | null>>(
      statement.sql,
      ...(statement.params ?? []).map(toNativeValue),
    );
    const rows = cursor.toArray().map((row) => projectRow(row));
    if (
      rows.length > MAX_SQL_ROWS ||
      rows.some((row) => utf8(JSON.stringify(row)) > MAX_SQL_ROW_BYTES)
    ) {
      throw new SqlSentinel(BACKEND_ERROR);
    }
    const rowsWritten = cursor.rowsWritten;
    if (!Number.isSafeInteger(rowsWritten) || rowsWritten < 0) throw new SqlSentinel(BACKEND_ERROR);
    const result = { rows, rowsWritten };
    if (utf8(JSON.stringify(result)) > MAX_SQL_RESULT_BYTES) throw new SqlSentinel(BACKEND_ERROR);
    return result;
  }

  #assertActiveRuntime(): void {
    const control = this.#readControl();
    if (control === null || control.lifecycle !== "active") {
      throw new SqlSentinel(BACKEND_ERROR);
    }
  }

  #assertActiveAuthority(
    authority: ManagedWorkerSqliteAuthority,
  ): ManagedWorkerSqliteControlRecord {
    const control = this.#readControl();
    if (control === null) {
      this.#assertNoLegacyControlTables();
      throw new AdminSentinel("not_found");
    }
    if (control.lifecycle !== "active" || !sameAuthority(control.authority, authority)) {
      throw new AdminSentinel("conflict");
    }
    return control;
  }

  #readControl(): ManagedWorkerSqliteControlRecord | null {
    const value = this.#ctx.storage.kv.get<unknown>(MANAGED_SQLITE_CONTROL_KEY);
    if (value === undefined) return null;
    const control = parseControlRecord(value);
    if (control === null) throw new AdminSentinel("backend_unavailable");
    return control;
  }

  #writeControl(input: {
    readonly lifecycle: "active" | "destroyed";
    readonly authority: ManagedWorkerSqliteAuthority;
    readonly migrations: readonly ManagedWorkerSqliteMigrationIdentity[];
  }): void {
    const record: ManagedWorkerSqliteControlRecord = {
      schema: MANAGED_SQLITE_CONTROL_SCHEMA,
      lifecycle: input.lifecycle,
      authority: input.authority,
      migrations: [...input.migrations],
    };
    if (!validControlRecord(record)) throw new AdminSentinel("backend_unavailable");
    this.#ctx.storage.kv.put(MANAGED_SQLITE_CONTROL_KEY, record);
  }

  #assertNoLegacyControlTables(): void {
    const rows = this.#sql
      .exec<Record<string, string>>(
        "SELECT name FROM sqlite_schema WHERE name IN (?, ?, ?) LIMIT 4",
        ...LEGACY_CONTROL_TABLE_NAMES,
      )
      .toArray();
    if (rows.some((row) => typeof row.name === "string")) {
      throw new AdminSentinel("backend_unavailable");
    }
  }

  #dropCustomerObjects(): void {
    const objects = this.#sql
      .exec<Record<string, string>>(
        "SELECT type, name FROM sqlite_schema WHERE name <> ? ORDER BY CASE type WHEN 'trigger' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, name",
        "__cf_kv",
      )
      .toArray();
    for (const object of objects) {
      const name = object.name;
      if (typeof name !== "string") continue;
      // SQLite creates indexes such as `sqlite_autoindex_*` (and other
      // `sqlite_*` bookkeeping objects) that cannot be dropped by customer
      // code. They are not customer-owned objects; all other names are
      // quoted below, including names containing whitespace or quotes.
      if (name.startsWith("sqlite_") || name === "__cf_kv") continue;
      const type =
        object.type === "table" ||
        object.type === "view" ||
        object.type === "trigger" ||
        object.type === "index"
          ? object.type
          : null;
      if (type === null) continue;
      this.#sql.exec(
        `${type === "index" ? "DROP INDEX" : `DROP ${type.toUpperCase()}`} ${quoteIdentifier(name)}`,
      );
    }
  }

  #transactionSync<T>(callback: () => T): T {
    // `transactionSync` is available only on SQLite-backed Durable Objects.
    // Keeping the call in one small method makes the rollback boundary obvious
    // and keeps tests able to provide a faithful fake storage.
    return this.#ctx.storage.transactionSync(callback);
  }
}

class SqlSentinel extends Error {
  constructor(
    readonly code: "sql_error" | "numeric_out_of_range" | "busy" | "backend_unavailable",
  ) {
    super(code);
  }
}

class AdminSentinel extends Error {
  constructor(
    readonly code: "invalid_argument" | "conflict" | "not_found" | "backend_unavailable",
  ) {
    super(code);
  }
}

function parseStatement(value: unknown): ManagedWorkerSqlStatement {
  if (!isRecord(value) || !onlyKeys(value, ["sql", "params"]) || typeof value.sql !== "string") {
    throw new SqlSentinel(SQL_ERROR);
  }
  validateSql(value.sql);
  const params = value.params === undefined ? undefined : parseValues(value.params);
  return params === undefined ? { sql: value.sql } : { sql: value.sql, params };
}

function parseStatements(value: unknown): readonly ManagedWorkerSqlStatement[] {
  if (!isRecord(value) || !onlyKeys(value, ["statements"]) || !Array.isArray(value.statements)) {
    throw new SqlSentinel(SQL_ERROR);
  }
  return value.statements.map(parseStatement);
}

function parseValues(value: unknown): readonly ManagedWorkerSqlValue[] {
  if (!Array.isArray(value) || value.length > MAX_SQL_PARAMETERS) throw new SqlSentinel(SQL_ERROR);
  return value.map((item) => {
    if (item === null || typeof item === "string") {
      if (typeof item === "string" && utf8(item) > MAX_SQL_VALUE_BYTES)
        throw new SqlSentinel(SQL_ERROR);
      return item;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item) || Math.abs(item) > Number.MAX_SAFE_INTEGER) {
        throw new SqlSentinel(NUMERIC_ERROR);
      }
      return item;
    }
    if (
      isRecord(item) &&
      onlyKeys(item, ["encoding", "data"]) &&
      item.encoding === "base64" &&
      typeof item.data === "string" &&
      validBase64(item.data, MAX_SQL_VALUE_BYTES)
    ) {
      return { encoding: "base64", data: item.data };
    }
    throw new SqlSentinel(SQL_ERROR);
  });
}

function validateSql(sql: string): void {
  if (utf8(sql) === 0 || utf8(sql) > MAX_SQL_BYTES || sql.includes("\u0000")) {
    throw new SqlSentinel(SQL_ERROR);
  }
  const stripped = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//gu, "").trim();
  const withoutTrailingSemicolon = stripped.endsWith(";") ? stripped.slice(0, -1).trim() : stripped;
  if (!withoutTrailingSemicolon || withoutTrailingSemicolon.includes(";"))
    throw new SqlSentinel(SQL_ERROR);
  if (containsProtectedIdentifier(withoutTrailingSemicolon)) {
    throw new SqlSentinel(SQL_ERROR);
  }
  if (
    /\b(?:begin|commit|end|rollback|savepoint|release|attach|detach|vacuum|pragma|create|alter|drop|reindex|replace)\b/iu.test(
      withoutTrailingSemicolon,
    )
  ) {
    throw new SqlSentinel(SQL_ERROR);
  }
}

/**
 * Migration SQL is provider supplied and may contain DDL/multiple statements,
 * unlike the customer edge.sql facade. It still must never be able to address
 * provider-owned tables. Strip comments before checking so a comment between
 * identifier fragments (or a quoted/bracketed identifier) cannot bypass the
 * reservation. The check is intentionally conservative: mentioning a reserved
 * token in a literal/comment also fails closed rather than risking a provider
 * table leak.
 */
function validateMigrationSql(sql: string): void {
  if (utf8(sql) === 0 || utf8(sql) > MAX_SQL_BYTES || sql.includes("\u0000")) {
    throw new AdminSentinel("invalid_argument");
  }
  const stripped = stripSqlComments(sql);
  if (containsProtectedIdentifier(sql) || containsProtectedIdentifier(stripped)) {
    throw new AdminSentinel("invalid_argument");
  }
}

function containsProtectedIdentifier(sql: string): boolean {
  return /(?:^|[^A-Za-z0-9_$])(?:__cf_kv|sqlite_schema|sqlite_master|sqlite_temp_schema|sqlite_temp_master|sqlite_sequence)(?=$|[^A-Za-z0-9_$])/iu.test(
    sql,
  );
}

function decodeMigrationSql(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new AdminSentinel("invalid_argument");
  }
}

function stripSqlComments(sql: string): string {
  // Remove rather than replace with whitespace so `_takoserver_/**/sqlite...`
  // cannot split a reserved identifier token around a comment.
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//gu, "");
}

function parseAuthority(value: unknown): ManagedWorkerSqliteAuthority | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["providerId", "resourceUid", "generation", "operationId", "descriptorDigest"])
  )
    return null;
  if (
    typeof value.providerId !== "string" ||
    typeof value.resourceUid !== "string" ||
    typeof value.generation !== "string" ||
    typeof value.operationId !== "string" ||
    typeof value.descriptorDigest !== "string"
  )
    return null;
  if (
    !TOKEN.test(value.providerId) ||
    !TOKEN.test(value.resourceUid) ||
    !TOKEN.test(value.operationId) ||
    !GENERATION.test(value.generation) ||
    !DIGEST.test(value.descriptorDigest)
  )
    return null;
  return {
    providerId: value.providerId,
    resourceUid: value.resourceUid,
    generation: value.generation,
    operationId: value.operationId,
    descriptorDigest: value.descriptorDigest as `sha256:${string}`,
  };
}

function parseControlRecord(value: unknown): ManagedWorkerSqliteControlRecord | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schema", "lifecycle", "authority", "migrations"]) ||
    value.schema !== MANAGED_SQLITE_CONTROL_SCHEMA ||
    (value.lifecycle !== "active" && value.lifecycle !== "destroyed") ||
    !Array.isArray(value.migrations) ||
    value.migrations.length > MAX_MIGRATION_HISTORY
  ) {
    return null;
  }
  const authority = parseAuthority(value.authority);
  const migrations = value.migrations.map(parseMigrationIdentity);
  if (
    !authority ||
    migrations.some((entry) => entry === null) ||
    hasDuplicateMigrationPath(migrations as ManagedWorkerSqliteMigrationIdentity[])
  ) {
    return null;
  }
  const control: ManagedWorkerSqliteControlRecord = {
    schema: MANAGED_SQLITE_CONTROL_SCHEMA,
    lifecycle: value.lifecycle,
    authority,
    migrations: migrations as ManagedWorkerSqliteMigrationIdentity[],
  };
  return validControlRecord(control) ? control : null;
}

function validControlRecord(value: ManagedWorkerSqliteControlRecord): boolean {
  if (
    value.schema !== MANAGED_SQLITE_CONTROL_SCHEMA ||
    (value.lifecycle !== "active" && value.lifecycle !== "destroyed") ||
    !parseAuthority(value.authority) ||
    value.migrations.length > MAX_MIGRATION_HISTORY ||
    value.migrations.some((migration) => !parseMigrationIdentity(migration)) ||
    hasDuplicateMigrationPath(value.migrations)
  ) {
    return false;
  }
  try {
    return utf8(JSON.stringify(value)) <= MAX_CONTROL_RECORD_BYTES;
  } catch {
    return false;
  }
}

function parseMigrationInput(value: unknown): {
  readonly authority: ManagedWorkerSqliteAuthority;
  readonly expectedPrefix: readonly ManagedWorkerSqliteMigrationIdentity[];
  readonly migrations: readonly ManagedWorkerSqliteMigration[];
} | null {
  if (!isRecord(value) || !onlyKeys(value, ["authority", "expectedPrefix", "migrations"]))
    return null;
  const authority = parseAuthority(value.authority);
  if (
    !authority ||
    !Array.isArray(value.expectedPrefix) ||
    value.expectedPrefix.length > MAX_SQL_STATEMENTS ||
    !Array.isArray(value.migrations) ||
    value.migrations.length < 1 ||
    value.migrations.length > MAX_SQL_STATEMENTS
  )
    return null;
  const expectedPrefix = value.expectedPrefix.map(parseMigrationIdentity);
  const migrations = value.migrations.map(parseMigration);
  if (expectedPrefix.some((entry) => entry === null) || migrations.some((entry) => entry === null))
    return null;
  return {
    authority,
    expectedPrefix: expectedPrefix as ManagedWorkerSqliteMigrationIdentity[],
    migrations: migrations as ManagedWorkerSqliteMigration[],
  };
}

function parseMigrationIdentity(value: unknown): ManagedWorkerSqliteMigrationIdentity | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["path", "digest"]) ||
    typeof value.path !== "string" ||
    typeof value.digest !== "string" ||
    !validPath(value.path) ||
    !DIGEST.test(value.digest)
  )
    return null;
  return { path: value.path, digest: value.digest as `sha256:${string}` };
}

function parseMigration(value: unknown): ManagedWorkerSqliteMigration | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["path", "digest", "sql"]) ||
    !(value.sql instanceof Uint8Array) ||
    value.sql.byteLength > MAX_SQL_BYTES
  )
    return null;
  if (
    typeof value.path !== "string" ||
    typeof value.digest !== "string" ||
    !validPath(value.path) ||
    !DIGEST.test(value.digest)
  )
    return null;
  return {
    path: value.path,
    digest: value.digest as `sha256:${string}`,
    sql: value.sql,
  };
}

function sameAuthority(
  left: ManagedWorkerSqliteAuthority,
  right: ManagedWorkerSqliteAuthority,
): boolean {
  return (
    left.providerId === right.providerId &&
    left.resourceUid === right.resourceUid &&
    left.generation === right.generation &&
    left.operationId === right.operationId &&
    left.descriptorDigest === right.descriptorDigest
  );
}

function sameMigrations(
  left: readonly ManagedWorkerSqliteMigrationIdentity[],
  right: readonly ManagedWorkerSqliteMigrationIdentity[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.path !== right[index]?.path || left[index]?.digest !== right[index]?.digest)
      return false;
  }
  return true;
}

function sameMigrationsPrefix(
  value: readonly ManagedWorkerSqliteMigrationIdentity[],
  prefix: readonly ManagedWorkerSqliteMigrationIdentity[],
): boolean {
  if (prefix.length > value.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (
      value[index]?.path !== prefix[index]?.path ||
      value[index]?.digest !== prefix[index]?.digest
    ) {
      return false;
    }
  }
  return true;
}

function hasDuplicateMigrationPath(
  migrations: readonly ManagedWorkerSqliteMigrationIdentity[],
): boolean {
  const paths = new Set<string>();
  for (const migration of migrations) {
    if (paths.has(migration.path)) return true;
    paths.add(migration.path);
  }
  return false;
}

function projectRow(
  row: Record<string, ArrayBuffer | string | number | null>,
): Readonly<Record<string, ManagedWorkerSqlValue>> {
  const result: Record<string, ManagedWorkerSqlValue> = Object.create(null) as Record<
    string,
    ManagedWorkerSqlValue
  >;
  const keys = Object.keys(row);
  if (keys.length > MAX_SQL_COLUMNS) throw new SqlSentinel(BACKEND_ERROR);
  for (const key of keys) {
    if (key.length === 0 || utf8(key) > 128) throw new SqlSentinel(BACKEND_ERROR);
    const value = row[key];
    if (value === null) {
      result[key] = null;
    } else if (typeof value === "string") {
      if (utf8(value) > MAX_SQL_VALUE_BYTES) throw new SqlSentinel(BACKEND_ERROR);
      result[key] = value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
        throw new SqlSentinel(NUMERIC_ERROR);
      result[key] = value;
    } else if (value instanceof ArrayBuffer) {
      result[key] = { encoding: "base64", data: base64(new Uint8Array(value)) };
    } else {
      throw new SqlSentinel(BACKEND_ERROR);
    }
  }
  return result;
}

function toNativeValue(value: ManagedWorkerSqlValue): ArrayBuffer | string | number | null {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  return decodeBase64(value.data);
}

function mapError(
  error: unknown,
): "sql_error" | "numeric_out_of_range" | "busy" | "backend_unavailable" {
  if (error instanceof SqlSentinel) return error.code;
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/busy|locked/iu.test(text)) return BUSY_ERROR;
  if (/numeric|range|integer/iu.test(text)) return NUMERIC_ERROR;
  if (/syntax|sql/iu.test(text)) return SQL_ERROR;
  return BACKEND_ERROR;
}

function success<T>(value: T): ManagedWorkerSqlRpcResult<T> {
  return { ok: true, value };
}

function failure(
  code: "sql_error" | "numeric_out_of_range" | "busy" | "backend_unavailable",
): ManagedWorkerSqlRpcResult<never> {
  return { ok: false, error: { code } };
}

function adminSuccess<T>(value: T): ManagedWorkerSqliteAdminResult<T> {
  return { ok: true, value };
}

function adminFailure(
  code: "invalid_argument" | "conflict" | "not_found" | "backend_unavailable",
): ManagedWorkerSqliteAdminResult<never> {
  return { ok: false, error: { code } };
}

function assertToken(value: string): void {
  if (!TOKEN.test(value) || value.length > MAX_TOKEN_BYTES) throw new TypeError("invalid token");
}

function assertGeneration(value: string): void {
  if (!GENERATION.test(value)) throw new TypeError("invalid generation");
}

function validPath(value: string): boolean {
  return (
    value.length > 0 &&
    utf8(value) <= MAX_PATH_BYTES &&
    !value.includes("\u0000") &&
    !value.includes("\\") &&
    value !== "." &&
    value !== ".."
  );
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && onlyKeys(value, keys);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validBase64(value: string, maximumBytes: number): boolean {
  if (value.length % 4 !== 0 || !BASE64.test(value)) return false;
  try {
    return decodeBase64(value).byteLength <= maximumBytes;
  } catch {
    return false;
  }
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function base64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Url(value: Uint8Array): string {
  return base64(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function hex(value: Uint8Array): string {
  let result = "";
  for (const byte of value) result += byte.toString(16).padStart(2, "0");
  return result;
}
