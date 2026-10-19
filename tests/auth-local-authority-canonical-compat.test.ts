import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createAccounts, createAccountsWithUnregisteredLocalIssuer } from "../src/auth.ts";
import { additiveAuthTokenDDL } from "../src/auth-authority-schema-plan.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { resolveIdentity } from "../src/identity-setup.ts";
import { base64UrlEncode } from "../src/json.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

const audience = "https://local-issuer.example.test";
const opened = new Set<Database>();
afterEach(() => {
  for (const db of opened) db.close();
  opened.clear();
});

async function canonicalFixture() {
  const db = new Database(":memory:");
  opened.add(db);
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  const hasSharedAuthSessions = () =>
    db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='shared_auth_sessions'")
      .all().length > 0;
  expect(hasSharedAuthSessions()).toBe(false);
  db.exec(additiveAuthTokenDDL);
  expect(hasSharedAuthSessions()).toBe(false);
  const sql = createSqliteSql(db);
  const now = Date.now();
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const identity = resolveIdentity({
    operatorPublicKeyJwk: { kty: "OKP", crv: "Ed25519", x: String(publicKey.x) },
    operatorAudience: audience,
    clock: () => new Date(now),
  }).verifier;
  const input = async (subject: string, serial = 0) => {
    const payload = base64UrlEncode(
      new TextEncoder().encode(
        JSON.stringify({
          purpose: "sign-in",
          aud: audience,
          provider: "google",
          subject,
          email: `${subject}@example.test`,
          displayName: subject,
          iat: Math.floor(now / 1000) - serial,
          exp: Math.floor(now / 1000) + 300 - serial,
        }),
      ),
    );
    const signature = await crypto.subtle.sign(
      "Ed25519",
      pair.privateKey,
      new TextEncoder().encode(payload),
    );
    return {
      provider: "google" as const,
      method: "operator-assertion" as const,
      audience,
      assertion: `${payload}.${base64UrlEncode(new Uint8Array(signature))}`,
    };
  };
  const count = async (table: "principals" | "auth_tokens") =>
    Number((await sql.query(`SELECT COUNT(*) AS count FROM ${table}`))[0]?.count);
  return { db, sql, now, identity, input, count, hasSharedAuthSessions };
}

test("canonical migration lineage accepts fresh local issuance and preserves legacy owner references", async () => {
  const f = await canonicalFixture();
  const clock = () => new Date(f.now);
  const legacyAccounts = createAccounts({ sql: f.sql, identity: f.identity, clock });
  const legacyInput = await f.input("legacy-owner");
  const legacy = await legacyAccounts.signIn(legacyInput);
  const organization = await legacyAccounts.createOrganization({
    actor: await legacyAccounts.authenticate(`Bearer ${legacy.sessionToken}`).then((actor) => {
      if (!actor) throw new Error("legacy session did not authenticate");
      return actor;
    }),
    name: "Legacy compatibility organization",
  });
  const beforeOrganization = await f.sql.query(
    "SELECT id, owner_principal_id FROM orgs WHERE id = ?",
    [organization.id],
  );
  expect(beforeOrganization).toEqual([
    {
      id: organization.id,
      owner_principal_id: legacy.principal.id,
    },
  ]);

  const localIssuer = createAccountsWithUnregisteredLocalIssuer({
    sql: f.sql,
    identity: f.identity,
    clock,
  });
  const fresh = await localIssuer.signIn(await f.input("fresh-local"));
  expect(f.hasSharedAuthSessions()).toBe(false);
  expect(fresh.principal.providerSubject).toBe("fresh-local");
  expect(await localIssuer.authenticate(`Bearer ${fresh.sessionToken}`)).toMatchObject({
    principalId: fresh.principal.id,
  });
  expect(await legacyAccounts.authenticate(`Bearer ${legacy.sessionToken}`)).toMatchObject({
    principalId: legacy.principal.id,
  });
  const proofInput = await f.input("legacy-owner", 1);
  await expect(
    legacyAccounts.proveExistingOwner({
      provider: "google",
      assertion: proofInput.assertion,
      organizationId: organization.id,
      audience,
      method: "operator-assertion",
    }),
  ).resolves.toEqual({ principal: legacy.principal, organization });
  expect(
    await f.sql.query("SELECT id, owner_principal_id FROM orgs WHERE id = ?", [organization.id]),
  ).toEqual(beforeOrganization);
  expect(await f.count("principals")).toBe(2);
  expect(await f.count("auth_tokens")).toBe(2);
});

