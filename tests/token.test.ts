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

describe("data tokens", () => {
  test("verify repeatedly within their window without touching durable state", async () => {
    const tokens = service(await provisionKey("sign-2026-08"));
    const { token, expiresAt } = await tokens.issueDataToken({
      organizationId: "org_alpha",
      resourceUid: "res_alpha",
      protocols: ["s3"],
      ttlSeconds: 300,
    });
    expect(expiresAt).toBe(new Date(NOW + 300_000).toISOString());

    // The throughput claim: repeated use costs a signature check, nothing more.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claims = await tokens.verifyDataToken(token, {
        resourceUid: "res_alpha",
        protocol: "s3",
      });
      expect(claims.organizationId).toBe("org_alpha");
      expect(claims.tenantRef).toBeNull();
    }
    expect(await sql.query("SELECT COUNT(*) AS total FROM runtime_grant_replays")).toEqual([
      { total: 0 },
    ]);

    now = NOW + 300_000;
    await expect(
      tokens.verifyDataToken(token, { resourceUid: "res_alpha", protocol: "s3" }),
    ).rejects.toMatchObject({ code: "token_expired" });
  });

  test("refuses a different resource, an unlisted protocol, or a tampered body", async () => {
    const tokens = service(await provisionKey("sign-2026-08"));
    const { token } = await tokens.issueDataToken({
      organizationId: "org_alpha",
      tenantRef: "tenant_x",
      resourceUid: "res_alpha",
      protocols: ["s3"],
      ttlSeconds: 300,
    });

    await expect(
      tokens.verifyDataToken(token, { resourceUid: "res_other", protocol: "s3" }),
    ).rejects.toMatchObject({ code: "wrong_resource" });
    await expect(
      tokens.verifyDataToken(token, { resourceUid: "res_alpha", protocol: "openai" }),
    ).rejects.toMatchObject({ code: "wrong_protocol" });

    const [header, payload, signature] = token.split(".");
    const forged = JSON.parse(new TextDecoder().decode(Buffer.from(payload ?? "", "base64url")));
    forged.resourceUid = "res_other";
    const swapped = `${header}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}`;
    await expect(
      tokens.verifyDataToken(swapped, { resourceUid: "res_other", protocol: "s3" }),
    ).rejects.toMatchObject({ code: "invalid_signature" });
  });

  test("stops verifying once its signing key is revoked", async () => {
    const key = await provisionKey("sign-2026-08");
    const tokens = service(key);
    const { token } = await tokens.issueDataToken({
      organizationId: "org_alpha",
      resourceUid: "res_alpha",
      protocols: ["s3", "openai"],
      ttlSeconds: 600,
    });
    expect(
      (await tokens.verifyDataToken(token, { resourceUid: "res_alpha", protocol: "openai" }))
        .protocols,
    ).toEqual(["openai", "s3"]);

    await sql.run("UPDATE runtime_grant_keys SET revoked_at_epoch_seconds = ? WHERE key_id = ?", [
      1,
      "sign-2026-08",
    ]);
    // Revoking the key is the kill switch for every token it ever signed, even
    // though those tokens are still inside their validity window.
    await expect(
      tokens.verifyDataToken(token, { resourceUid: "res_alpha", protocol: "s3" }),
    ).rejects.toMatchObject({ code: "no_active_keys" });
  });

  test("keeps a revoked key alive only for the declared cache window", async () => {
    const tokens = service(await provisionKey("sign-2026-08"), 10);
    const { token } = await tokens.issueDataToken({
      organizationId: "org_alpha",
      resourceUid: "res_alpha",
      protocols: ["s3"],
      ttlSeconds: 600,
    });
    await tokens.verifyDataToken(token, { resourceUid: "res_alpha", protocol: "s3" });

    await sql.run("UPDATE runtime_grant_keys SET revoked_at_epoch_seconds = ? WHERE key_id = ?", [
      1,
      "sign-2026-08",
    ]);
    // Inside the cache window the revocation is not yet visible. This is the
    // documented lag, asserted so it can never widen silently.
    now = NOW + 5_000;
    await tokens.verifyDataToken(token, { resourceUid: "res_alpha", protocol: "s3" });

    now = NOW + 11_000;
    await expect(
      tokens.verifyDataToken(token, { resourceUid: "res_alpha", protocol: "s3" }),
    ).rejects.toMatchObject({ code: "no_active_keys" });
  });
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

  test("cannot be presented as a data token, and vice versa", async () => {
    const tokens = service(await provisionKey("sign-2026-08"));
    const provision = await tokens.issueProvisionToken({
      organizationId: "org_alpha",
      tenantRef: "tenant_x",
      reservationId: "rsv_1",
      offeringId: "storage.object.standard",
      offeringDigest: `sha256:${"c".repeat(64)}`,
      ttlSeconds: 120,
    });
    const data = await tokens.issueDataToken({
      organizationId: "org_alpha",
      resourceUid: "res_alpha",
      protocols: ["s3"],
      ttlSeconds: 120,
    });

    // The audience separates the two authorities: one creates resources, the
    // other reads and writes bytes. Neither may stand in for the other.
    await expect(
      tokens.verifyDataToken(provision.token, { resourceUid: "res_alpha", protocol: "s3" }),
    ).rejects.toMatchObject({ code: "wrong_audience" });
    await expect(tokens.consumeProvisionToken(data.token)).rejects.toMatchObject({
      code: "wrong_audience",
    });
  });

  test("refuses a lifetime beyond the provisioning maximum", async () => {
    const tokens = service(await provisionKey("sign-2026-08"));
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
  });

  test("fails closed when no key is active", async () => {
    const tokens = service();
    await expect(
      tokens.issueDataToken({
        organizationId: "org_alpha",
        resourceUid: "res_alpha",
        protocols: ["s3"],
        ttlSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: "no_active_keys" });
  });
});
