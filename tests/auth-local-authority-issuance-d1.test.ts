import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { createAccountsWithUnregisteredLocalIssuer } from "../src/auth.ts";
import { additiveAuthTokenDDL } from "../src/auth-authority-schema-plan.ts";
import { resolveIdentity } from "../src/identity-setup.ts";
import { base64UrlEncode } from "../src/json.ts";
import type { Sql } from "../src/ports.ts";
import { createD1Sql, type D1DatabaseLike } from "../src/sql-d1.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";

// TEST-ONLY candidate schema. These tests qualify neither a registered Auth0103
// migration nor a production driver, Financial consumer port, or shared graph.
const base = readFileSync(
  new URL("./fixtures/auth-authority-candidate-schema.sql", import.meta.url),
  "utf8",
);
const audience = "https://local-issuer-native.example.test";
const tables = [
  "principals",
  "auth_principal_incarnations",
  "auth_tokens",
  "credential_authority_classes",
] as const;

async function fixture() {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "integration-auth-local-issuer-d1-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { AUTH_DB: { type: "d1", id: "integration-auth-local-issuer-test" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("AUTH_DB");
    const primary = database.withSession("first-primary") as unknown as D1DatabaseLike;
    const sql = createD1Sql(primary, { acknowledgement: "explicit-d1-result" });
    // Frame only these owning test literals. No canonical schema body is read
    // or copied, and no actual migration registry or target is changed.
    for (const statement of frameHostMigrationSql(base)) await sql.run(statement);
    await sql.run("DROP TABLE IF EXISTS shared_auth_sessions");
    const hasSharedAuthSessions = async () =>
      (
        await sql.query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='shared_auth_sessions'",
        )
      ).length > 0;
    if (await hasSharedAuthSessions()) throw new Error("RP fixture table was not removed");
    for (const source of [
      additiveAuthTokenDDL,
      `CREATE TABLE runtime_grant_replays (
        grant_id TEXT PRIMARY KEY NOT NULL,
        expires_at_epoch_seconds INTEGER NOT NULL,
        consumed_at_epoch_seconds INTEGER NOT NULL
      )`,
    ]) {
      for (const statement of frameHostMigrationSql(source)) await sql.run(statement);
    }
    if (await hasSharedAuthSessions())
      throw new Error("Local token candidate added RP payload storage");
    const now = Date.now();
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const identity = resolveIdentity({
      operatorPublicKeyJwk: { kty: "OKP", crv: "Ed25519", x: String(publicKey.x) },
      operatorAudience: audience,
      clock: () => new Date(now),
    }).verifier;
    const input = async (subject: string) => {
      const payload = base64UrlEncode(
        new TextEncoder().encode(
          JSON.stringify({
            purpose: "sign-in",
            aud: audience,
            provider: "google",
            subject,
            email: `${subject}@example.test`,
            displayName: subject,
            iat: Math.floor(now / 1000),
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
        audience,
        assertion: `${payload}.${base64UrlEncode(new Uint8Array(signature))}`,
      };
    };
    const counts = async () => {
      const result: number[] = [];
      for (const table of tables) {
        result.push(Number((await sql.query(`SELECT COUNT(*) AS count FROM ${table}`))[0]?.count));
      }
      return result;
    };
    const accounts = (selected: Sql = sql) =>
      createAccountsWithUnregisteredLocalIssuer({
        sql: selected,
        identity,
        clock: () => new Date(now),
      });
    return { runtime, primary, sql, input, counts, accounts, hasSharedAuthSessions };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

test("native D1 persists a fresh local Principal, anchor, session and mandatory class", async () => {
  const f = await fixture();
  try {
    const accounts = f.accounts();
    const signedIn = await accounts.signIn(await f.input("native-person"));
    expect(await f.hasSharedAuthSessions()).toBe(false);
    expect(await f.counts()).toEqual([1, 1, 1, 1]);
    const rows = await f.sql.query(
      `SELECT p.id, p.provider_subject, i.origin_kind, c.class, c.backend,
        c.organization_id, c.target_ref, c.token_id, c.token_digest, t.secret_digest
       FROM principals p
       JOIN auth_principal_incarnations i ON i.principal_id = p.id
       JOIN credential_authority_classes c ON c.principal_id = p.id
       JOIN auth_tokens t ON t.id = c.token_id`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: signedIn.principal.id,
      provider_subject: "native-person",
      origin_kind: "fresh-local",
      class: "direct-owner-session",
      backend: "auth-token",
      organization_id: null,
      target_ref: "auth103:unregistered-local-candidate",
    });
    expect(rows[0]?.token_digest).toBe(rows[0]?.secret_digest);
    expect(await accounts.authenticate(`Bearer ${signedIn.sessionToken}`)).toMatchObject({
      principalId: signedIn.principal.id,
    });
    const captured = await accounts.captureAuthenticatedToken(`Bearer ${signedIn.sessionToken}`);
    expect(accounts.inspectAuthenticatedTokenCapture(captured)).toMatchObject({
      tokenId: rows[0]?.token_id,
      digest: rows[0]?.token_digest,
      kind: "session",
      organizationId: null,
    });
  } finally {
    await f.runtime.dispose();
  }
}, 30_000);

test("native D1 mandatory class guard rolls back fresh issuance when the token disappears", async () => {
  const f = await fixture();
  try {
    // A test-only native trigger removes the inserted token before the final
    // class guard. The actual issuer SQL and its real D1 batch are untouched.
    await f.sql.run(`CREATE TRIGGER test_remove_new_session AFTER INSERT ON auth_tokens
      BEGIN DELETE FROM auth_tokens WHERE id = NEW.id; END`);
    // The source class BEFORE INSERT fence rejects the missing live token before
    // the column NOT NULL check; the batch must still roll back all four rows.
    await expect(f.accounts().signIn(await f.input("native-rollback"))).rejects.toMatchObject({
      code: "constraint",
      message: expect.stringContaining("Actual live credential and retained class origin required"),
    });
    expect(await f.counts()).toEqual([0, 0, 0, 0]);
    // Identity replay consumption precedes issuance. A failed issuance must not
    // undo that earlier, separate consume or silently reuse its assertion.
    expect(await f.sql.query("SELECT COUNT(*) AS count FROM runtime_grant_replays")).toEqual([
      { count: 1 },
    ]);
  } finally {
    await f.runtime.dispose();
  }
}, 30_000);

test("native D1 commit with synthetic lost ACK returns no bearer and never resends issuance", async () => {
  const f = await fixture();
  try {
    let batches = 0;
    // Explicitly synthetic transport loss after real native D1 commit. This is
    // a regression of the issuer's unknown handling, not a production driver.
    const lostAck: D1DatabaseLike = {
      prepare: (statement) => f.primary.prepare(statement),
      async batch(statements) {
        batches++;
        await f.primary.batch(statements);
        throw new Error("synthetic local issuer native acknowledgement lost");
      },
    };
    const sql = createD1Sql(lostAck, { acknowledgement: "explicit-d1-result" });
    await expect(f.accounts(sql).signIn(await f.input("native-unknown"))).rejects.toThrow(
      "synthetic local issuer native acknowledgement lost",
    );
    expect(batches).toBe(1);
    expect(await f.counts()).toEqual([1, 1, 1, 1]);
  } finally {
    await f.runtime.dispose();
  }
}, 30_000);
