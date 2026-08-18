import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  createTokenService,
  type SigningKey,
  TokenError,
  type TokenService,
} from "../src/token.ts";

const ISSUER = "https://api.takoserver.test";
const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);

let sql: Sql;
let now: number;
const clock = () => new Date(now);

async function provisionKey(keyId: string): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  await sql.run(
    "INSERT INTO runtime_grant_keys (key_id, public_jwk, created_at_epoch_seconds) VALUES (?, ?, ?)",
    [keyId, JSON.stringify({ kty: "OKP", crv: "Ed25519", x: jwk.x }), 0],
  );
  return { keyId, privateKey: pair.privateKey };
}

function service(signingKey?: SigningKey, keyCacheSeconds = 0): TokenService {
  return createTokenService({
    sql,
    issuer: ISSUER,
    clock,
    keyCacheSeconds,
    ...(signingKey ? { signingKey } : {}),
  });
}

beforeEach(() => {
  now = NOW;
  const database = new Database(":memory:");
  sql = createSqliteSql(database);
  database.exec(`
    CREATE TABLE runtime_grant_keys (
      key_id TEXT PRIMARY KEY NOT NULL,
      public_jwk TEXT NOT NULL,
      created_at_epoch_seconds INTEGER NOT NULL,
      revoked_at_epoch_seconds INTEGER
    );
    CREATE TABLE runtime_grant_replays (
      grant_id TEXT PRIMARY KEY NOT NULL,
      expires_at_epoch_seconds INTEGER NOT NULL,
      consumed_at_epoch_seconds INTEGER NOT NULL
    );
  `);
});

describe("provision tokens", () => {
  test("redeem exactly once", async () => {
    const tokens = service(await provisionKey("sign-2026-08"));
    const { token } = await tokens.issueProvisionToken({
      organizationId: "org_alpha",
      tenantRef: "tenant_x",
      reservationId: "rsv_1",
      offeringId: "storage.object.standard",
      offeringDigest: `sha256:${"c".repeat(64)}`,
      ttlSeconds: 120,
    });

    const claims = await tokens.consumeProvisionToken(token);
    expect(claims.reservationId).toBe("rsv_1");
    expect(claims.tenantRef).toBe("tenant_x");
    await expect(tokens.consumeProvisionToken(token)).rejects.toMatchObject({
      code: "token_replayed",
    });
  });

  test("verifies without spending before the one consume", async () => {
    const tokens = service(await provisionKey("sign-2026-08"));
    const { token, expiresAt } = await tokens.issueProvisionToken({
      organizationId: "org_alpha",
      tenantRef: "tenant_x",
      reservationId: "rsv_1",
      offeringId: "storage.object.standard",
      offeringDigest: `sha256:${"c".repeat(64)}`,
      ttlSeconds: 120,
    });
    expect(expiresAt).toBe(new Date(NOW + 120_000).toISOString());
    expect((await tokens.verifyProvisionToken(token)).offeringId).toBe("storage.object.standard");
    expect((await tokens.verifyProvisionToken(token)).offeringId).toBe("storage.object.standard");
    expect(await sql.query("SELECT COUNT(*) AS total FROM runtime_grant_replays")).toEqual([
      { total: 0 },
    ]);
    await tokens.consumeProvisionToken(token);
    expect(await sql.query("SELECT COUNT(*) AS total FROM runtime_grant_replays")).toEqual([
      { total: 1 },
    ]);
  });

  test("refuses expiry, oversized lifetime, revoked keys, and missing signer", async () => {
    const key = await provisionKey("sign-2026-08");
    const tokens = service(key);
    const issued = await tokens.issueProvisionToken({
      organizationId: "org_alpha",
      tenantRef: "tenant_x",
      reservationId: "rsv_1",
      offeringId: "storage.object.standard",
      offeringDigest: `sha256:${"c".repeat(64)}`,
      ttlSeconds: 120,
    });
    now = NOW + 120_000;
    await expect(tokens.verifyProvisionToken(issued.token)).rejects.toMatchObject({
      code: "token_expired",
    });

    now = NOW;
    await expect(
      tokens.issueProvisionToken({
        organizationId: "org_alpha",
        tenantRef: "tenant_x",
        reservationId: "rsv_1",
        offeringId: "storage.object.standard",
        offeringDigest: `sha256:${"c".repeat(64)}`,
        ttlSeconds: 3_600,
      }),
    ).rejects.toBeInstanceOf(TokenError);

    await sql.run("UPDATE runtime_grant_keys SET revoked_at_epoch_seconds = 1");
    await expect(service().verifyProvisionToken(issued.token)).rejects.toMatchObject({
      code: "no_active_keys",
    });
    await expect(
      service().issueProvisionToken({
        organizationId: "org_alpha",
        tenantRef: "tenant_x",
        reservationId: "rsv_1",
        offeringId: "storage.object.standard",
        offeringDigest: `sha256:${"c".repeat(64)}`,
        ttlSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: "no_active_keys" });
  });
});
