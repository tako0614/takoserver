import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AuthError, createAccountsWithUnregisteredLocalIssuer } from "../src/auth.ts";
import { additiveAuthTokenDDL } from "../src/auth-authority-schema-plan.ts";
import { resolveIdentity } from "../src/identity-setup.ts";
import { base64UrlEncode } from "../src/json.ts";
import type { Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

// Candidate-only fixture. This does not qualify an installed Auth0103 target.
const base = readFileSync(
  new URL("./fixtures/auth-authority-candidate-schema.sql", import.meta.url),
  "utf8",
);
const audience = "https://local-issuer.example.test";
const opened = new Set<Database>();
afterEach(() => {
  for (const db of opened) db.close();
  opened.clear();
});

async function fixture() {
  const db = new Database(":memory:");
  opened.add(db);
  db.exec(base);
  db.exec("DROP TABLE IF EXISTS shared_auth_sessions");
  expect(
    db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='shared_auth_sessions'")
      .all(),
  ).toEqual([]);
  db.exec(additiveAuthTokenDDL);
  expect(
    db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='shared_auth_sessions'")
      .all(),
  ).toEqual([]);
  db.exec(`CREATE TABLE runtime_grant_replays (
    grant_id TEXT PRIMARY KEY NOT NULL,
    expires_at_epoch_seconds INTEGER NOT NULL,
    consumed_at_epoch_seconds INTEGER NOT NULL
  )`);
  const sql = createSqliteSql(db);
  const now = Date.now();
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const identity = resolveIdentity({
    operatorPublicKeyJwk: { kty: "OKP", crv: "Ed25519", x: String(publicKey.x) },
    operatorAudience: audience,
    clock: () => new Date(now),
  }).verifier;
  const input = async (subject = "person", serial = 0, selectedAudience = audience) => {
    const payload = base64UrlEncode(
      new TextEncoder().encode(
        JSON.stringify({
          purpose: "sign-in",
          aud: selectedAudience,
          provider: "google",
          subject,
          email: `${subject}@example.test`,
          displayName: subject,
          iat: Math.floor(now / 1000) - serial,
          exp: Math.floor(now / 1000) + 300,
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
      audience: selectedAudience,
      assertion: `${payload}.${base64UrlEncode(new Uint8Array(signature))}`,
    };
  };
  const count = async (
    table:
      | "principals"
      | "auth_principal_incarnations"
      | "auth_tokens"
      | "credential_authority_classes",
  ) => Number((await sql.query(`SELECT COUNT(*) AS count FROM ${table}`))[0]?.count);
  return { db, sql, now, identity, keyX: String(publicKey.x), input, count };
}

function candidate(
  f: Awaited<ReturnType<typeof fixture>>,
  sql: Sql = f.sql,
  randomId?: () => string,
) {
  return createAccountsWithUnregisteredLocalIssuer({
    sql,
    identity: f.identity,
    clock: () => new Date(f.now),
    ...(randomId ? { randomId } : {}),
  });
}

test("real verifier capture issues fresh local Principal, token, and class in one batch", async () => {
  const f = await fixture();
  let batches = 0;
  let issued: readonly string[] = [];
  const counted: Sql = {
    query: (sql, params) => f.sql.query(sql, params),
    run: (sql, params) => f.sql.run(sql, params),
    batch: (statements) => {
      batches++;
      issued = statements.map((statement) => statement.sql);
      return f.sql.batch(statements);
    },
  };
  const accounts = candidate(f, counted);
  const signedIn = await accounts.signIn(await f.input());
  expect(batches).toBe(1);
  expect(issued[0]).toContain("INSERT INTO principals");
  expect(issued[1]).toContain("INSERT INTO auth_principal_incarnations");
  expect(issued[2]).toContain("INSERT INTO auth_tokens");
  expect(issued[3]).toContain("INSERT INTO credential_authority_classes");
  expect(issued).toHaveLength(4);
  const rows = await f.sql.query(`SELECT p.id, p.provider_subject,
    i.origin_kind, i.identity_authority_body, i.identity_authority_digest,
    i.origin_digest, c.class, c.backend, c.organization_id, c.target_ref,
    c.token_id, c.token_digest, t.secret_digest, t.scopes_json
    FROM principals p
    JOIN auth_principal_incarnations i ON i.principal_id=p.id
    JOIN credential_authority_classes c ON c.principal_id=p.id
    JOIN auth_tokens t ON t.id=c.token_id`);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: signedIn.principal.id,
    provider_subject: "person",
    origin_kind: "fresh-local",
    class: "direct-owner-session",
    backend: "auth-token",
    organization_id: null,
    target_ref: "auth103:unregistered-local-candidate",
    scopes_json: "[]",
  });
  expect(rows[0]?.token_digest).toBe(rows[0]?.secret_digest);
  expect(rows[0]?.identity_authority_body).toBe(
    JSON.stringify([
      "takoserver.identity-verification-domain.v1",
      "google",
      "operator-assertion",
      audience,
      "OKP",
      "Ed25519",
      f.keyX,
    ]),
  );
  expect(rows[0]?.origin_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(await accounts.authenticate(`Bearer ${signedIn.sessionToken}`)).toMatchObject({
    principalId: signedIn.principal.id,
  });
  const capture = await accounts.captureAuthenticatedToken(`Bearer ${signedIn.sessionToken}`);
  expect(capture).not.toBeNull();
  expect(accounts.inspectAuthenticatedTokenCapture(capture)).toMatchObject({
    tokenId: rows[0]?.token_id,
    digest: rows[0]?.token_digest,
    kind: "session",
    organizationId: null,
    scopesJson: "[]",
  });
  await expect(accounts.signIn(await f.input())).rejects.toMatchObject({
    code: "unauthenticated",
  });
  expect(await f.count("auth_tokens")).toBe(1);
});

test("clones, method replacement and accessors cannot opt into local issuance", async () => {
  const f = await fixture();
  expect(() =>
    createAccountsWithUnregisteredLocalIssuer({
      sql: f.sql,
      identity: { ...f.identity },
    }),
  ).toThrow(AuthError);
  const originalVerify = f.identity.verify;
  let getterCalls = 0;
  Object.defineProperty(f.identity, "verify", {
    configurable: true,
    get() {
      getterCalls++;
      return originalVerify;
    },
  });
  expect(() => candidate(f)).toThrow(AuthError);
  expect(getterCalls).toBe(0);
  Object.defineProperty(f.identity, "verify", { configurable: true, value: originalVerify });
  const originalCapture = f.identity.captureVerifiedIdentity;
  Object.defineProperty(f.identity, "captureVerifiedIdentity", {
    configurable: true,
    value: async () => {
      throw new Error("replacement");
    },
  });
  expect(() => candidate(f)).toThrow(AuthError);
  Object.defineProperty(f.identity, "captureVerifiedIdentity", {
    configurable: true,
    value: originalCapture,
  });
  const other = await fixture();
  const foreign = await other.identity.captureVerifiedIdentity(await other.input());
  expect(f.identity.inspectVerifiedIdentityCapture(foreign.capture)).toBeNull();
  expect(other.identity.inspectVerifiedIdentityCapture({ ...foreign.capture })).toBeNull();
  expect(await f.count("principals")).toBe(0);
});

test("zero-row token causes mandatory class failure and rolls back Principal and anchor", async () => {
  const f = await fixture();
  const zeroToken: Sql = {
    query: (sql, params) => f.sql.query(sql, params),
    run: (sql, params) => f.sql.run(sql, params),
    batch: (statements) =>
      f.sql.batch(
        statements.map((statement) =>
          statement.sql.includes("INSERT INTO auth_tokens")
            ? { sql: "INSERT INTO auth_tokens (secret_digest) SELECT 'never' WHERE 0" }
            : statement,
        ),
      ),
  };
  await expect(candidate(f, zeroToken).signIn(await f.input())).rejects.toBeDefined();
  expect(await f.count("principals")).toBe(0);
  expect(await f.count("auth_principal_incarnations")).toBe(0);
  expect(await f.count("auth_tokens")).toBe(0);
  expect(await f.count("credential_authority_classes")).toBe(0);
});

test("only an existing unanchored Principal follows legacy; any anchor blocks reissue", async () => {
  const f = await fixture();
  await f.sql.run(
    `INSERT INTO principals
    (id,provider,provider_subject,email,display_name,created_at)
    VALUES ('prn_legacy','google','legacy','legacy@example.test','legacy',?)`,
    [new Date(f.now).toISOString()],
  );
  const accounts = candidate(f);
  const legacy = await accounts.signIn(await f.input("legacy"));
  expect(legacy.principal.id).toBe("prn_legacy");
  expect(await f.count("auth_principal_incarnations")).toBe(0);
  expect(await f.count("credential_authority_classes")).toBe(0);
  const fresh = await accounts.signIn(await f.input("fresh"));
  await expect(accounts.signIn(await f.input("fresh", 1))).rejects.toMatchObject({
    code: "permission_denied",
  });
  expect(await f.count("auth_tokens")).toBe(2);
  await f.sql.run(
    `UPDATE auth_principal_incarnations
    SET state='retired', terminal_reason='test', terminal_at=?, terminal_ref='test-retired'
    WHERE principal_id=?`,
    [new Date(f.now).toISOString(), fresh.principal.id],
  );
  await expect(accounts.signIn(await f.input("fresh", 2))).rejects.toMatchObject({
    code: "permission_denied",
  });
  expect(await f.count("auth_tokens")).toBe(2);
});

test("class identity collision rolls back only the losing fresh issuance", async () => {
  const f = await fixture();
  const firstIds = ["first", "firstinc", "firstorigin", "firsttoken", "collision", "firstcred"];
  const first = candidate(f, f.sql, () => firstIds.shift() ?? "unexpected");
  await first.signIn(await f.input("first"));
  const secondIds = [
    "second",
    "secondinc",
    "secondorigin",
    "secondtoken",
    "collision",
    "secondcred",
  ];
  const second = candidate(f, f.sql, () => secondIds.shift() ?? "unexpected");
  await expect(second.signIn(await f.input("second"))).rejects.toBeDefined();
  expect(await f.count("principals")).toBe(1);
  expect(await f.count("auth_principal_incarnations")).toBe(1);
  expect(await f.count("auth_tokens")).toBe(1);
  expect(await f.count("credential_authority_classes")).toBe(1);
});

test("changed genuine verifier domain cannot reissue an unclassified anchored session", async () => {
  const f = await fixture();
  const accounts = candidate(f);
  await accounts.signIn(await f.input("person"));
  const newAudience = "https://another-local-issuer.example.test";
  const differentDomain = resolveIdentity({
    operatorPublicKeyJwk: { kty: "OKP", crv: "Ed25519", x: f.keyX },
    operatorAudience: newAudience,
    clock: () => new Date(f.now),
  }).verifier;
  const changed = createAccountsWithUnregisteredLocalIssuer({
    sql: f.sql,
    identity: differentDomain,
    clock: () => new Date(f.now),
  });
  await expect(changed.signIn(await f.input("person", 1, newAudience))).rejects.toMatchObject({
    code: "permission_denied",
  });
  expect(await f.count("auth_tokens")).toBe(1);
  expect(await f.count("credential_authority_classes")).toBe(1);
});

test("unknown batch acknowledgement never triggers a second issuance", async () => {
  const f = await fixture();
  let batches = 0;
  const unavailable: Sql = {
    query: (sql, params) => f.sql.query(sql, params),
    run: (sql, params) => f.sql.run(sql, params),
    async batch(statements) {
      batches++;
      await f.sql.batch(statements);
      throw new Error("acknowledgement unavailable after commit");
    },
  };
  await expect(candidate(f, unavailable).signIn(await f.input())).rejects.toThrow(
    "acknowledgement unavailable after commit",
  );
  expect(batches).toBe(1);
  expect(await f.count("principals")).toBe(1);
  expect(await f.count("auth_principal_incarnations")).toBe(1);
  expect(await f.count("auth_tokens")).toBe(1);
  expect(await f.count("credential_authority_classes")).toBe(1);
});

test("enrollment racing the legacy read blocks the final unclassified token", async () => {
  const f = await fixture();
  const createdAt = new Date(f.now).toISOString();
  await f.sql.run(
    `INSERT INTO principals
    (id,provider,provider_subject,email,display_name,created_at)
    VALUES ('prn_legacy','google','legacy','legacy@example.test','legacy',?)`,
    [createdAt],
  );
  const observed = await f.identity.captureVerifiedIdentity(await f.input("legacy"));
  const verification = f.identity.inspectVerifiedIdentityCapture(observed.capture);
  if (!verification) throw new Error("genuine capture unavailable");
  let inserted = false;
  const raced: Sql = {
    async query(sql, params) {
      const result = await f.sql.query(sql, params);
      if (
        sql.includes("SELECT principal_incarnation FROM auth_principal_incarnations") &&
        !inserted
      ) {
        inserted = true;
        await f.sql.run(
          `INSERT INTO auth_principal_incarnations
          (principal_id,principal_incarnation,identity_kind,identity_subject,principal_created_at,
           origin_kind,origin_ref,origin_digest,identity_authority_body,
           identity_authority_digest,enrolled_at)
          VALUES ('prn_legacy','race-inc','google','legacy',?,'fresh-local',?,?,?,?,?)`,
          [
            createdAt,
            "race-capture",
            verification.assertionDigest,
            JSON.stringify(verification.verificationDomain.body),
            verification.verificationDomain.digest,
            createdAt,
          ],
        );
      }
      return result;
    },
    run: (sql, params) => f.sql.run(sql, params),
    batch: (statements) => f.sql.batch(statements),
  };
  await expect(candidate(f, raced).signIn(await f.input("legacy", 1))).rejects.toBeDefined();
  expect(inserted).toBe(true);
  expect(await f.count("auth_tokens")).toBe(0);
  expect(await f.count("auth_principal_incarnations")).toBe(1);
});

test("Takos ID projection rolls back when legacy enrollment races token insertion", async () => {
  const f = await fixture();
  const issuer = "https://id.local-issuer.example.test";
  const clientId = "local-issuer-client";
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (request: RequestInfo | URL) => {
      const url = new Request(request).url;
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json` });
      }
      if (url === `${issuer}/.well-known/jwks.json`) {
        return Response.json({ keys: [{ ...jwk, kid: "selected-key", alg: "ES256", use: "sig" }] });
      }
      throw new Error(`unexpected discovery ${url}`);
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const identity = resolveIdentity({
      takosId: { issuer, clientId },
      clock: () => new Date(f.now),
    }).verifier;
    const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encoded({ alg: "ES256", kid: "selected-key" })}.${encoded({
      iss: issuer,
      aud: clientId,
      sub: "pairwise-legacy",
      email: "owner@example.test",
      email_verified: true,
      iat: Math.floor(f.now / 1000),
      exp: Math.floor(f.now / 1000) + 300,
      organizations: [{ id: "org_legal", name: "Legal Ltd.", role: "owner" }],
    })}`;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      new TextEncoder().encode(unsigned),
    );
    const assertion = `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
    const captured = await identity.captureVerifiedIdentity({
      provider: "takos-id",
      method: "oidc",
      assertion,
    });
    const observed = identity.inspectVerifiedIdentityCapture(captured.capture);
    if (!observed) throw new Error("genuine Takos ID capture unavailable");
    const createdAt = new Date(f.now).toISOString();
    await f.sql.run(
      `INSERT INTO principals
      (id,provider,provider_subject,email,display_name,created_at)
      VALUES ('prn_takos_legacy','takos-id','pairwise-legacy','owner@example.test',
        'owner@example.test',?)`,
      [createdAt],
    );
    let raced = false;
    const sql: Sql = {
      async query(text, params) {
        const rows = await f.sql.query(text, params);
        if (
          text.includes("SELECT principal_incarnation FROM auth_principal_incarnations") &&
          !raced
        ) {
          raced = true;
          await f.sql.run(
            `INSERT INTO auth_principal_incarnations
            (principal_id,principal_incarnation,identity_kind,identity_subject,
             principal_created_at,origin_kind,origin_ref,origin_digest,
             identity_authority_body,identity_authority_digest,enrolled_at)
            VALUES ('prn_takos_legacy','race-inc','takos-id','pairwise-legacy',
              ?,'fresh-local',?,?,?,?,?)`,
            [
              createdAt,
              "genuine-race-capture",
              observed.assertionDigest,
              JSON.stringify(observed.verificationDomain.body),
              observed.verificationDomain.digest,
              createdAt,
            ],
          );
        }
        return rows;
      },
      run: (text, params) => f.sql.run(text, params),
      batch: (statements) => f.sql.batch(statements),
    };
    const accounts = createAccountsWithUnregisteredLocalIssuer({
      sql,
      identity,
      clock: () => new Date(f.now),
    });
    await expect(
      accounts.signIn({
        provider: "takos-id",
        method: "oidc",
        assertion,
      }),
    ).rejects.toBeDefined();
    expect(raced).toBe(true);
    expect(await f.count("auth_tokens")).toBe(0);
    expect(await f.sql.query("SELECT * FROM orgs")).toEqual([]);
    expect(await f.sql.query("SELECT * FROM org_memberships")).toEqual([]);
    expect(await f.count("auth_principal_incarnations")).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("identity accessor alternation is rejected before its getter or fake callbacks run", async () => {
  const f = await fixture();
  let getterCalls = 0;
  let fakeCalls = 0;
  const fake = {
    async verify() {
      fakeCalls++;
      return { providerSubject: "forged", email: "forged@example.test", displayName: "forged" };
    },
    async captureVerifiedIdentity() {
      fakeCalls++;
      return { verified: await fake.verify(), capture: {} };
    },
    inspectVerifiedIdentityCapture() {
      fakeCalls++;
      return null;
    },
  };
  const alternating = {
    sql: f.sql,
    get identity() {
      getterCalls++;
      return getterCalls === 1 ? f.identity : fake;
    },
  } as unknown as Parameters<typeof createAccountsWithUnregisteredLocalIssuer>[0];
  expect(() => createAccountsWithUnregisteredLocalIssuer(alternating)).toThrow(AuthError);
  expect(getterCalls).toBe(0);
  expect(fakeCalls).toBe(0);
  expect(await f.count("principals")).toBe(0);
  expect(await f.count("auth_tokens")).toBe(0);
  expect(await f.count("credential_authority_classes")).toBe(0);
});

test("alternating identity accessor cannot forge a full local sign-in from an unsigned assertion", async () => {
  const f = await fixture();
  // Obtain only the genuine canonical verifier domain. The forged identity
  // below has never been verified; V1 could reuse this domain as decoration.
  const genuine = await f.identity.captureVerifiedIdentity(await f.input("genuine"));
  const original = f.identity.inspectVerifiedIdentityCapture(genuine.capture);
  if (!original) throw new Error("genuine domain observation unavailable");
  const forged = Object.freeze({
    ...original,
    providerSubject: "forged-subject",
    email: "forged@example.test",
    displayName: "Forged",
  });
  let getterCalls = 0;
  let fakeCalls = 0;
  const fake = {
    async verify() {
      fakeCalls++;
      throw new Error("fake verify must not run");
    },
    async captureVerifiedIdentity() {
      fakeCalls++;
      return {
        verified: {
          providerSubject: forged.providerSubject,
          email: forged.email,
          displayName: forged.displayName,
        },
        capture: Object.freeze({}),
      };
    },
    inspectVerifiedIdentityCapture() {
      fakeCalls++;
      return forged;
    },
  };
  const alternating = {
    sql: f.sql,
    clock: () => new Date(f.now),
    get identity() {
      getterCalls++;
      return getterCalls <= 2 ? f.identity : fake;
    },
  } as unknown as Parameters<typeof createAccountsWithUnregisteredLocalIssuer>[0];
  await expect(
    (async () => {
      const accounts = createAccountsWithUnregisteredLocalIssuer(alternating);
      return await accounts.signIn({
        provider: "google",
        method: "operator-assertion",
        audience,
        assertion: "unsigned-and-invalid",
      });
    })(),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(getterCalls).toBe(0);
  expect(fakeCalls).toBe(0);
  expect(await f.count("principals")).toBe(0);
  expect(await f.count("auth_principal_incarnations")).toBe(0);
  expect(await f.count("auth_tokens")).toBe(0);
  expect(await f.count("credential_authority_classes")).toBe(0);
});

test("method replacement after construction or during a storage await fails closed", async () => {
  const before = await fixture();
  const accounts = candidate(before);
  const originalCapture = before.identity.captureVerifiedIdentity;
  let fakeCalls = 0;
  Object.defineProperty(before.identity, "captureVerifiedIdentity", {
    configurable: true,
    value: async () => {
      fakeCalls++;
      return { verified: { providerSubject: "forged" }, capture: {} };
    },
  });
  await expect(accounts.signIn(await before.input())).rejects.toMatchObject({ code: "invalid" });
  expect(fakeCalls).toBe(0);
  expect(await before.count("principals")).toBe(0);
  expect(await before.count("auth_tokens")).toBe(0);
  Object.defineProperty(before.identity, "captureVerifiedIdentity", {
    configurable: true,
    value: originalCapture,
  });

  const during = await fixture();
  const originalVerify = during.identity.verify;
  let replaced = false;
  const sql: Sql = {
    query: (text, params) => during.sql.query(text, params),
    async run(text, params) {
      const result = await during.sql.run(text, params);
      if (text.includes("INSERT INTO runtime_grant_replays")) {
        replaced = true;
        Object.defineProperty(during.identity, "verify", {
          configurable: true,
          value: async () => {
            fakeCalls++;
            return {
              providerSubject: "forged",
              email: "forged@example.test",
              displayName: "forged",
            };
          },
        });
      }
      return result;
    },
    batch: (statements) => during.sql.batch(statements),
  };
  const inFlight = candidate(during, sql);
  await expect(inFlight.signIn(await during.input())).rejects.toMatchObject({ code: "invalid" });
  expect(replaced).toBe(true);
  expect(fakeCalls).toBe(0);
  expect(await during.count("principals")).toBe(0);
  expect(await during.count("auth_tokens")).toBe(0);
  expect(await during.count("credential_authority_classes")).toBe(0);
  Object.defineProperty(during.identity, "verify", { configurable: true, value: originalVerify });
});
