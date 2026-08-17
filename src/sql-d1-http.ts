import {
  type Row,
  type Sql,
  SqlError,
  type SqlParam,
  type SqlStatement,
  type SqlWrite,
} from "./ports.ts";

/**
 * `Sql` over the D1 HTTP API, for a host that has no binding.
 *
 * The self-hosted provisioner has to read and write the same state the Worker
 * serves, or the product would be two products with two truths — an
 * organization created through the API would be invisible to the process that
 * provisions for it. A Worker reaches D1 through a binding; a host can only
 * reach it over HTTP, so this adapter exists.
 *
 * It is host-only for the same reason the Cloudflare provider is: it needs an
 * account credential, which must never be reachable from a Worker bundle. The
 * import gate enforces that.
 *
 * **`batch` is not atomic on this transport.** The HTTP API offers no
 * equivalent of the binding's implicit batch transaction, so the statements are
 * sent in order and a failure part-way leaves earlier ones applied. Nothing in
 * the product depends on batch atomicity today — every invariant is carried by
 * a single guarded statement — and this refuses rather than pretending: a batch
 * of more than one statement is rejected, so a future caller that does need
 * atomicity finds out here instead of in production.
 */
export interface D1HttpOptions {
  readonly accountId: string;
  readonly databaseId: string;
  /** Returns an `Authorization` header value. */
  readonly authorize: () => string | Promise<string>;
  readonly apiOrigin?: string;
  readonly fetch?: (request: Request) => Promise<Response>;
}

export function createD1HttpSql(options: D1HttpOptions): Sql {
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

    async batch(statements: readonly SqlStatement[]): Promise<readonly SqlWrite[]> {
      if (statements.length === 0) return [];
      if (statements.length > 1) {
        throw new SqlError(
          "invalid",
          "the D1 HTTP transport cannot commit a batch atomically; use guarded single statements",
        );
      }
      const only = statements[0];
      if (!only) return [];
      return [await execute(only.sql, only.params ?? [])];
    },
  };
}

function bindable(value: SqlParam): string | number | null {
  if (value instanceof ArrayBuffer) {
    throw new SqlError("invalid", "the D1 HTTP transport does not carry binary parameters");
  }
  return value;
}
