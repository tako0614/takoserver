import { type Row, type SqlAccess, SqlError, type SqlParam, type SqlWrite } from "./ports.ts";

/**
 * `SqlAccess` over the D1 HTTP API, for a host that has no binding.
 *
 * Operator maintenance scripts can read and write the same state the Worker
 * serves when an explicit migration or transfer needs it. A Worker reaches D1
 * through a binding; a script can only reach it over HTTP, so this adapter
 * exists.
 *
 * It is host-only for the same reason the Cloudflare provider is: it needs an
 * account credential, which must never be reachable from a Worker bundle. The
 * import gate enforces that.
 *
 * The HTTP API has no equivalent of the binding's implicit batch transaction,
 * so this adapter intentionally exposes only the non-atomic access seam. A
 * caller that needs atomicity cannot accept this result as a `Sql` value and
 * therefore finds out at composition time instead of in production.
 */
export interface D1HttpOptions {
  readonly accountId: string;
  readonly databaseId: string;
  /** Returns an `Authorization` header value. */
  readonly authorize: () => string | Promise<string>;
  readonly apiOrigin?: string;
  readonly fetch?: (request: Request) => Promise<Response>;
}

export function createD1HttpSql(options: D1HttpOptions): SqlAccess {
  const origin = options.apiOrigin ?? "https://api.cloudflare.com/client/v4";
  const endpoint = `${origin}/accounts/${options.accountId}/d1/database/${options.databaseId}/query`;
  const send = options.fetch ?? ((request: Request) => fetch(request));

  const execute = async (sql: string, params: readonly SqlParam[]): Promise<SqlWrite> => {
    let response: Response;
    try {
      response = await send(
        new Request(endpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: await options.authorize(),
            "content-type": "application/json",
          },
          body: JSON.stringify({ sql, params: params.map(bindable) }),
        }),
      );
    } catch {
      throw new SqlError("unavailable", "the D1 HTTP API is unreachable");
    }
    const text = await response.text();
    let envelope: {
      success?: unknown;
      errors?: { message?: string }[];
      result?: { results?: Row[]; meta?: { changes?: number } }[];
    };
    try {
      envelope = JSON.parse(text) as typeof envelope;
    } catch {
      throw new SqlError("unavailable", "the D1 HTTP API returned an unparsable body");
    }
    if (!response.ok || envelope.success !== true) {
      const message = envelope.errors?.[0]?.message ?? `status ${response.status}`;
      // Constraint violations are load-bearing: they are how a guard aborts.
      throw new SqlError(
        /constraint|unique|check/iu.test(message) ? "constraint" : "unavailable",
        message,
      );
    }
    const first = envelope.result?.[0];
    const changes = first?.meta?.changes;
    return {
      rows: first?.results ?? [],
      changes: typeof changes === "number" && Number.isSafeInteger(changes) ? changes : 0,
    };
  };

  return {
    async query(sql, params): Promise<readonly Row[]> {
      return (await execute(sql, params ?? [])).rows;
    },

    async run(sql, params): Promise<SqlWrite> {
      return await execute(sql, params ?? []);
    },
  };
}

function bindable(value: SqlParam): string | number | null {
  if (value instanceof ArrayBuffer) {
    throw new SqlError("invalid", "the D1 HTTP transport does not carry binary parameters");
  }
  return value;
}
