import { createSharedAuthSession, SharedAuthSessionError } from "../../src/shared-auth-session.ts";
import { createSharedAuthSessionStore } from "../../src/shared-auth-session-store.ts";
import { createD1Sql, type D1DatabaseLike } from "../../src/sql-d1.ts";
import {
  SESSION_TEST_CONFIG,
  SESSION_TEST_CONSOLE,
} from "../helpers/shared-auth-session-issuer.ts";

/** Local-only composition; it neither mounts nor qualifies a product entry. */
export default {
  async fetch(
    request: Request,
    env: {
      AUTH_DB: { withSession(constraint: "first-primary"): D1DatabaseLike };
      ISSUER: { fetch(request: Request): Promise<Response> };
      NOW: string;
    },
  ) {
    // Miniflare's local platform proxy reserves Origin for its own CSRF gate.
    // Reconstruct this synthetic request inside workerd, not a product route.
    const testOrigin = request.headers.get("x-test-origin");
    if (testOrigin !== null) {
      const headers = new Headers(request.headers);
      headers.delete("x-test-origin");
      headers.set("origin", testOrigin);
      request = new Request(request, { headers });
    }
    const sessions = createSharedAuthSession({
      config: SESSION_TEST_CONFIG,
      consoleOrigin: SESSION_TEST_CONSOLE,
      encryptionKey: new Uint8Array(32).fill(41),
      store: () =>
        createSharedAuthSessionStore(createD1Sql(env.AUTH_DB.withSession("first-primary"))),
      // This synthetic projection exercises the required port, not enrollment.
      principals: {
        async resolve(input) {
          return { accountId: input.accountId, principalId: "retained-local-principal" };
        },
      },
      organizations: {
        async pin(input) {
          return input;
        },
      },
      fetch: (outgoing) => env.ISSUER.fetch(outgoing),
      now: () => Number(request.headers.get("x-test-clock") ?? env.NOW),
    });
    try {
      const path = new URL(request.url).pathname;
      if (path === "/test/context") return Response.json(await sessions.authenticate(request));
      if (path === "/test/drain") return Response.json(await sessions.retryRevocations());
      return (await sessions.fetch(request)) ?? new Response(null, { status: 404 });
    } catch (error) {
      return Response.json(
        { code: error instanceof SharedAuthSessionError ? error.code : "unexpected" },
        { status: 503 },
      );
    }
  },
};
