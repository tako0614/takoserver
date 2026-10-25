import { FINANCIAL_0104_FENCED_TABLES } from "./financial-0104-money-fence.ts";
import {
  type Row,
  type Sql,
  SqlError,
  type SqlParam,
  type SqlStatement,
  type SqlWrite,
} from "./ports.ts";

/**
 * An unadopted, internal ordinary-source prototype. This is a statement and
 * catalog write fence, not a native-source, actor, billing, or serving grant.
 * The new ordinary R1/H0 names are fixed DATA from the pending Financial
 * manifests; their source component is not yet adopted in this tree.
 */
const PROTECTED = new Set<string>([
  ...FINANCIAL_0104_FENCED_TABLES,
  "financial_ordinary_action_source_registrations",
  "financial_ordinary_preproof_challenges",
  "financial_ordinary_preproof_challenge_receipts",
  "financial_ordinary_retained_r1_originals",
  "financial_ordinary_retained_r1_receipts",
  "financial_ordinary_history_primary_roots",
  "financial_ordinary_history_enrollments",
  "financial_ordinary_history_enrollment_roster",
  "financial_ordinary_history_enrollment_inventory",
  "financial_ordinary_history_enrollment_inventory_receipts",
  "financial_ordinary_history_enrollment_heads",
  "financial_ordinary_history_enrollment_receipts",
  "financial_ordinary_customer_history_coverages",
  "financial_ordinary_customer_history_scopes",
  "financial_ordinary_customer_history_coverage_receipts",
]);
const MONEY_CUTOVER_CONTROLS = new Set([
  "money_cutover_freeze",
  "money_cutover_writer_permit",
  "money_cutover_authorized_epoch",
]);
const MONEY_CUTOVER_CONTROL_REFERENCE =
  /\b(?:money_cutover_freeze|money_cutover_writer_permit|money_cutover_authorized_epoch)\b/iu;
const D1_INTERNAL_FK_METADATA_TABLES = new Set(["_cf_kv", "_cf_metadata"]);

// Below D1's 2,000,000-byte string/row limit. Catalogs above this bound have
// no fallback authority: they refuse before submitting a body write.
const MAX_CATALOG_BYTES = 1_000_000;
const CATALOG_SQL =
  "SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name, tbl_name, sql";
const TEMP_SQL = "SELECT count(*) AS n FROM sqlite_temp_schema";
const FOREIGN_KEYS_SQL =
  "SELECT \"table\" AS parent, on_update, on_delete FROM pragma_foreign_key_list(?, 'main')";
const GUARD_SQL = `WITH saved(type, name, tbl_name, sql) AS (
  SELECT json_extract(value, '$.type'), json_extract(value, '$.name'),
         json_extract(value, '$.tbl_name'), json_extract(value, '$.sql')
  FROM json_each(?)
), live(type, name, tbl_name, sql) AS (
  SELECT type, name, tbl_name, sql FROM main.sqlite_schema
)
SELECT CASE WHEN
  (SELECT count(*) FROM saved) = (SELECT count(*) FROM live)
  AND NOT EXISTS (SELECT 1 FROM sqlite_temp_schema)
  AND NOT EXISTS (
    SELECT type COLLATE BINARY, name COLLATE BINARY, tbl_name COLLATE BINARY,
           sql COLLATE BINARY FROM live
    EXCEPT SELECT type COLLATE BINARY, name COLLATE BINARY, tbl_name COLLATE BINARY,
                  sql COLLATE BINARY FROM saved
  )
  AND NOT EXISTS (
    SELECT type COLLATE BINARY, name COLLATE BINARY, tbl_name COLLATE BINARY,
           sql COLLATE BINARY FROM saved
    EXCEPT SELECT type COLLATE BINARY, name COLLATE BINARY, tbl_name COLLATE BINARY,
                  sql COLLATE BINARY FROM live
  )
THEN 1 ELSE json(?) END AS guarded`;

type CatalogRow = {
  type: "table" | "index" | "view" | "trigger";
  name: string;
  tbl_name: string;
  sql: string | null;
};
type Event = "INSERT" | "UPDATE" | "DELETE";
type Effect = { target: string; events: readonly Event[] };
type ForeignKey = { child: string; parent: string; onUpdate: string; onDelete: string };
type Trigger = { on: string; event: Event; timing: string; effects: readonly Effect[] };
type Token = { kind: "word" | "identifier" | "string" | "punct"; text: string };

function refuse(reason: string): never {
  throw new SqlError("invalid", `ordinary public SQL refused: ${reason}`);
}

function identifier(token: Token | undefined): string {
  if (!token || (token.kind !== "word" && token.kind !== "identifier")) refuse("identifier");
  return token.text.toLowerCase();
}

