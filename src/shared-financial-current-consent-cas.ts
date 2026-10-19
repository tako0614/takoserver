import { isFinancialCustomerMoneyFencedBatch } from "./financial-0104-money-fence.ts";
import { canonicalJson } from "./json.ts";
import type { SqlParam, SqlStatement } from "./ports.ts";
import { SHARED_AUTH_FINANCIAL_CONSENT_ISSUERS } from "./shared-auth-financial-consent-schema-plan.ts";
import type { CustomerPhasePlan } from "./shared-financial-customer-dispatch.ts";

/** Closed Financial receipt guard. Only the RP and native Root owning builders supply SQL. */
export interface FinancialCurrentConsentPredicates {
  readonly rp: SqlStatement;
  readonly root: Readonly<{ sql: string; params: readonly SqlParam[] }>;
  readonly issuer: Readonly<{
    registrationRef: string;
    registrationDigest: string;
    incarnation: string;
  }>;
  readonly acceptedAt: number;
  readonly expiresAt: number;
}

const ISSUER_ORIGINAL_JSON = canonicalJson({
  version: "takoserver-shared-financial-action-consent-issuer-v1",
  registrationRef: "shared-financial-action-consent-rp",
  incarnation: "1",
  purpose: "rp-explicit-action-consent",
});
const SQL_NOW_MS =
  "(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";

function unavailable(): never {
  throw new TypeError("financial current consent CAS unavailable");
}

function sqlString(value: string): string {
  // This literal is the fixed issuer source recipe, never a caller string.
  return `'${value.replaceAll("'", "''")}'`;
}

/** RP's fixed local SELECT has 74 flat outer AND terms. Balance that one
 * associative, side-effect-free WHERE tree before embedding it in a receipt;
 * otherwise the unchanged RP query exceeds D1's depth-100 expression limit. */
function balancedRpOuterWhere(sql: string): string {
  if (!sql.startsWith("SELECT local_original.")) return sql;
  const marker = "CROSS JOIN expected e\nWHERE ";
  const suffix = " LIMIT 2) AS local_original";
  const at = sql.indexOf(marker);
  if (at < 0 || at !== sql.lastIndexOf(marker) || !sql.endsWith(suffix)) unavailable();
  const start = at + marker.length;
  const end = sql.length - suffix.length;
  const body = sql.slice(start, end);
  const parts: string[] = [];
  let from = 0;
  let depth = 0;
  let quoted: "'" | '"' | "`" | null = null;
  for (let i = 0; i < body.length; i++) {
    const character = body[i];
    const next = body[i + 1];
    if (quoted) {
      if (character === quoted) {
        if (next === quoted) i++;
        else quoted = null;
      }
    } else if (character === "'" || character === '"' || character === "`") {
      quoted = character;
    } else if ((character === "-" && next === "-") || (character === "/" && next === "*")) {
      unavailable();
    } else if (character === "(") depth++;
    else if (character === ")") {
      depth--;
      if (depth < 0) unavailable();
    } else if (depth === 0 && body.startsWith(" AND ", i)) {
      parts.push(body.slice(from, i).trim());
      i += 4;
      from = i;
    }
  }
  parts.push(body.slice(from).trim());
  if (quoted || depth !== 0 || parts.length !== 74 || parts.some((part) => part.length === 0))
    unavailable();
  function balance(items: readonly string[]): string {
    if (items.length === 1) return items[0] as string;
    const midpoint = Math.floor(items.length / 2);
    return `(${balance(items.slice(0, midpoint))} AND ${balance(items.slice(midpoint))})`;
  }
  return `${sql.slice(0, start)}${balance(parts)}${sql.slice(end)}`;
}

/** RP's 81 code-built binds contain five BLOBs. Keep those typed; pack all
 * scalar binds into one lossless JSON value so a D1 receipt stays under 100. */
export function packFinancialRpCurrentness(statement: SqlStatement): Readonly<{
  sql: string;
  payload: string;
  blobs: readonly ArrayBuffer[];
}> {
  const params = statement.params;
  if (params?.length !== 81 || typeof statement.sql !== "string") unavailable();
  const scalar: (string | number | null)[] = [];
  const blobs: ArrayBuffer[] = [];
  const expressions = params.map((param) => {
    if (param instanceof ArrayBuffer) {
      if (blobs.length === 5 || param.byteLength > 65_536) unavailable();
      const index = blobs.push(param.slice(0)) - 1;
      return `(SELECT blob${index} FROM financial_consent_values)`;
    }
    if (
      param !== null &&
      typeof param !== "string" &&
      (typeof param !== "number" || !Number.isSafeInteger(param))
    )
      unavailable();
    if (
      typeof param === "string" &&
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        new TextEncoder().encode(param),
      ) !== param
    )
      unavailable();
    const index = scalar.push(param) - 1;
    return `(SELECT json_extract(payload,'$.values[${index}]') FROM financial_consent_values)`;
  });
  if (blobs.length !== 5 || scalar.length !== 76) unavailable();
  const source = balancedRpOuterWhere(statement.sql);
  let index = 0;
  let quoted: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  let output = "";
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    const next = source[i + 1];
    if (lineComment) {
      output += character;
      if (character === "\n") lineComment = false;
    } else if (blockComment) {
      output += character;
      if (character === "*" && next === "/") {
        output += next;
        i++;
        blockComment = false;
      }
    } else if (quoted) {
      output += character;
      if (character === quoted) {
        if (next === quoted) {
          output += next;
          i++;
        } else quoted = null;
      }
    } else if (character === "'" || character === '"' || character === "`") {
      quoted = character;
      output += character;
    } else if (character === "-" && next === "-") {
      lineComment = true;
      output += character + next;
      i++;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      output += character + next;
      i++;
    } else if (character === "?") {
      if (next && /[0-9]/u.test(next)) unavailable();
      output += expressions[index++] ?? unavailable();
    } else output += character;
  }
  if (quoted || blockComment || index !== params.length || output.length > 150_000) unavailable();
  return Object.freeze({ sql: output, payload: JSON.stringify({ values: scalar }), blobs });
}

