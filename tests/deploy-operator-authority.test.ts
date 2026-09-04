import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutationError } from "../scripts/deploy/errors.ts";
import {
  provePrivateMatchesPublic,
  readOperatorSignInIdentity,
  readPrivateJwk,
  withOperatorOwnerSession,
} from "../scripts/deploy/operator-authority.ts";
import { normalizeGeneratedEd25519PrivateJwk } from "../src/ed25519-private-jwk.ts";
import { resolveIdentity } from "../src/identity-setup.ts";
import {
  buildApp,
  createEphemeralSql,
  createMemoryObjectStore,
  InMemoryTakoformResourceDriver,
} from "../src/index.ts";
import { createOperatorSettlement } from "../src/operator-credentials.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";

const ORIGIN = "https://api.production.example.test";
const ORGANIZATION = "org_production_owner";
const IDENTITY = {
  kind: "takoserver.operator-sign-in-identity@v1",
  provider: "github",
  subject: "production-owner",
  email: "owner@example.test",
  displayName: "Production Owner",
} as const;

describe("operator authority", () => {
  test("accepts only an owned exact Ed25519 private JWK and proves its public pair", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-operator-authority-key-"));
    try {
      const pair = (await crypto.subtle.generateKey("Ed25519", true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      const privateJwk = normalizeGeneratedEd25519PrivateJwk(
        await crypto.subtle.exportKey("jwk", pair.privateKey),
      );
      const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & {
        x: string;
      };
      const path = join(root, "operator.jwk");
      writeFileSync(path, JSON.stringify(privateJwk), { mode: 0o600 });
      chmodSync(path, 0o600);
      const input = readPrivateJwk(path);
      await expect(
        provePrivateMatchesPublic(input, {
          kty: "OKP",
          crv: "Ed25519",
          x: publicJwk.x,
        }),
      ).resolves.toBeUndefined();

      execFileSync("chmod", ["4600", path]);
      expect(() => readPrivateJwk(path)).toThrow("owned 0600");
      chmodSync(path, 0o600);

      for (const rejected of [
        { ...privateJwk, d: "not-base64url-32" },
        { ...privateJwk, unexpected: true },
        { ...privateJwk, crv: "X25519" },
      ]) {
        writeFileSync(path, JSON.stringify(rejected), { mode: 0o600 });
        chmodSync(path, 0o600);
        expect(() => readPrivateJwk(path)).toThrow("exact Ed25519 signing key");
      }

      const otherPair = (await crypto.subtle.generateKey("Ed25519", true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      const otherPrivate = await crypto.subtle.exportKey("jwk", otherPair.privateKey);
      writeFileSync(path, JSON.stringify({ ...privateJwk, d: otherPrivate.d }), { mode: 0o600 });
      chmodSync(path, 0o600);
      await expect(
        provePrivateMatchesPublic(readPrivateJwk(path), {
          kty: "OKP",
          crv: "Ed25519",
          x: publicJwk.x,
        }),
      ).rejects.toThrow("does not match target public JWK");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the exact private identity to prove selected-organization ownership and session death", async () => {
    const fixture = await authorityFixture();
    try {
      const calls: string[] = [];
      let revoked = false;
      const result = await withOperatorOwnerSession(
        {
          origin: ORIGIN,
          organizationId: ORGANIZATION,
          privateInput: readPrivateJwk(fixture.privateJwkPath),
          identity: readOperatorSignInIdentity(fixture.identityPath),
          now: () => new Date("2026-09-03T12:00:00.000Z"),
          phase: "verification",
          fetcher: async (input, init) => {
            const request = new Request(input, init);
            const path = new URL(request.url).pathname;
            calls.push(`${request.method} ${path}`);
            if (
              request.method === "POST" &&
              (path === "/v1/operator-owner-proof" || path === "/v1/sessions")
            ) {
              const body = (await request.json()) as Record<string, unknown>;
              const assertion = String(body.assertion ?? "");
              const [payload, signature] = assertion.split(".");
              const valid =
                payload !== undefined &&
                signature !== undefined &&
                (await crypto.subtle.verify(
                  "Ed25519",
                  fixture.publicKey,
                  Buffer.from(signature, "base64url"),
                  new TextEncoder().encode(payload),
                ));
              expect(valid).toBe(true);
              expect(body).toMatchObject({ provider: "github", method: "operator-assertion" });
              const claims = JSON.parse(
                Buffer.from(payload ?? "", "base64url").toString("utf8"),
              ) as Record<string, unknown>;
              expect(claims.aud).toBe(ORIGIN);
              if (path === "/v1/operator-owner-proof") {
                expect(body.organizationId).toBe(ORGANIZATION);
                return Response.json({
                  principal: principal(),
                  organization: organization("prn_production_owner"),
                });
              }
              return Response.json({ principal: principal(), sessionToken: "session-secret" });
            }
            if (request.method === "GET" && path === "/v1/me") {
              return revoked
                ? Response.json({ error: { code: "unauthenticated" } }, { status: 401 })
                : Response.json({
                    principal: principal(),
                    organizations: [organization("prn_production_owner")],
                  });
            }
            if (request.method === "DELETE" && path === "/v1/session") {
              revoked = true;
              return new Response(null, { status: 204 });
            }
            return Response.json({ ok: true });
          },
        },
        async (session) => {
          const response = await session.request("/v1/organizations/org_production_owner/api-keys");
          expect(response.status).toBe(200);
          return "used" as const;
        },
      );
      expect(result).toEqual({
        value: "used",
        proof: {
          sessionStatus: 200,
          meStatus: 200,
          organizationId: ORGANIZATION,
          organizationRole: "owner",
          revokeStatus: 204,
          replayStatus: 401,
          assertionRedacted: true,
          sessionRedacted: true,
        },
      });
      expect(calls).toEqual([
        "POST /v1/operator-owner-proof",
        "POST /v1/sessions",
        "GET /v1/me",
        "GET /v1/organizations/org_production_owner/api-keys",
        "DELETE /v1/session",
        "GET /v1/me",
      ]);
      expect(JSON.stringify(result)).not.toContain("session-secret");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("refuses a sign-in identity that is not an owned exact 0600 v1 input", async () => {
    const fixture = await authorityFixture();
    try {
      chmodSync(fixture.identityPath, 0o644);
      expect(() => readOperatorSignInIdentity(fixture.identityPath)).toThrow("owned 0600");
      execFileSync("chmod", ["4600", fixture.identityPath]);
      expect(() => readOperatorSignInIdentity(fixture.identityPath)).toThrow("owned 0600");
      writeFileSync(fixture.identityPath, JSON.stringify({ ...IDENTITY, extra: true }), {
        mode: 0o600,
      });
      chmodSync(fixture.identityPath, 0o600);
      expect(() => readOperatorSignInIdentity(fixture.identityPath)).toThrow(
        "takoserver.operator-sign-in-identity@v1",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("refuses an organization-owner mismatch before creating a session", async () => {
    const fixture = await authorityFixture();
    try {
      const calls: string[] = [];
      const failure = await withOperatorOwnerSession(
        {
          origin: ORIGIN,
          organizationId: ORGANIZATION,
          privateInput: readPrivateJwk(fixture.privateJwkPath),
          identity: readOperatorSignInIdentity(fixture.identityPath),
          phase: "preflight",
          fetcher: async (input, init) => {
            const request = new Request(input, init);
            const path = new URL(request.url).pathname;
            calls.push(`${request.method} ${path}`);
            return request.method === "POST" && path === "/v1/operator-owner-proof"
              ? Response.json({ error: { code: "not_found" } }, { status: 404 })
              : new Response(null, { status: 500 });
          },
        },
        async () => "must-not-run",
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ phase: "preflight" });
      expect((failure as Error).message).toContain("does not prove existing exact ownership");
      expect(calls).toEqual(["POST /v1/operator-owner-proof"]);
      expect(`${(failure as Error).message}${JSON.stringify(failure)}`).not.toContain(
        "session-secret",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("revokes a usable session even when the sign-in response shape drifts", async () => {
    const fixture = await authorityFixture();
    try {
      const calls: string[] = [];
      let revoked = false;
      const failure = await withOperatorOwnerSession(
        {
          origin: ORIGIN,
          organizationId: ORGANIZATION,
          privateInput: readPrivateJwk(fixture.privateJwkPath),
          identity: readOperatorSignInIdentity(fixture.identityPath),
          phase: "verification",
          fetcher: async (input, init) => {
            const request = new Request(input, init);
            const path = new URL(request.url).pathname;
            calls.push(`${request.method} ${path}`);
            if (request.method === "POST" && path === "/v1/operator-owner-proof") {
              return Response.json({
                principal: principal(),
                organization: organization("prn_production_owner"),
              });
            }
            if (request.method === "POST") {
              return Response.json({
                principal: principal(),
                sessionToken: "session-secret",
                unexpected: true,
              });
            }
            if (request.method === "DELETE") {
              revoked = true;
              return new Response(null, { status: 204 });
            }
            return new Response(null, { status: revoked ? 401 : 200 });
          },
        },
        async () => "must-not-run",
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ phase: "verification" });
      expect((failure as Error).message).toContain("malformed redacted response");
      expect(calls).toEqual([
        "POST /v1/operator-owner-proof",
        "POST /v1/sessions",
        "DELETE /v1/session",
        "GET /v1/me",
      ]);
      expect(`${(failure as Error).message}${JSON.stringify(failure)}`).not.toContain(
        "session-secret",
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("settles a lost revocation acknowledgement by replay without retry", async () => {
    const fixture = await authorityFixture();
    try {
      let revoked = false;
      let deletes = 0;
      const result = await withOperatorOwnerSession(
        {
          origin: ORIGIN,
          organizationId: ORGANIZATION,
          privateInput: readPrivateJwk(fixture.privateJwkPath),
          identity: readOperatorSignInIdentity(fixture.identityPath),
          phase: "verification",
          fetcher: async (input, init) => {
            const request = new Request(input, init);
            const path = new URL(request.url).pathname;
            if (request.method === "POST" && path === "/v1/operator-owner-proof") {
              return Response.json({
                principal: principal(),
                organization: organization("prn_production_owner"),
              });
            }
            if (request.method === "POST") {
              return Response.json({ principal: principal(), sessionToken: "session-secret" });
            }
            if (request.method === "DELETE") {
              deletes += 1;
              revoked = true;
              throw new Error("lost acknowledgement");
            }
            return revoked
              ? new Response(null, { status: 401 })
              : Response.json({
                  principal: principal(),
                  organizations: [organization("prn_production_owner")],
                });
          },
        },
        async () => "used" as const,
      );
      expect(result).toMatchObject({
        value: "used",
        proof: { revokeStatus: "transport-error", replayStatus: 401 },
      });
      expect(deletes).toBe(1);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("preserves a primary mutation outcome together with a cleanup failure", async () => {
    const fixture = await authorityFixture();
    try {
      let revoked = false;
      const failure = await withOperatorOwnerSession(
        {
          origin: ORIGIN,
          organizationId: ORGANIZATION,
          privateInput: readPrivateJwk(fixture.privateJwkPath),
          identity: readOperatorSignInIdentity(fixture.identityPath),
          phase: "mutation",
          cleanupPhase: "verification",
          fetcher: async (input, init) => {
            const request = new Request(input, init);
            const path = new URL(request.url).pathname;
            if (request.method === "POST" && path === "/v1/operator-owner-proof") {
              return Response.json({
                principal: principal(),
                organization: organization("prn_production_owner"),
              });
            }
            if (request.method === "POST") {
              return Response.json({ principal: principal(), sessionToken: "session-secret" });
            }
            if (request.method === "DELETE") {
              revoked = true;
              return new Response(null, { status: 204 });
            }
            if (revoked) return Response.json({ body: "must-not-leak" }, { status: 200 });
            return Response.json({
              principal: principal(),
              organizations: [organization("prn_production_owner")],
            });
          },
        },
        async () => {
          throw mutationError(
            "mint acknowledgement is indeterminate; do not retry before --status",
          );
        },
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        phase: "mutation",
        message: "mint acknowledgement is indeterminate; do not retry before --status",
      });
      expect(JSON.parse(String((failure as { detail?: string }).detail))).toEqual({
        primary: {
          phase: "mutation",
          message: "mint acknowledgement is indeterminate; do not retry before --status",
        },
        cleanup: {
          phase: "verification",
          message: "operator authority proof session remains usable after revocation",
        },
      });
      expect(JSON.stringify(failure)).not.toContain("session-secret");
      expect(JSON.stringify(failure)).not.toContain("must-not-leak");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("proves ownership against the real Host identity and organization ledger", async () => {
    const fixture = await authorityFixture();
    const now = new Date("2026-09-03T12:00:00.000Z");
    try {
      const setup = resolveIdentity({
        operatorPublicKeyJwk: fixture.publicJwk,
        operatorAudience: ORIGIN,
        clock: () => now,
      });
      const sql = createEphemeralSql();
      const app = buildApp({
        sql,
        objects: createMemoryObjectStore(),
        identity: setup.verifier,
        identityProviders: setup.providers,
        settlement: createOperatorSettlement({ publicKeyJwk: fixture.publicJwk, clock: () => now }),
        publicOrigin: ORIGIN,
        forms: [],
        hostForms: [],
        driver: new InMemoryTakoformResourceDriver(),
        offerings: [],
      });
      const privateInput = readPrivateJwk(fixture.privateJwkPath);
      const assertion = await signOperatorAssertion({
        privateJwk: JSON.stringify(privateInput.jwk),
        claims: {
          purpose: "sign-in",
          aud: ORIGIN,
          provider: IDENTITY.provider,
          subject: IDENTITY.subject,
          email: IDENTITY.email,
          displayName: IDENTITY.displayName,
        },
        nowSeconds: Math.floor(now.getTime() / 1_000),
        lifetimeSeconds: 60,
      });
      const signedIn = await app.fetch(
        new Request(`${ORIGIN}/v1/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: IDENTITY.provider,
            method: "operator-assertion",
            assertion,
          }),
        }),
      );
      const signedInBody = (await signedIn.json()) as { sessionToken: string };
      const organizationResponse = await app.fetch(
        new Request(`${ORIGIN}/v1/organizations`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${signedInBody.sessionToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: "Production" }),
        }),
      );
      const organizationBody = (await organizationResponse.json()) as {
        organization: { id: string; ownerPrincipalId: string };
      };
      await app.fetch(
        new Request(`${ORIGIN}/v1/session`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${signedInBody.sessionToken}` },
        }),
      );

      const durableBeforeProof = {
        principals: Number((await sql.query("SELECT COUNT(*) AS count FROM principals"))[0]?.count),
        sessions: Number(
          (await sql.query("SELECT COUNT(*) AS count FROM auth_tokens WHERE kind = 'session'"))[0]
            ?.count,
        ),
        apiKeys: Number(
          (await sql.query("SELECT COUNT(*) AS count FROM auth_tokens WHERE kind = 'api_key'"))[0]
            ?.count,
        ),
      };
      const crossHostReplay = await app.fetch(
        new Request("https://api.other-host.test/v1/operator-owner-proof", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: IDENTITY.provider,
            method: "operator-assertion",
            assertion,
            organizationId: organizationBody.organization.id,
          }),
        }),
      );
      expect(crossHostReplay.status).toBe(401);
      const readOnlyProof = await app.fetch(
        new Request(`${ORIGIN}/v1/operator-owner-proof`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: IDENTITY.provider,
            method: "operator-assertion",
            assertion,
            organizationId: organizationBody.organization.id,
          }),
        }),
      );
      expect(readOnlyProof.status).toBe(200);
      expect(Number((await sql.query("SELECT COUNT(*) AS count FROM principals"))[0]?.count)).toBe(
        durableBeforeProof.principals,
      );
      expect(
        Number(
          (await sql.query("SELECT COUNT(*) AS count FROM auth_tokens WHERE kind = 'session'"))[0]
            ?.count,
        ),
      ).toBe(durableBeforeProof.sessions);
      expect(
        Number(
          (await sql.query("SELECT COUNT(*) AS count FROM auth_tokens WHERE kind = 'api_key'"))[0]
            ?.count,
        ),
      ).toBe(durableBeforeProof.apiKeys);

      await expect(
        withOperatorOwnerSession(
          {
            origin: ORIGIN,
            organizationId: organizationBody.organization.id,
            privateInput,
            identity: { ...IDENTITY, subject: "unknown-production-owner" },
            now: () => now,
            phase: "verification",
            fetcher: (input, init) => app.fetch(new Request(input, init)),
          },
          async () => "must-not-run",
        ),
      ).rejects.toMatchObject({ phase: "verification" });
      expect(Number((await sql.query("SELECT COUNT(*) AS count FROM principals"))[0]?.count)).toBe(
        durableBeforeProof.principals,
      );
      expect(
        Number(
          (await sql.query("SELECT COUNT(*) AS count FROM auth_tokens WHERE kind = 'session'"))[0]
            ?.count,
        ),
      ).toBe(durableBeforeProof.sessions);
      expect(
        Number(
          (await sql.query("SELECT COUNT(*) AS count FROM auth_tokens WHERE kind = 'api_key'"))[0]
            ?.count,
        ),
      ).toBe(durableBeforeProof.apiKeys);

      const result = await withOperatorOwnerSession(
        {
          origin: ORIGIN,
          organizationId: organizationBody.organization.id,
          privateInput,
          identity: readOperatorSignInIdentity(fixture.identityPath),
          now: () => now,
          phase: "verification",
          fetcher: (input, init) => app.fetch(new Request(input, init)),
        },
        async () => organizationBody.organization.ownerPrincipalId,
      );
      expect(result.value).toBe(organizationBody.organization.ownerPrincipalId);
      expect(result.proof).toMatchObject({
        organizationId: organizationBody.organization.id,
        organizationRole: "owner",
        revokeStatus: 204,
        replayStatus: 401,
      });
      const proofSessions = await sql.query(
        "SELECT created_at, expires_at, revoked_at FROM auth_tokens WHERE kind = 'session'",
      );
      expect(
        proofSessions.some(
          (row) =>
            Date.parse(String(row.expires_at)) - Date.parse(String(row.created_at)) === 60_000 &&
            row.revoked_at !== null,
        ),
      ).toBe(true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

async function authorityFixture() {
  const root = mkdtempSync(join(tmpdir(), "takoserver-operator-authority-"));
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk = normalizeGeneratedEd25519PrivateJwk(
    await crypto.subtle.exportKey("jwk", pair.privateKey),
  );
  const privateJwkPath = join(root, "operator.jwk");
  writeFileSync(privateJwkPath, JSON.stringify(privateJwk), { mode: 0o600 });
  chmodSync(privateJwkPath, 0o600);
  const identityPath = join(root, "identity.json");
  writeFileSync(identityPath, JSON.stringify(IDENTITY), { mode: 0o600 });
  chmodSync(identityPath, 0o600);
  return {
    root,
    privateJwkPath,
    identityPath,
    publicKey: pair.publicKey,
    publicJwk: { kty: "OKP", crv: "Ed25519", x: String(privateJwk.x) },
  };
}

function principal() {
  return {
    id: "prn_production_owner",
    provider: IDENTITY.provider,
    providerSubject: IDENTITY.subject,
    email: IDENTITY.email,
    displayName: IDENTITY.displayName,
  };
}

function organization(ownerPrincipalId: string) {
  return {
    id: ORGANIZATION,
    name: "Production",
    ownerPrincipalId,
    createdAt: "2026-09-03T11:00:00.000Z",
  };
}
