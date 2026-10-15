import { describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { miniflareServiceBinding } from "./helpers/miniflare-service-binding.ts";

const stamp = 1792022400000;
// Matches the existing repository's pinned Miniflare/workerd test capability.
const compatibilityDate = "2026-08-18";
const nativeIssuer = `
import { WorkerEntrypoint } from "cloudflare:workers";
const encode = (bytes) => {
  let text = "";
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};
export class OidcIssuer extends WorkerEntrypoint {
  async fetch(request) {
    const env = this.env;
    const url = new URL(request.url);
    if (url.searchParams.has("redirect")) return new Response(null, { status: 302, headers: { location: "https://other.example.test/never-follow" } });
    if (url.pathname === "/oauth/jwks") return Response.json({ keys: [JSON.parse(env.PUBLIC_JWK)] });
    const expected = url.pathname === "/oauth/userinfo" ? "Bearer test-access" : "Basic " + btoa("takoserver-console-staging-v1:test-only-native-client-secret");
    if (request.headers.get("authorization") !== expected) return new Response(null, { status: 401 });
    if (url.pathname === "/oauth/userinfo") return Response.json({ sub: "test-canonical-account", aud: "takoserver-console-staging-v1", scope: "openid email offline_access" });
    if (url.pathname === "/oauth/introspect") return Response.json({ active: true, token_use: "oauth_access", sub: "test-canonical-account", client_id: "takoserver-console-staging-v1", aud: "takoserver-console-staging-v1", scope: "openid email offline_access", exp: ${stamp / 1000 + 300} });
    if (url.pathname === "/oauth/revoke") return new Response(null, { status: 204 });
    if (url.pathname !== "/oauth/token") return new Response(null, { status: 404 });
    const form = new URLSearchParams(await request.text());
    const claims = { iss: "https://auth-staging.example.test", aud: "takoserver-console-staging-v1", sub: "test-canonical-account", sid: "test-accounts-session", auth_time: ${stamp / 1000 - 60}, iat: ${stamp / 1000}, exp: ${stamp / 1000 + 300}, ...(form.get("grant_type") === "authorization_code" ? { nonce: "test-nonce" } : {}) };
    const payload = encode(new TextEncoder().encode(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "test-native-stage-key" }))) + "." + encode(new TextEncoder().encode(JSON.stringify(claims)));
    const key = await crypto.subtle.importKey("jwk", JSON.parse(env.PRIVATE_JWK), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(payload));
    return Response.json({ id_token: payload + "." + encode(signature), access_token: "test-access", refresh_token: "test-next-refresh", token_type: "Bearer", expires_in: 300, scope: "openid email offline_access" });
  }
}
export default {};`;

async function runtime() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicKey = {
    ...(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    alg: "ES256",
    use: "sig",
    kid: "test-native-stage-key",
  };
  const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const build = await Bun.build({
    entrypoints: [new URL("./fixtures/shared-auth-oidc-worker.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
    minify: false,
  });
  if (!build.success || build.outputs.length !== 1)
    throw new Error("native OIDC fixture build failed");
  const output = build.outputs[0];
  if (!output) throw new Error("native OIDC fixture output missing");
  return new Miniflare({
    workers: [
      {
        config: {
          name: "shared-auth-native-rp",
          type: "worker",
          compatibilityDate,
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: await output.text() } },
          },
          env: {
            ISSUER: miniflareServiceBinding("worker", "shared-auth-native-issuer", "OidcIssuer"),
          },
          triggers: [],
        },
      },
      {
        config: {
          name: "shared-auth-native-issuer",
          type: "worker",
          compatibilityDate,
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: nativeIssuer } },
          },
          env: {
            PUBLIC_JWK: { type: "text", value: JSON.stringify(publicKey) },
            PRIVATE_JWK: { type: "text", value: JSON.stringify(privateKey) },
          },
          triggers: [],
        },
      },
    ],
  });
}

describe("shared-account protocol in workerd", () => {
  test("executes signed exchange, rotating refresh, activity, current-account lookup and revocation", async () => {
    const mf = await runtime();
    try {
      const worker = await mf.getWorker("shared-auth-native-rp");
      for (const path of ["exchange", "refresh"]) {
        const response = await worker.fetch(`https://rp.example.test/${path}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          subject: "test-canonical-account",
          sessionId: "test-accounts-session",
          authTime: stamp / 1000 - 60,
          rotated: true,
        });
      }
      const active = await worker.fetch("https://rp.example.test/active");
      expect(active.status).toBe(200);
      expect(await active.json()).toEqual({ active: true });
      const account = await worker.fetch("https://rp.example.test/account");
      expect(account.status).toBe(200);
      expect(await account.json()).toEqual({ accountId: "test-canonical-account" });
      expect((await worker.fetch("https://rp.example.test/revoke")).status).toBe(204);
    } finally {
      await mf.dispose();
    }
  }, 30000);

  test("rejects redirects for every credential-bearing issuer operation", async () => {
    const mf = await runtime();
    try {
      const worker = await mf.getWorker("shared-auth-native-rp");
      for (const path of ["exchange", "refresh", "active", "account", "revoke"]) {
        const response = await worker.fetch(`https://rp.example.test/${path}-redirect`);
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ code: "oidc_invalid" });
      }
    } finally {
      await mf.dispose();
    }
  }, 30000);
});