/** Add one fixed guard to the unconditional L1/D receipt CASE. A false guard
 * violates that receipt's existing CHECK and rolls back every preceding write. */
export function guardCustomerConsentReceipt(
  plan: CustomerPhasePlan,
  predicates: FinancialCurrentConsentPredicates,
): CustomerPhasePlan {
  if (plan.phase !== "L1" && plan.phase !== "D") unavailable();
  // Customer statements only; Root's Money writer adds its permit frame around them.
  const receiptIndex = plan.phase === "L1" ? 3 : 2;
  if (plan.statements.length !== (plan.phase === "L1" ? 7 : 6)) unavailable();
  const selected = plan.statements[receiptIndex];
  if (!selected?.params || !predicates.root.params) unavailable();
  const target =
    plan.phase === "L1"
      ? "INSERT INTO financial_customer_admission_receipts"
      : "INSERT INTO financial_customer_dispatch_receipts";
  const at = selected.sql.lastIndexOf(target);
  const end = " THEN 1 ELSE 0 END)";
  if (at < 0 || !selected.sql.endsWith(end) || selected.sql.indexOf(target) !== at) unavailable();
  const rp = packFinancialRpCurrentness(predicates.rp);
  const issuer = predicates.issuer;
  if (
    issuer.registrationRef !== "shared-financial-action-consent-rp" ||
    issuer.incarnation !== "1" ||
    !/^sha256:[0-9a-f]{64}$/u.test(issuer.registrationDigest) ||
    !Number.isSafeInteger(predicates.acceptedAt) ||
    !Number.isSafeInteger(predicates.expiresAt) ||
    predicates.expiresAt <= predicates.acceptedAt
  )
    unavailable();
  const payload = JSON.stringify({
    values: JSON.parse(rp.payload).values,
    issuer,
    acceptedAt: predicates.acceptedAt,
    expiresAt: predicates.expiresAt,
  });
  const ctes = `,\n financial_consent_values(payload,blob0,blob1,blob2,blob3,blob4) AS MATERIALIZED (VALUES (?,?,?,?,?,?)),
 financial_consent_rp AS MATERIALIZED (${rp.sql}),
 financial_consent_root(ok) AS MATERIALIZED (SELECT CASE WHEN (${predicates.root.sql}) THEN 1 ELSE 0 END),
 financial_consent_guard(ok) AS MATERIALIZED (
 SELECT CASE WHEN (SELECT count(*) FROM financial_consent_rp)=1
  AND (SELECT ok FROM financial_consent_root)=1
  AND EXISTS(SELECT 1 FROM ${SHARED_AUTH_FINANCIAL_CONSENT_ISSUERS} issuer
   WHERE issuer.registration_ref IS json_extract(cv.payload,'$.issuer.registrationRef')
    AND issuer.incarnation IS json_extract(cv.payload,'$.issuer.incarnation')
    AND issuer.registration_digest IS json_extract(cv.payload,'$.issuer.registrationDigest')
    AND issuer.original_json IS ${sqlString(ISSUER_ORIGINAL_JSON)})
  AND json_extract(cv.payload,'$.acceptedAt')<=${SQL_NOW_MS}
  AND ${SQL_NOW_MS}<json_extract(cv.payload,'$.expiresAt')
 THEN 1 ELSE 0 END FROM financial_consent_values cv)`;
  const prefix = selected.sql.slice(0, at).trimEnd();
  const body = selected.sql.slice(at, -end.length);
  const sql = `${prefix}${ctes}\n ${body} AND (SELECT ok FROM financial_consent_guard)=1${end}`;
  const params = [
    ...(selected.params.slice(0, 1) as SqlParam[]),
    payload,
    ...rp.blobs,
    ...predicates.root.params,
    ...selected.params.slice(1),
  ];
  if (
    params.length > 100 ||
    (sql.match(/\?/gu)?.length ?? 0) !== params.length ||
    sql.length > 250_000
  )
    unavailable();
  const statements = [...plan.statements];
  statements[receiptIndex] = Object.freeze({ sql, params: Object.freeze(params) });
  if (!isFinancialCustomerMoneyFencedBatch(statements)) unavailable();
  return Object.freeze({ ...plan, statements: Object.freeze(statements) });
}