test("local token-only candidate rejects RP backend and class with valid retained origin and binding", async () => {
  const f = await canonicalFixture();
  const accounts = createAccounts({
    sql: f.sql,
    identity: f.identity,
    clock: () => new Date(f.now),
  });
  const legacy = await accounts.signIn(await f.input("rp-bound-owner"));
  const actor = await accounts.authenticate(`Bearer ${legacy.sessionToken}`);
  if (!actor) throw new Error("RP rejection fixture session did not authenticate");
  const organization = await accounts.createOrganization({ actor, name: "RP candidate rejection" });
  await expect(
    accounts.proveExistingOwner({
      provider: "google",
      assertion: (await f.input("rp-bound-owner", 1)).assertion,
      organizationId: organization.id,
      audience,
      method: "operator-assertion",
    }),
  ).resolves.toEqual({ principal: legacy.principal, organization });

  const [principal] = await f.sql.query(
    "SELECT id, provider, provider_subject, created_at FROM principals WHERE id = ?",
    [legacy.principal.id],
  );
  if (!principal) throw new Error("verified owner Principal disappeared");
  const incarnation = `proved-legacy-${crypto.randomUUID()}`;
  const bindingRef = `proved-legacy-binding-${crypto.randomUUID()}`;
  const issuer = "https://accounts.google.com";
  const subject = "rp-bound-owner";
  const targetRef = "auth103:local-token-candidate-rp-negative";
  const at = new Date(f.now).toISOString();
  const digest = (fill: string) => `sha256:${fill.repeat(64)}`;
  await f.sql.run(
    `INSERT INTO auth_principal_incarnations
      (principal_id, principal_incarnation, identity_kind, identity_subject, principal_created_at,
       origin_kind, origin_ref, origin_digest, identity_authority_body, identity_authority_digest, enrolled_at)
     VALUES (?, ?, ?, ?, ?, 'proved-legacy', ?, ?, NULL, NULL, ?)`,
    [
      String(principal.id),
      incarnation,
      String(principal.provider),
      String(principal.provider_subject),
      String(principal.created_at),
      `verified-owner:${organization.id}`,
      digest("a"),
      at,
    ],
  );
  await f.sql.run(
    `INSERT INTO shared_principal_bindings
      (binding_ref, issuer, subject, controller_incarnation, principal_id, principal_incarnation,
       target_ref, binding_kind, evidence_ref, evidence_digest, enrolled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'proved-legacy', ?, ?, ?)`,
    [
      bindingRef,
      issuer,
      subject,
      `controller-${crypto.randomUUID()}`,
      String(principal.id),
      incarnation,
      targetRef,
      `verified-owner:${organization.id}`,
      digest("b"),
      at,
    ],
  );

  const insertClass = (values: readonly (string | number | null)[]) =>
    f.sql.run(
      `INSERT INTO credential_authority_classes
        (authority_ref, credential_incarnation, class, backend, target_ref, organization_id,
         principal_id, principal_incarnation, principal_binding_ref, issuance_ref, issuance_digest,
         issued_at, token_id, token_digest, token_kind, token_scopes_json, token_created_at,
         rp_registration_ref, rp_registration_digest, session_digest, session_created_at,
         session_enrolled_version, issuer, client_id, subject, issuer_session_id, auth_time,
         account_id, workspace_id, workspace_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values,
    );
  const expectLocalRpRejection = (values: readonly (string | number | null)[]) =>
    expect(insertClass(values)).rejects.toMatchObject({
      code: "constraint",
      message: "Local Auth token candidate rejects RP backend or class",
    });
  const common = [
    targetRef,
    organization.id,
    String(principal.id),
    incarnation,
    bindingRef,
    `rp-issuance-${crypto.randomUUID()}`,
    digest("c"),
    at,
  ] as const;
  const rpFields = [
    `rp-registration-${crypto.randomUUID()}`,
    digest("d"),
    digest("e"),
    f.now,
    1,
    issuer,
    "rp-client",
    subject,
    `rp-session-${crypto.randomUUID()}`,
    Math.floor(f.now / 1000),
    "rp-bound-owner",
    "rp-workspace",
    "rp-workspace-ref",
  ] as const;
  const classCountBefore = Number(
    (await f.sql.query("SELECT COUNT(*) AS count FROM credential_authority_classes"))[0]?.count,
  );
  await expectLocalRpRejection([
    `rp-authority-${crypto.randomUUID()}`,
    `rp-credential-${crypto.randomUUID()}`,
    "official-shared-rp-session",
    "shared-rp-session",
    ...common,
    null,
    null,
    null,
    null,
    null,
    ...rpFields,
  ]);

  const localAccounts = createAccountsWithUnregisteredLocalIssuer({
    sql: f.sql,
    identity: f.identity,
    clock: () => new Date(f.now),
  });
  const fresh = await localAccounts.signIn(await f.input("rp-backend-only"));
  const [freshAnchor] = await f.sql.query(
    "SELECT principal_incarnation FROM auth_principal_incarnations WHERE principal_id = ?",
    [fresh.principal.id],
  );
  if (!freshAnchor) throw new Error("fresh local issuer anchor disappeared");
  await expectLocalRpRejection([
    `rp-backend-authority-${crypto.randomUUID()}`,
    `rp-backend-credential-${crypto.randomUUID()}`,
    "direct-owner-session",
    "shared-rp-session",
    ...common.slice(0, 2),
    fresh.principal.id,
    String(freshAnchor.principal_incarnation),
    null,
    `rp-backend-issuance-${crypto.randomUUID()}`,
    digest("f"),
    at,
    null,
    null,
    null,
    null,
    null,
    ...rpFields,
  ]);

  const [legacyToken] = await f.sql.query(
    `SELECT id, secret_digest, kind, scopes_json, created_at FROM auth_tokens
     WHERE principal_id = ? AND kind = 'session' AND revoked_at IS NULL`,
    [legacy.principal.id],
  );
  if (!legacyToken) throw new Error("proved legacy session token disappeared");
  await expectLocalRpRejection([
    `rp-class-authority-${crypto.randomUUID()}`,
    `rp-class-credential-${crypto.randomUUID()}`,
    "official-shared-rp-session",
    "auth-token",
    targetRef,
    null,
    String(principal.id),
    incarnation,
    bindingRef,
    `rp-class-issuance-${crypto.randomUUID()}`,
    digest("1"),
    at,
    String(legacyToken.id),
    String(legacyToken.secret_digest),
    String(legacyToken.kind),
    String(legacyToken.scopes_json),
    String(legacyToken.created_at),
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ]);
  expect(f.hasSharedAuthSessions()).toBe(false);
  expect(
    Number(
      (await f.sql.query("SELECT COUNT(*) AS count FROM credential_authority_classes"))[0]?.count,
    ),
  ).toBe(classCountBefore + 1);
});

test("canonical legacy NOT NULL failure rolls back an earlier organization-name update", async () => {
  const f = await canonicalFixture();
  const accounts = createAccounts({
    sql: f.sql,
    identity: f.identity,
    clock: () => new Date(f.now),
  });
  const input = await f.input("rollback-owner");
  const signedIn = await accounts.signIn(input);
  const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
  if (!actor) throw new Error("rollback fixture session did not authenticate");
  const organization = await accounts.createOrganization({
    actor,
    name: "Original organization name",
  });
  const tokenCountBefore = await f.count("auth_tokens");
  const createdAt = new Date(f.now).toISOString();
  const expiresAt = new Date(f.now + 60_000).toISOString();
  const digestBytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("canonical-null-principal-compatibility-token"),
    ),
  );
  const secretDigest = `sha256:${Array.from(digestBytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;

  await expect(
    f.sql.batch([
      {
        sql: "UPDATE orgs SET name = ? WHERE id = ?",
        params: ["Name changed inside transaction", organization.id],
      },
      {
        sql: `INSERT INTO auth_tokens
        (secret_digest, id, kind, principal_id, org_id, name, scopes_json, created_at, expires_at)
        VALUES (?, ?, 'session', NULL, NULL, 'session', '[]', ?, ?)`,
        params: [secretDigest, `ses_${crypto.randomUUID()}`, createdAt, expiresAt],
      },
    ]),
  ).rejects.toMatchObject({
    code: "constraint",
    message: "NOT NULL constraint failed: auth_tokens.principal_id",
  });

  expect(await f.sql.query("SELECT name FROM orgs WHERE id = ?", [organization.id])).toEqual([
    { name: "Original organization name" },
  ]);
  expect(await f.count("auth_tokens")).toBe(tokenCountBefore);
});
