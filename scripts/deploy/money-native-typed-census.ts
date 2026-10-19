import { createHash } from "node:crypto";
import { type DeployPhase, preflightError, verificationError } from "./errors.ts";

/** Read-only DATA transport; the owning caller retains all native/currentness fences. */
export interface MoneyNativeTypedCensusReader {
  query(
    phase: DeployPhase,
    description: string,
    sql: string,
  ): Promise<readonly Record<string, unknown>[]>;
}

const SQL_BYTES = 90_000;
const COLUMN_TABLES = 128;
const DATA_TABLES = 16;
const ROW_LIMIT = 1000;
interface TableColumns {
  readonly index: number;
  readonly table: string;
  readonly names: readonly string[];
}

function fail(phase: DeployPhase, message: string): never {
  throw phase === "verification" ? verificationError(message) : preflightError(message);
}
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
/** Each compound SELECT has at most two terms; depth grows logarithmically. */
function union(selects: readonly string[]): string {
  if (selects.length === 1) return selects[0] as string;
  const middle = Math.ceil(selects.length / 2);
  return `SELECT * FROM (${union(selects.slice(0, middle))}) UNION ALL SELECT * FROM (${union(selects.slice(middle))})`;
}
/** Avoid a wide json_array argument list or a linear-depth concatenation. */
function concatenate(parts: readonly string[]): string {
  if (parts.length === 1) return parts[0] as string;
  const middle = Math.ceil(parts.length / 2);
  return `(${concatenate(parts.slice(0, middle))} || ${concatenate(parts.slice(middle))})`;
}
function groups<T>(
  source: readonly T[],
  cap: number,
  build: (items: readonly T[]) => string,
  phase: DeployPhase,
): readonly { readonly items: readonly T[]; readonly sql: string }[] {
  const result: { items: readonly T[]; sql: string }[] = [];
  let items: T[] = [];
  for (const item of source) {
    const next = [...items, item];
    if (
      items.length !== 0 &&
      (next.length > cap || Buffer.byteLength(build(next), "utf8") > SQL_BYTES)
    ) {
      result.push({ items, sql: build(items) });
      items = [item];
    } else items = next;
    if (Buffer.byteLength(build(items), "utf8") > SQL_BYTES)
      fail(phase, "backup typed census exceeds the bounded SQL size");
  }
  if (items.length !== 0) result.push({ items, sql: build(items) });
  return result;
}
function columnsSql(tables: readonly { index: number; table: string }[]): string {
  return `SELECT table_index, table_name, names_json FROM (${union(
    tables.map(
      ({ index, table }) =>
        `SELECT ${index} AS table_index, ${literal(table)} AS table_name, (SELECT json_group_array(name) FROM (SELECT name FROM pragma_table_info(${literal(table)}) ORDER BY cid)) AS names_json`,
    ),
  )}) ORDER BY table_index`;
}
function dataSql(tables: readonly TableColumns[]): string {
  return `SELECT table_index, table_name, row_kind, row_index, payload FROM (${union(
    tables.map(({ index, table, names }) => {
      // This is the original typed projection, ORDER and per-table cap. An
      // empty table still executes this SELECT; its count never replaces it.
      const projection = names
        .map((name, i) => {
          const column = `"${name}"`;
          return `typeof(${column}) AS t${i}, CASE typeof(${column}) WHEN 'null' THEN '' WHEN 'text' THEN hex(CAST(${column} AS BLOB)) WHEN 'blob' THEN hex(${column}) WHEN 'integer' THEN CAST(${column} AS TEXT) WHEN 'real' THEN printf('%!.26g', ${column}) ELSE NULL END AS v${i}`;
        })
        .join(", ");
      const order = names.flatMap((_name, i) => [`t${i}`, `v${i}`]).join(", ");
      const encoded: string[] = ["'['"];
      for (let i = 0; i < names.length; i++) {
        if (i !== 0) encoded.push("','");
        encoded.push(`json_array(t${i}, v${i})`);
      }
      encoded.push("']'");
      return `SELECT * FROM (WITH typed_rows AS (SELECT ${projection} FROM ${table} ORDER BY ${order} LIMIT 1001) SELECT ${index} AS table_index, ${literal(table)} AS table_name, 0 AS row_kind, 0 AS row_index, CAST(COUNT(*) AS TEXT) AS payload FROM typed_rows UNION ALL SELECT ${index} AS table_index, ${literal(table)} AS table_name, 1 AS row_kind, ROW_NUMBER() OVER (ORDER BY ${order}) AS row_index, ${concatenate(encoded)} AS payload FROM typed_rows)`;
    }),
  )}) ORDER BY table_index, row_kind, row_index`;
}
function keys(row: Record<string, unknown>, expected: string): boolean {
  return row !== null && typeof row === "object" && Object.keys(row).sort().join(",") === expected;
}
function parseJson(value: unknown, phase: DeployPhase, message: string): unknown {
  if (typeof value !== "string") return fail(phase, message);
  try {
    return JSON.parse(value);
  } catch {
    return fail(phase, message);
  }
}
function typedValues(
  value: unknown,
  names: readonly string[],
  phase: DeployPhase,
  table: string,
): readonly unknown[] {
  const values = parseJson(value, phase, `backup ${table} typed value is malformed`);
  if (
    !Array.isArray(values) ||
    values.length !== names.length ||
    values.some(
      (pair) =>
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        !["null", "text", "blob", "integer", "real"].includes(pair[0]) ||
        typeof pair[1] !== "string" ||
        ((pair[0] === "text" || pair[0] === "blob") && !/^(?:[0-9A-F]{2})*$/u.test(pair[1])) ||
        (pair[0] === "integer" && !/^-?(?:0|[1-9][0-9]*)$/u.test(pair[1])) ||
        (pair[0] === "real" && !/^-?[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/iu.test(pair[1])),
    )
  )
    return fail(phase, `backup ${table} typed value is malformed`);
  return values;
}

/**
 * Exactly the old whole-database digest framing, with bounded grouped reads.
 * No schema/FK/currentness assertion is replaced or cached by this DATA helper.
 * Sentinels cover empty tables and exact row cardinality; row ordinals prevent
 * incomplete, reordered or duplicated native result sets from looking empty.
 */
export async function readMoneyNativeTypedCensusDigest(
  database: MoneyNativeTypedCensusReader,
  phase: DeployPhase,
  tables: readonly string[],
): Promise<string> {
  const query = database.query;
  const selected = tables.map((table, index) => {
    if (!/^[a-z_][a-z_0-9]*$/u.test(table)) fail(phase, "backup data table name is malformed");
    return { index, table };
  });
  const columns: TableColumns[] = [];
  for (const read of groups(selected, COLUMN_TABLES, columnsSql, phase)) {
    const rows = await Reflect.apply(query, database, [
      phase,
      "backup grouped table columns",
      read.sql,
    ]);
    if (rows.length !== read.items.length)
      fail(phase, "backup table columns are incomplete or duplicated");
    for (const [i, table] of read.items.entries()) {
      const row = rows[i];
      if (
        !row ||
        !keys(row, "names_json,table_index,table_name") ||
        row.table_index !== table.index ||
        row.table_name !== table.table
      )
        fail(phase, "backup table columns are incomplete or duplicated");
      const names = parseJson(row.names_json, phase, `backup ${table.table} columns are malformed`);
      if (
        !Array.isArray(names) ||
        names.length === 0 ||
        names.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z_0-9]*$/u.test(name)) ||
        new Set(names).size !== names.length
      )
        fail(phase, `backup ${table.table} columns are malformed`);
      columns.push({ ...table, names });
    }
  }
  const hash = createHash("sha256");
  for (const read of groups(columns, DATA_TABLES, dataSql, phase)) {
    const rows = await Reflect.apply(query, database, [
      phase,
      "backup grouped typed rows",
      read.sql,
    ]);
    let offset = 0;
    for (const table of read.items) {
      const sentinel = rows[offset++];
      if (
        !sentinel ||
        !keys(sentinel, "payload,row_index,row_kind,table_index,table_name") ||
        sentinel.table_index !== table.index ||
        sentinel.table_name !== table.table ||
        sentinel.row_kind !== 0 ||
        sentinel.row_index !== 0 ||
        typeof sentinel.payload !== "string" ||
        !/^(?:0|[1-9][0-9]*)$/u.test(sentinel.payload)
      )
        fail(phase, "backup typed rows have missing or duplicate coverage");
      const count = Number(sentinel.payload);
      if (!Number.isSafeInteger(count) || count > ROW_LIMIT)
        fail(phase, `backup ${table.table} exceeds the bounded row-value proof`);
      hash.update(table.table).update("\0").update(JSON.stringify(table.names)).update("\0");
      for (let ordinal = 1; ordinal <= count; ordinal++) {
        const row = rows[offset++];
        if (
          !row ||
          !keys(row, "payload,row_index,row_kind,table_index,table_name") ||
          row.table_index !== table.index ||
          row.table_name !== table.table ||
          row.row_kind !== 1 ||
          row.row_index !== ordinal
        )
          fail(phase, "backup typed rows have missing, reordered or duplicate coverage");
        hash
          .update(JSON.stringify(typedValues(row.payload, table.names, phase, table.table)))
          .update("\n");
      }
      hash.update("\0");
    }
    if (offset !== rows.length) fail(phase, "backup typed rows contain unexpected coverage");
  }
  return `sha256:${hash.digest("hex")}`;
}