function lex(sql: string): Token[] {
  if (new TextEncoder().encode(sql).length > 100_000) refuse("statement size");
  const result: Token[] = [];
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    if (c === undefined) refuse("statement index");
    if (/\s/u.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) refuse("unterminated comment");
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let value = "";
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === close) {
          if (c !== "[" && sql[i + 1] === close) {
            value += close;
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        value += sql[i++] ?? "";
      }
      if (!closed) refuse("unterminated literal");
      result.push({ kind: c === "'" ? "string" : "identifier", text: value });
      continue;
    }
    if (/[A-Za-z_]/u.test(c)) {
      const start = i++;
      while (i < sql.length && /[A-Za-z0-9_$]/u.test(sql[i] ?? "")) i++;
      result.push({ kind: "word", text: sql.slice(start, i).toUpperCase() });
      continue;
    }
    if (/[0-9]/u.test(c)) {
      const start = i++;
      while (i < sql.length && /[0-9.]/u.test(sql[i] ?? "")) i++;
      result.push({ kind: "string", text: sql.slice(start, i) });
      continue;
    }
    if (!"(),;.*=<>!?+-/%|&~:".includes(c)) refuse("unknown token");
    result.push({ kind: "punct", text: c });
    i++;
  }
  return result;
}

function words(tokens: readonly Token[]): string[] {
  return tokens.map((token) =>
    token.kind === "word"
      ? token.text
      : token.kind === "identifier"
        ? token.text.toLowerCase()
        : token.text,
  );
}

function singleStatement(sql: string): Token[] {
  const tokens = lex(sql);
  while (tokens.at(-1)?.text === ";") tokens.pop();
  if (tokens.length === 0 || tokens.some((t) => t.text === ";")) refuse("multiple statements");
  return tokens;
}

function operation(tokens: readonly Token[]): number {
  if (tokens[0]?.text !== "WITH") return 0;
  let depth = 0;
  for (let i = 1; i < tokens.length; i++) {
    const text = tokens[i]?.text;
    if (text === "(") depth++;
    else if (text === ")") depth--;
    else if (
      depth === 0 &&
      text !== undefined &&
      ["SELECT", "INSERT", "UPDATE", "DELETE"].includes(text)
    )
      return i;
    if (depth < 0) refuse("CTE parentheses");
  }
  refuse("CTE operation");
}

function statementEffects(tokens: readonly Token[]): Effect[] {
  const start = operation(tokens);
  const first = tokens[start]?.text;
  if (first === "SELECT") return [];
  if (first === "REPLACE") refuse("REPLACE");
  if (first !== "INSERT" && first !== "UPDATE" && first !== "DELETE") refuse("statement kind");
  let index = start + 1;
  if (first === "INSERT") {
    if (tokens[index]?.text === "OR") {
      if (tokens[index + 1]?.text !== "IGNORE") refuse("INSERT conflict mode");
      index += 2;
    }
    if (tokens[index++]?.text !== "INTO") refuse("INSERT target");
  } else if (first === "UPDATE") {
    if (tokens[index]?.text === "OR") refuse("UPDATE conflict mode");
  } else if (tokens[index++]?.text !== "FROM") refuse("DELETE target");
  const target = identifier(tokens[index]);
  if (tokens[index + 1]?.text === ".") refuse("qualified target");
  const events: Event[] = [first];
  if (first === "INSERT") {
    const parts = words(tokens.slice(index + 1));
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] !== "ON" || parts[i + 1] !== "CONFLICT") continue;
      let depth = 0;
      for (let j = i + 2; j < parts.length; j++) {
        if (parts[j] === "(") depth++;
        else if (parts[j] === ")") depth--;
        else if (depth === 0 && parts[j] === "DO") {
          if (parts[j + 1] === "UPDATE") events.push("UPDATE");
          else if (parts[j + 1] !== "NOTHING") refuse("UPSERT action");
          break;
        }
      }
    }
  }
  return [{ target, events }];
}

function parseTrigger(sql: string): Trigger {
  const tokens = lex(sql);
  const text = words(tokens);
  const eventIndex = text.findIndex(
    (word) => word === "INSERT" || word === "UPDATE" || word === "DELETE",
  );
  if (text[0] !== "CREATE" || !text.includes("TRIGGER") || eventIndex < 0)
    refuse("trigger definition");
  const timing = text.slice(0, eventIndex).includes("INSTEAD")
    ? "INSTEAD"
    : text.slice(0, eventIndex).includes("BEFORE")
      ? "BEFORE"
      : text.slice(0, eventIndex).includes("AFTER")
        ? "AFTER"
        : "";
  if (!timing) refuse("trigger timing");
  const onIndex = text.indexOf("ON", eventIndex + 1);
  const beginIndex = text.indexOf("BEGIN", onIndex + 1);
  if (onIndex < 0 || beginIndex < 0 || text.at(-1) !== "END") refuse("trigger body");
  const on = identifier(tokens[onIndex + 1]);
  if (tokens[onIndex + 2]?.text === ".") refuse("trigger schema");
  const body = tokens.slice(beginIndex + 1, -1);
  const effects: Effect[] = [];
  let segment: Token[] = [];
  for (const token of body) {
    if (token.text !== ";") {
      segment.push(token);
      continue;
    }
    if (segment.length === 0) refuse("empty trigger statement");
    effects.push(...statementEffects(segment));
    segment = [];
  }
  if (segment.length) refuse("unterminated trigger statement");
  return { on, event: text[eventIndex] as Event, timing, effects };
}

