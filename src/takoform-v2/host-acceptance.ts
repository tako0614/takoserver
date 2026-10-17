import type { JsonObject, Sql, SqlStatement } from "../ports.ts";
import type { V2ConfiguredPrivateInputs } from "./configured-private-inputs.ts";
import type { V2SealedPrivateInputs } from "./private-inputs.ts";

/** Internal Host construction contract, never a Form declaration or request witness. */
export interface V2HostAcceptanceContext {
  readonly action: "create" | "update";
  readonly principal: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly operationId: string;
  readonly resourceUid: string;
  readonly generation: number;
  readonly at: string;
  readonly retainUntil: string;
  readonly form: string;
  readonly space: string;
  readonly name: string;
  readonly backendId: string;
  readonly targetKey: string;
  readonly specJson: string;
  readonly outputJson: string;
  readonly referencesJson: string | null;
  readonly privateInputs?: V2SealedPrivateInputs;
  readonly configuredPrivateInputs?: V2ConfiguredPrivateInputs;
}

export type V2HostDeleteAcceptanceContext = Omit<
  V2HostAcceptanceContext,
  "action" | "referencesJson"
> & {
  readonly action: "delete";
  readonly referencesJson: null;
};

type V2AnyHostAcceptanceContext = V2HostAcceptanceContext | V2HostDeleteAcceptanceContext;

export type V2HostAcceptanceScope = Pick<
  V2HostAcceptanceContext,
  "form" | "backendId" | "targetKey" | "name"
>;

export interface V2HostAcceptance {
  /** The concrete issuer checks its construction Sql by object identity. */
  assertSql(sql: Sql): void;
  initialOutput(scope: V2HostAcceptanceScope): JsonObject | undefined;
  prepare(context: V2HostAcceptanceContext): Promise<V2PreparedHostAcceptance> | undefined;
  prepareDelete?(
    context: V2HostDeleteAcceptanceContext,
  ): Promise<V2PreparedHostAcceptance> | undefined;
}

/** Capture trusted construction methods once; no public config or request enters this seam. */
export function captureV2HostAcceptance(
  value: V2HostAcceptance | undefined,
  sql: Sql,
): V2HostAcceptance | undefined {
  if (value === undefined) return undefined;
  const assertSqlMethod = value?.assertSql;
  const initialOutputMethod = value?.initialOutput;
  const prepareMethod = value?.prepare;
  const deleteDescriptor =
    value === null || (typeof value !== "object" && typeof value !== "function")
      ? undefined
      : Object.getOwnPropertyDescriptor(value, "prepareDelete");
  const deleteMethod: unknown = deleteDescriptor?.value;
  if (
    (deleteDescriptor === undefined &&
      value !== null &&
      (typeof value === "object" || typeof value === "function") &&
      "prepareDelete" in value) ||
    (deleteDescriptor !== undefined &&
      (!Object.hasOwn(deleteDescriptor, "value") || typeof deleteMethod !== "function"))
  )
    throw new TypeError("invalid internal Host DELETE acceptance construction");
  if (
    value === null ||
    typeof assertSqlMethod !== "function" ||
    typeof initialOutputMethod !== "function" ||
    typeof prepareMethod !== "function"
  )
    throw new TypeError("invalid internal Host acceptance construction");
  const assertSql = assertSqlMethod.bind(value);
  const initialOutput = initialOutputMethod.bind(value);
  const prepare = prepareMethod.bind(value);
  const prepareDelete: V2HostAcceptance["prepareDelete"] =
    typeof deleteMethod === "function" ? deleteMethod.bind(value) : undefined;
  assertSql(sql);
  return Object.freeze({
    assertSql,
    initialOutput,
    prepare,
    ...(prepareDelete === undefined ? {} : { prepareDelete }),
  });
}

const issuer = Symbol("internal prepared Host acceptance");

function statement(value: SqlStatement): SqlStatement {
  if ((value.params?.length ?? 0) > 100) throw new TypeError("Host acceptance parameter limit");
  return Object.freeze({
    sql: value.sql,
    ...(value.params === undefined
      ? {}
      : {
          params: Object.freeze(
            value.params.map((param) => (param instanceof ArrayBuffer ? param.slice(0) : param)),
          ),
        }),
  });
}

class PreparedHostAcceptance {
  readonly #sql: Sql;
  readonly #context: V2AnyHostAcceptanceContext;
  readonly #guard: SqlStatement;
  readonly #terminal: SqlStatement;

  constructor(
    key: symbol,
    sql: Sql,
    context: V2AnyHostAcceptanceContext,
    guard: SqlStatement,
    terminal: SqlStatement,
  ) {
    if (key !== issuer) throw new TypeError("invalid prepared Host acceptance issuer");
    this.#sql = sql;
    this.#context = context;
    this.#guard = statement(guard);
    this.#terminal = statement(terminal);
    Object.freeze(this);
  }

  static redeem(value: PreparedHostAcceptance, sql: Sql, context: V2AnyHostAcceptanceContext) {
    if (
      typeof value !== "object" ||
      value === null ||
      !(#sql in value) ||
      value.#sql !== sql ||
      value.#context !== context
    )
      throw new TypeError("prepared Host acceptance belongs to another Store or context");
    return { guard: value.#guard, terminal: value.#terminal };
  }
}

Object.freeze(PreparedHostAcceptance.prototype);
Object.freeze(PreparedHostAcceptance);

export type V2PreparedHostAcceptance = PreparedHostAcceptance;

/**
 * Source-internal builder for the one reviewed domain compiler. Not exported by
 * the package or available to Form modules. The fixed owner SQL, not this seal,
 * must prove the exact accepted graph and abort on a missing terminal proof.
 */
export function prepareV2HostAcceptance(
  sql: Sql,
  context: V2AnyHostAcceptanceContext,
  guard: SqlStatement,
  terminal: SqlStatement,
): V2PreparedHostAcceptance {
  return new PreparedHostAcceptance(issuer, sql, context, guard, terminal);
}

export function redeemV2HostAcceptance(
  value: V2PreparedHostAcceptance,
  sql: Sql,
  context: V2AnyHostAcceptanceContext,
) {
  return PreparedHostAcceptance.redeem(value, sql, context);
}
