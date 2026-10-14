import {
  createSharedAuthOidcClient,
  type SharedAuthGrant,
  SharedAuthOidcError,
} from "../../src/shared-auth-oidc-client.ts";

const stamp = 1792022400000;
const issuer = "https://auth-staging.example.test";
const clientId = "takoserver-console-staging-v1";
const previous: SharedAuthGrant = {
  issuer,
  clientId,
  subject: "test-canonical-account",
  sessionId: "test-accounts-session",
  authTime: stamp / 1000 - 60,
  accessToken: "test-access",
  refreshToken: "test-old-refresh",
  accessExpiresAt: stamp - 1,
  nonce: "test-nonce",
};

/** Local-only harness. The product client executes inside actual workerd. */
export default {
  async fetch(request: Request, env: { ISSUER: { fetch(request: Request): Promise<Response> } }) {
    const path = new URL(request.url).pathname;
    const redirect = path.endsWith("-redirect");
    const client = createSharedAuthOidcClient({
      config: {
        environment: "staging",
        issuer,
        publicOrigin: "https://console-staging.example.test",
        clientId,
        clientSecret: "test-only-native-client-secret",
      },
      now: () => stamp,
      fetch: (outgoing) =>
        env.ISSUER.fetch(redirect ? new Request(`${outgoing.url}?redirect=1`, outgoing) : outgoing),
    });
    try {
      if (path.startsWith("/exchange")) {
        const grant = await client.exchange(
          "test-code",
          "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG",
          "test-nonce",
        );
        return Response.json({
          subject: grant.subject,
          sessionId: grant.sessionId,
          authTime: grant.authTime,
          rotated: grant.refreshToken !== previous.refreshToken,
        });
      }
      if (path.startsWith("/refresh")) {
        const grant = await client.refresh(previous);
        return Response.json({
          subject: grant.subject,
          sessionId: grant.sessionId,
          authTime: grant.authTime,
          rotated: grant.refreshToken !== previous.refreshToken,
        });
      }
      if (path.startsWith("/active"))
        return Response.json({ active: await client.active(previous) });
      if (path.startsWith("/account"))
        return Response.json(await client.canonicalAccount(previous));
      if (path.startsWith("/revoke")) {
        await client.revoke(previous);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    } catch (error) {
      return Response.json(
        { code: error instanceof SharedAuthOidcError ? error.code : "unexpected" },
        { status: 502 },
      );
    }
  },
};