function catalogRow(value: Row): CatalogRow {
  const { type, name, tbl_name: table, sql } = value;
  if (
    !(["table", "index", "view", "trigger"] as unknown[]).includes(type) ||
    typeof name !== "string" ||
    typeof table !== "string" ||
    (typeof sql !== "string" && sql !== null)
  )
    refuse("catalog shape");
  return { type: type as CatalogRow["type"], name, tbl_name: table, sql };
}

function isD1InternalTableWithoutForeignKeys(row: CatalogRow): boolean {
  if (
    row.type !== "table" ||
    row.sql === null ||
    !D1_INTERNAL_FK_METADATA_TABLES.has(row.name.toLowerCase())
  )
    return false;
  const tokens = lex(row.sql);
  if (tokens[0]?.text !== "CREATE" || tokens[1]?.text !== "TABLE") return false;
  let nameIndex = 2;
  if (
    tokens[nameIndex]?.text === "IF" &&
    tokens[nameIndex + 1]?.text === "NOT" &&
    tokens[nameIndex + 2]?.text === "EXISTS"
  )
    nameIndex += 3;
  if (identifier(tokens[nameIndex]) !== row.name.toLowerCase()) return false;
  if (tokens[nameIndex + 1]?.text === ".") return false;
  return !tokens.some((token) => token.kind === "word" && token.text === "REFERENCES");
}

function guardedWrite(
  effects: readonly Effect[],
  catalog: readonly CatalogRow[],
  foreignKeys: readonly ForeignKey[],
): void {
  const objects = new Map<string, CatalogRow>();
  const triggers: Trigger[] = [];
  for (const row of catalog) {
    if (objects.has(row.name.toLowerCase())) refuse("duplicate catalog name");
    objects.set(row.name.toLowerCase(), row);
    if (row.type === "trigger") {
      if (row.sql === null) refuse("trigger SQL");
      triggers.push(parseTrigger(row.sql));
    }
    if (row.type === "table" && row.sql && /\bVIRTUAL\b/iu.test(row.sql)) refuse("virtual table");
  }
  const visit = (effect: Effect, seen: Set<string>) => {
    const object = objects.get(effect.target);
    if (!object || (object.type !== "table" && object.type !== "view"))
      refuse("write target catalog");
    if (PROTECTED.has(effect.target) || MONEY_CUTOVER_CONTROLS.has(effect.target))
      refuse("protected write");
    for (const event of effect.events) {
      const key = `${effect.target}:${event}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const firing = triggers.filter(
        (trigger) => trigger.on === effect.target && trigger.event === event,
      );
      if (object.type === "view" && !firing.some((trigger) => trigger.timing === "INSTEAD"))
        refuse("view write");
      for (const trigger of firing) for (const child of trigger.effects) visit(child, seen);
      if (object.type === "table" && event !== "INSERT") {
        for (const fk of foreignKeys) {
          if (fk.parent !== effect.target) continue;
          const action = event === "DELETE" ? fk.onDelete : fk.onUpdate;
          if (["CASCADE", "SET NULL", "SET DEFAULT"].includes(action)) {
            visit(
              {
                target: fk.child,
                events: action === "CASCADE" && event === "DELETE" ? ["DELETE"] : ["UPDATE"],
              },
              seen,
            );
          } else if (action !== "NO ACTION" && action !== "RESTRICT") refuse("foreign-key action");
        }
      }
    }
  };
  for (const effect of effects) visit(effect, new Set());
}

function capture(raw: Sql) {
  if (!raw || typeof raw !== "object") refuse("raw SQL");
  const query = Object.getOwnPropertyDescriptor(raw, "query");
  const batch = Object.getOwnPropertyDescriptor(raw, "batch");
  const run = Object.getOwnPropertyDescriptor(raw, "run");
  if (
    typeof query?.value !== "function" ||
    typeof run?.value !== "function" ||
    typeof batch?.value !== "function"
  )
    refuse("raw SQL methods");
  const current = () => {
    if (
      Object.getOwnPropertyDescriptor(raw, "query")?.value !== query.value ||
      Object.getOwnPropertyDescriptor(raw, "run")?.value !== run.value ||
      Object.getOwnPropertyDescriptor(raw, "batch")?.value !== batch.value
    )
      refuse("raw SQL drift");
  };
  return { current, query: query.value as Sql["query"], batch: batch.value as Sql["batch"] };
}

function snapshotStatements(input: readonly SqlStatement[]): SqlStatement[] {
  if (!Array.isArray(input)) refuse("statement batch shape");
  return input.map((statement) => {
    if (!statement || typeof statement !== "object" || typeof statement.sql !== "string")
      refuse("statement shape");
    if (statement.params === undefined) return { sql: statement.sql };
    if (!Array.isArray(statement.params) || statement.params.length > 100)
      refuse("statement params");
    const inputParams: readonly unknown[] = statement.params;
    const params: SqlParam[] = inputParams.map((param) => {
      if (param === null || typeof param === "string" || typeof param === "number") return param;
      if (param instanceof ArrayBuffer) return param.slice(0);
      return refuse("statement param");
    });
    return { sql: statement.sql, params };
  });
}

function validWrite(value: unknown): value is SqlWrite {
  if (!value || typeof value !== "object") return false;
  const write = value as Partial<SqlWrite>;
  if (
    !Array.isArray(write.rows) ||
    typeof write.changes !== "number" ||
    !Number.isSafeInteger(write.changes) ||
    write.changes < 0
  )
    return false;
  for (const row of write.rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return false;
  }
  return true;
}

/**
 * Build an immutable private façade over the actual Root-selected first-primary D1 Sql.
 * Generic Sql adapters, including attach-capable connections, are outside this contract.
 * This helper does not qualify or select its input.
 */
export function createOrdinaryFinancialPublicSql(raw: Sql): Sql {
  const original = capture(raw);
  const execute = async (statements: readonly SqlStatement[]): Promise<readonly SqlWrite[]> => {
    const batch = snapshotStatements(statements);
    if (batch.length === 0) return [];
    original.current();
    const effects: Effect[] = [];
    for (const statement of batch) {
      if (MONEY_CUTOVER_CONTROL_REFERENCE.test(statement.sql.trim()))
        refuse("Money cutover control reference");
      effects.push(...statementEffects(singleStatement(statement.sql)));
    }
    const rows = (await original.query.call(raw, CATALOG_SQL)).map(catalogRow);
    const temp = await original.query.call(raw, TEMP_SQL);
    if (temp.length !== 1 || temp[0]?.n !== 0) refuse("temporary catalog");
    const json = JSON.stringify(rows);
    if (new TextEncoder().encode(json).length > MAX_CATALOG_BYTES) refuse("catalog size");
    const foreignKeys: ForeignKey[] = [];
    for (const row of rows) {
      if (row.type !== "table") continue;
      if (isD1InternalTableWithoutForeignKeys(row)) continue;
      const keys = await original.query.call(raw, FOREIGN_KEYS_SQL, [row.name]);
      for (const key of keys) {
        if (
          typeof key.parent !== "string" ||
          typeof key.on_update !== "string" ||
          typeof key.on_delete !== "string"
        )
          refuse("foreign-key metadata");
        foreignKeys.push({
          child: row.name.toLowerCase(),
          parent: key.parent.toLowerCase(),
          onUpdate: key.on_update.toUpperCase(),
          onDelete: key.on_delete.toUpperCase(),
        });
      }
    }
    guardedWrite(effects, rows, foreignKeys);
    original.current();
    const results = await original.batch.call(raw, [
      ...batch,
      { sql: GUARD_SQL, params: [json, "ordinary-catalog-drift"] },
    ]);
    if (!Array.isArray(results) || results.length !== batch.length + 1)
      throw new SqlError("unavailable", "ordinary catalog guard acknowledgement missing");
    for (const result of results) {
      if (!validWrite(result))
        throw new SqlError("unavailable", "ordinary batch acknowledgement malformed");
    }
    const guard = results.at(-1);
    if (guard?.rows.length !== 1 || guard.rows[0]?.guarded !== 1)
      throw new SqlError("unavailable", "ordinary catalog guard acknowledgement missing");
    return results.slice(0, -1);
  };
  return Object.freeze({
    async query(sql: string, params?: readonly SqlParam[]): Promise<readonly Row[]> {
      const first = (await execute([{ sql, ...(params ? { params } : {}) }]))[0];
      if (!first) throw new SqlError("unavailable", "ordinary query acknowledgement missing");
      return first.rows;
    },
    async run(sql: string, params?: readonly SqlParam[]): Promise<SqlWrite> {
      const first = (await execute([{ sql, ...(params ? { params } : {}) }]))[0];
      if (!first) throw new SqlError("unavailable", "ordinary write acknowledgement missing");
      return first;
    },
    batch: execute,
  });
}
