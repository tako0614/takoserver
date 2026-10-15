import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { Sql } from "../src/ports.ts";
import { createSponsorshipCredentialIssuer } from "../src/sponsorship-credential.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { tenantRunPrincipalId } from "../src/tenant-run-credential.ts";
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

function sponsorshipIssuer(signingKey: SigningKey) {
  return createSponsorshipCredentialIssuer({ issuer: ISSUER, signingKey, clock });
}

async function admitSponsorshipCredential(
  input: {
    readonly organizationId: string;
    readonly tenantRef: string;
    readonly issuedAtEpochSeconds: number;
    readonly tokenId: string;
    readonly ttlSeconds: number;
  },
  credentialKeyId: string,
): Promise<void> {
  await sql.run(
    `INSERT INTO sponsorship_credential_issuance_operations
       (token_id, org_id, tenant_ref, issued_at_epoch_seconds,
        expires_at_epoch_seconds, credential_key_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.tokenId,
      input.organizationId,
      input.tenantRef,
      input.issuedAtEpochSeconds,
      input.issuedAtEpochSeconds + input.ttlSeconds,
      credentialKeyId,
    ],
  );
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
    CREATE TABLE reservations (
      id TEXT PRIMARY KEY NOT NULL,
      org_id TEXT NOT NULL,
      tenant_ref TEXT NOT NULL,
      offering_id TEXT NOT NULL,
      offering_digest TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE provision_token_consumptions (
      token_id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT NOT NULL,
      tenant_ref TEXT NOT NULL,
      reservation_id TEXT NOT NULL UNIQUE,
      offering_id TEXT NOT NULL,
      offering_digest TEXT NOT NULL,
      expires_at_epoch_seconds INTEGER NOT NULL,
      consumed_at_epoch_seconds INTEGER NOT NULL
    );
    CREATE TABLE sponsorship_credential_issuance_operations (
      token_id TEXT PRIMARY KEY NOT NULL,
      org_id TEXT NOT NULL,
      tenant_ref TEXT NOT NULL,
      issued_at_epoch_seconds INTEGER NOT NULL,
      expires_at_epoch_seconds INTEGER NOT NULL,
      credential_key_id TEXT NOT NULL
    );
    INSERT INTO reservations
      (id, org_id, tenant_ref, offering_id, offering_digest, status)
    VALUES
      ('rsv_1', 'org_alpha', 'tenant_x', 'storage.object.standard',
       'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
       'active');
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
    expect(await sql.query("SELECT COUNT(*) AS total FROM provision_token_consumptions")).toEqual([
      { total: 0 },
    ]);
    await tokens.consumeProvisionToken(token);
    expect(await sql.query("SELECT COUNT(*) AS total FROM provision_token_consumptions")).toEqual([
      { total: 1 },
    ]);
  });

  test("allows only one redeemed token for a reservation", async () => {
    const tokens = service(await provisionKey("sign-2026-08"));
    const input = {
      organizationId: "org_alpha",
      tenantRef: "tenant_x",
      reservationId: "rsv_1",
      offeringId: "storage.object.standard",
      offeringDigest: `sha256:${"c".repeat(64)}` as const,
      ttlSeconds: 120,
    };
    const first = await tokens.issueProvisionToken(input);
    const second = await tokens.issueProvisionToken(input);
    await tokens.consumeProvisionToken(first.token);
    await expect(tokens.consumeProvisionToken(second.token)).rejects.toMatchObject({
      code: "token_replayed",
    });
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

describe("Takoform run tokens", () => {
  test("bind a multi-Resource runner credential without a private materialization claim", async () => {
    const key = await provisionKey("sponsorship-credential-run");
    const tokens = service();
    expect(tokens).not.toHaveProperty("issueTakoformTenantRunToken");
    expect(tokens).not.toHaveProperty("issueTakoformTenantRunTokenDeterministic");
    const input = {
      organizationId: "org_alpha",
      tenantRef: "tenant_workspace_x",
      spaceRef: "tsp_capsule_yurucommu",
      runRef: "run_host_1",
      runtimeMaterialization: { kind: "retired" },
      ttlSeconds: 300,
      issuedAtEpochSeconds: Math.floor(NOW / 1_000),
      tokenId: "tok_sponsor_multi_resource",
    } as const;
    const issued = await sponsorshipIssuer(key).issue(input);
    await admitSponsorshipCredential(input, key.keyId);
    const claims = await tokens.verifyTakoformTenantRunToken(issued.token);
    expect(claims).toMatchObject({
      organizationId: "org_alpha",
      tenantRef: "tenant_workspace_x",
      spaceRef: "tsp_capsule_yurucommu",
      runRef: "run_host_1",
      mode: "tenant-run",
    });
    expect(claims).not.toHaveProperty("runtimeMaterialization");
    expect(await tenantRunPrincipalId(claims)).toBe(`run:${claims.tokenId}`);
  });

  test("binds only the opaque endpoint reservation authority into a tenant-run credential", async () => {
    const key = await provisionKey("sponsorship-credential-reservation");
    const tokens = service();
    const input = {
      organizationId: "org_alpha",
      tenantRef: "tenant_workspace_x",
      spaceRef: "tsp_capsule_yurucommu",
      runRef: "run_host_endpoint",
      workerEndpointOriginReservationId: "reservation_endpoint_01",
      ttlSeconds: 300,
      issuedAtEpochSeconds: Math.floor(NOW / 1_000),
      tokenId: "tok_sponsor_endpoint_reservation",
    } as const;
    const issued = await sponsorshipIssuer(key).issue(input);
    await admitSponsorshipCredential(input, key.keyId);
    expect(await tokens.verifyTakoformTenantRunToken(issued.token)).toMatchObject({
      organizationId: "org_alpha",
      tenantRef: "tenant_workspace_x",
      spaceRef: "tsp_capsule_yurucommu",
      runRef: "run_host_endpoint",
      mode: "tenant-run",
      workerEndpointOriginReservationId: "reservation_endpoint_01",
    });
  });

  test("keeps an opaque logical principal across fresh Runs without reusing the token identity", async () => {
    const key = await provisionKey("sponsorship-logical-principal");
    const issuer = sponsorshipIssuer(key);
    const tokens = service();
    const firstInput = {
      organizationId: "org_alpha",
      tenantRef: "tenant_workspace_x",
      spaceRef: "tsp_capsule_yurucommu",
      runRef: "run_first",
      logicalPrincipalRef: "tshlp_same_capsule",
      ttlSeconds: 300,
      issuedAtEpochSeconds: Math.floor(NOW / 1_000),
      tokenId: "tok_sponsor_first_run",
    } as const;
    const nextInput = {
      ...firstInput,
      runRef: "run_next",
      tokenId: "tok_sponsor_next_run",
    } as const;
    const first = await issuer.issue(firstInput);
    const next = await issuer.issue(nextInput);
    await admitSponsorshipCredential(firstInput, key.keyId);
    await admitSponsorshipCredential(nextInput, key.keyId);
    const firstClaims = await tokens.verifyTakoformTenantRunToken(first.token);
    const nextClaims = await tokens.verifyTakoformTenantRunToken(next.token);
    expect(firstClaims.logicalPrincipalRef).toBe("tshlp_same_capsule");
    expect(nextClaims.logicalPrincipalRef).toBe(firstClaims.logicalPrincipalRef);
    expect(await tenantRunPrincipalId(nextClaims)).toMatch(/^run:owner_[0-9a-f]{64}$/u);
    expect(await tenantRunPrincipalId(nextClaims)).toBe(await tenantRunPrincipalId(firstClaims));
    expect(await tenantRunPrincipalId({ ...nextClaims, spaceRef: "space_other" })).not.toBe(
      await tenantRunPrincipalId(firstClaims),
    );
    expect(
      await tenantRunPrincipalId({ ...nextClaims, tenantRef: "tenant_workspace_other" }),
    ).not.toBe(await tenantRunPrincipalId(firstClaims));
    expect(await tenantRunPrincipalId({ ...nextClaims, organizationId: "org_other" })).not.toBe(
      await tenantRunPrincipalId(firstClaims),
    );
    expect(nextClaims.runRef).not.toBe(firstClaims.runRef);
    expect(nextClaims.tokenId).not.toBe(firstClaims.tokenId);
    expect(nextClaims.expiresAtEpochSeconds - nextClaims.issuedAtEpochSeconds).toBe(300);
    now = NOW + 301_000;
    await expect(tokens.verifyTakoformTenantRunToken(next.token)).rejects.toMatchObject({
      code: "token_expired",
    });
    now = NOW;
    await sql.run("UPDATE runtime_grant_keys SET revoked_at_epoch_seconds = 1 WHERE key_id = ?", [
      key.keyId,
    ]);
    await expect(service().verifyTakoformTenantRunToken(next.token)).rejects.toMatchObject({
      code: "no_active_keys",
    });
  });

  test("reconstructs an admitted tenant-run credential byte-for-byte after result loss", async () => {
    const key = await provisionKey("sponsorship-credential-idempotent");
    const issuer = sponsorshipIssuer(key);
    const tokens = service();
    const input = {
      organizationId: "org_alpha",
      tenantRef: "tenant_workspace_x",
      spaceRef: "tsp_capsule_yurucommu",
      runRef: "run_host_idempotent",
      ttlSeconds: 300,
      issuedAtEpochSeconds: Math.floor(NOW / 1_000),
      tokenId: "tok_sponsor_exact_operation",
    } as const;
    const first = await issuer.issue(input);
    await admitSponsorshipCredential(input, key.keyId);
    now += 120_000;
    const replay = await issuer.issue(input);
    expect(replay).toEqual(first);
    expect(await tokens.verifyTakoformTenantRunToken(replay.token)).toMatchObject({
      issuedAtEpochSeconds: Math.floor(NOW / 1_000),
      expiresAtEpochSeconds: Math.floor(NOW / 1_000) + 300,
      tokenId: "tok_sponsor_exact_operation",
    });
  });

  test("rejects a tenant-run JWT made with the public Worker's ordinary signing key", async () => {
    const ordinaryKey = await provisionKey("public-runtime-signing-key");
    const credentialKey = await provisionKey("sponsorship-credential-key");
    const input = {
      organizationId: "org_alpha",
      tenantRef: "tenant_workspace_x",
      spaceRef: "tsp_capsule_yurucommu",
      runRef: "run_outside_authority",
      ttlSeconds: 300,
      issuedAtEpochSeconds: Math.floor(NOW / 1_000),
      tokenId: "tok_sponsor_outside_authority",
    } as const;
    await admitSponsorshipCredential(input, credentialKey.keyId);
    const forged = await sponsorshipIssuer(ordinaryKey).issue(input);

    await expect(service().verifyTakoformTenantRunToken(forged.token)).rejects.toMatchObject({
      code: "invalid_credential_authority",
    });
  });

  test("rejects a credential-key JWT without the route-less authority admission", async () => {
    const credentialKey = await provisionKey("sponsorship-credential-unadmitted");
    const issued = await sponsorshipIssuer(credentialKey).issue({
      organizationId: "org_alpha",
      tenantRef: "tenant_workspace_x",
      spaceRef: "tsp_capsule_yurucommu",
      runRef: "run_without_authority_receipt",
      ttlSeconds: 300,
      issuedAtEpochSeconds: Math.floor(NOW / 1_000),
      tokenId: "tok_sponsor_without_authority_receipt",
    });

    await expect(service().verifyTakoformTenantRunToken(issued.token)).rejects.toMatchObject({
      code: "invalid_credential_authority",
    });
  });

  test("bind one reusable credential to an exact reservation, Form, space, and address", async () => {
    const tokens = service(await provisionKey("sign-2026-08"));
    const formRef = {
      apiVersion: "edge.forms.takoform.com/v1beta1",
      kind: "ObjectBucket",
      definitionVersion: "0.1.0",
      schemaDigest: `sha256:${"a".repeat(64)}` as const,
    };
    const issued = await tokens.issueTakoformRunToken({
      organizationId: "org_alpha",
      tenantRef: "tenant_x",
      reservationId: "rsv_1",
      offeringId: "storage.object.standard",
      offeringDigest: `sha256:${"c".repeat(64)}`,
      formRef,
      resourceName: "media",
      mode: "provision",
      ttlSeconds: 600,
    });

    expect(issued.expiresAt).toBe(new Date(NOW + 600_000).toISOString());
    expect(await tokens.verifyTakoformRunToken(issued.token)).toMatchObject({
      organizationId: "org_alpha",
      tenantRef: "tenant_x",
      reservationId: "rsv_1",
      offeringId: "storage.object.standard",
      offeringDigest: `sha256:${"c".repeat(64)}`,
      formRef,
      resourceName: "media",
    });
    expect((await tokens.verifyTakoformRunToken(issued.token)).tokenId).toStartWith("tok_");
    await expect(tokens.claimTakoformRunTokenForCreate(issued.token)).resolves.toMatchObject({
      resourceName: "media",
    });
    await expect(tokens.claimTakoformRunTokenForCreate(issued.token)).resolves.toMatchObject({
      resourceName: "media",
    });
    expect(await sql.query("SELECT COUNT(*) AS total FROM provision_token_consumptions")).toEqual([
      { total: 1 },
    ]);

    const competing = await tokens.issueTakoformRunToken({
      organizationId: "org_alpha",
      tenantRef: "tenant_x",
      reservationId: "rsv_1",
      offeringId: "storage.object.standard",
      offeringDigest: `sha256:${"c".repeat(64)}`,
      formRef,
      resourceName: "media",
      mode: "provision",
      ttlSeconds: 600,
    });
    await expect(tokens.claimTakoformRunTokenForCreate(competing.token)).rejects.toMatchObject({
      code: "token_replayed",
    });
  });
});

async function tenantRunOriginalFixture(withOptionalClaims = true, actualSql: Sql = sql) {
  const key = await provisionKey("original-credential-key");
  const input = {
    organizationId: "org_alpha",
    tenantRef: "tenant_original",
    spaceRef: "tsp_original",
    runRef: "run_original",
    ...(withOptionalClaims
      ? {
          logicalPrincipalRef: "principal_original",
          workerEndpointOriginReservationId: "rsv_original",
        }
      : {}),
    ttlSeconds: 300,
    issuedAtEpochSeconds: Math.floor(NOW / 1_000),
    tokenId: "tok_original",
  } as const;
  const issued = await sponsorshipIssuer(key).issue(input);
  await admitSponsorshipCredential(input, key.keyId);
  const tokens = createTokenService({ sql: actualSql, issuer: ISSUER, clock, keyCacheSeconds: 0 });
  return { key, input, issued, tokens, actualSql };
}

/** A deferred real SQLite read, never an admission or positive-verification override. */
function deferredOriginalSql() {
  const actualSql = sql;
  let issuanceReads = 0;
  let deferred:
    | {
        readonly at: number;
        readonly entered: () => void;
        readonly waiting: Promise<void>;
      }
    | undefined;
  const port: Sql = {
    async query(statement, params) {
      const rows = await actualSql.query(statement, params);
      if (statement.includes("FROM sponsorship_credential_issuance_operations")) {
        issuanceReads += 1;
        if (deferred?.at === issuanceReads) {
          const held = deferred;
          deferred = undefined;
          held.entered();
          await held.waiting;
        }
      }
      return rows;
    },
    run: actualSql.run.bind(actualSql),
    batch: actualSql.batch.bind(actualSql),
  };
  return {
    port,
    nextIssuanceRead(offset: 1 | 2) {
      if (deferred) throw new Error("an issuance read is already held");
      let entered = () => {};
      let release = () => {};
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      deferred = { at: issuanceReads + offset, entered, waiting };
      return { reached, release };
    },
  };
}

async function reachOriginalRead(reached: Promise<void>, read: Promise<unknown>): Promise<void> {
  await Promise.race([
    reached,
    read.then(() => {
      throw new Error("read completed before the expected SQLite barrier");
    }),
  ]);
}

describe("request-local tenant-run credential original", () => {
  test("opens actual signed issuance into an immutable nonserializable handle and exact view", async () => {
    const f = await tenantRunOriginalFixture();
    const logicalPrincipalRef = f.input.logicalPrincipalRef;
    const workerEndpointOriginReservationId = f.input.workerEndpointOriginReservationId;
    if (
      logicalPrincipalRef !== "principal_original" ||
      workerEndpointOriginReservationId !== "rsv_original"
    ) {
      throw new Error("fixture requires both original tenant-run optional claims");
    }
    const original = await f.tokens.openTakoformTenantRunOriginal(f.issued.token);
    const view = await f.tokens.readTakoformTenantRunOriginal(original, f.actualSql);
    expect(view).toEqual({
      issuer: ISSUER,
      principalId: await tenantRunPrincipalId(view.claims),
      claims: {
        organizationId: f.input.organizationId,
        tenantRef: f.input.tenantRef,
        spaceRef: f.input.spaceRef,
        runRef: f.input.runRef,
        logicalPrincipalRef,
        workerEndpointOriginReservationId,
        mode: "tenant-run",
        tokenId: f.input.tokenId,
        issuedAtEpochSeconds: f.input.issuedAtEpochSeconds,
        expiresAtEpochSeconds: f.input.issuedAtEpochSeconds + f.input.ttlSeconds,
      },
      issuance: {
        kind: "builtin-sponsorship-issuance",
        tokenId: f.input.tokenId,
        organizationId: f.input.organizationId,
        tenantRef: f.input.tenantRef,
        issuedAtEpochSeconds: f.input.issuedAtEpochSeconds,
        expiresAtEpochSeconds: f.input.issuedAtEpochSeconds + f.input.ttlSeconds,
        credentialKeyId: f.key.keyId,
      },
    });
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(Object.getPrototypeOf(original))).toBe(true);
    expect(Object.isFrozen(Object.getPrototypeOf(original).constructor)).toBe(true);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.claims)).toBe(true);
    expect(Object.isFrozen(view.issuance)).toBe(true);
    expect(Object.keys(original)).toEqual([]);
    expect(Object.getOwnPropertySymbols(original)).toEqual([]);
    expect(JSON.stringify(original)).toBe("{}");
    expect(JSON.stringify({ original, view })).not.toContain(f.issued.token);
    expect(Reflect.set(view.claims, "spaceRef", "tsp_other")).toBe(false);
    expect(Reflect.set(view.issuance, "credentialKeyId", "forged-key")).toBe(false);
    expect(await f.tokens.readTakoformTenantRunOriginal(original, f.actualSql)).toBe(view);
  });

  test("keeps optional reservation and logical principal absent without inventing a product or grant", async () => {
    const f = await tenantRunOriginalFixture(false);
    const original = await f.tokens.openTakoformTenantRunOriginal(f.issued.token);
    const view = await f.tokens.readTakoformTenantRunOriginal(original, f.actualSql);
    expect(view.principalId).toBe(`run:${f.input.tokenId}`);
    expect(Object.hasOwn(view.claims, "workerEndpointOriginReservationId")).toBe(false);
    expect(Object.hasOwn(view.claims, "logicalPrincipalRef")).toBe(false);
    expect(Object.hasOwn(view, "product")).toBe(false);
    expect(Object.hasOwn(view, "grant")).toBe(false);
    expect(Object.hasOwn(view, "ready")).toBe(false);
  });

  test("refuses fabricated, copied, proxied and reconstructed handles without consulting getters", async () => {
    const f = await tenantRunOriginalFixture();
    const original = await f.tokens.openTakoformTenantRunOriginal(f.issued.token);
    let getterCalls = 0;
    const getterFake = {
      get token() {
        getterCalls += 1;
        return f.issued.token;
      },
      get claims() {
        getterCalls += 1;
        throw new Error("must not consult claims");
      },
    };
    for (const fake of [
      {},
      { ...original },
      structuredClone(original),
      getterFake,
      new Proxy(original, {
        get() {
          getterCalls += 1;
          throw new Error("must not unwrap");
        },
      }),
      Object.create(Object.getPrototypeOf(original)),
    ]) {
      await expect(f.tokens.readTakoformTenantRunOriginal(fake, f.actualSql)).rejects.toMatchObject(
        {
          code: "invalid_credential_authority",
        },
      );
      expect(() => f.tokens.closeTakoformTenantRunOriginal(fake, f.actualSql)).toThrow(
        "invalid_credential_authority",
      );
    }
    expect(getterCalls).toBe(0);
    expect(() => Reflect.construct(Object.getPrototypeOf(original).constructor, [])).toThrow(
      "invalid_credential_authority",
    );
    expect(() =>
      Reflect.construct(Object.getPrototypeOf(original).constructor, [
        Symbol("tenant-run original mint"),
      ]),
    ).toThrow("invalid_credential_authority");
    expect(
      (await f.tokens.readTakoformTenantRunOriginal(original, f.actualSql)).claims.tokenId,
    ).toBe(f.input.tokenId);
  });

  test("binds the genuine handle to its concrete issuer instance and actual Sql", async () => {
    const f = await tenantRunOriginalFixture();
    const original = await f.tokens.openTakoformTenantRunOriginal(f.issued.token);
    const otherIssuer = createTokenService({
      sql: f.actualSql,
      issuer: ISSUER,
      clock,
      keyCacheSeconds: 0,
    });
    await expect(
      otherIssuer.readTakoformTenantRunOriginal(original, f.actualSql),
    ).rejects.toMatchObject({ code: "invalid_credential_authority" });
    expect(() => otherIssuer.closeTakoformTenantRunOriginal(original, f.actualSql)).toThrow(
      "invalid_credential_authority",
    );
    const anotherSql: Sql = {
      query: f.actualSql.query.bind(f.actualSql),
      run: f.actualSql.run.bind(f.actualSql),
      batch: f.actualSql.batch.bind(f.actualSql),
    };
    await expect(
      f.tokens.readTakoformTenantRunOriginal(original, anotherSql),
    ).rejects.toMatchObject({ code: "invalid_credential_authority" });
    expect(() => f.tokens.closeTakoformTenantRunOriginal(original, anotherSql)).toThrow(
      "invalid_credential_authority",
    );
    const duplicateModuleUrl = new URL(
      "../src/token.ts?original-capture-second-module",
      import.meta.url,
    ).href;
    const duplicateModule: typeof import("../src/token.ts") = await import(duplicateModuleUrl);
    const duplicateIssuer = duplicateModule.createTokenService({
      sql: f.actualSql,
      issuer: ISSUER,
      clock,
      keyCacheSeconds: 0,
    });
    await expect(
      duplicateIssuer.readTakoformTenantRunOriginal(original, f.actualSql),
    ).rejects.toMatchObject({ code: "invalid_credential_authority" });
    const duplicateOriginal = await duplicateIssuer.openTakoformTenantRunOriginal(f.issued.token);
    await expect(
      f.tokens.readTakoformTenantRunOriginal(duplicateOriginal, f.actualSql),
    ).rejects.toMatchObject({ code: "invalid_credential_authority" });
  });

  test("requires original callable descriptors and receiver without executing replacement getters", async () => {
    const f = await tenantRunOriginalFixture();
    const original = await f.tokens.openTakoformTenantRunOriginal(f.issued.token);
    const read = f.tokens.readTakoformTenantRunOriginal;
    const open = f.tokens.openTakoformTenantRunOriginal;
    await expect(open(f.issued.token)).rejects.toMatchObject({
      code: "invalid_credential_authority",
    });
    let getterCalls = 0;
    for (const method of [
      "openTakoformTenantRunOriginal",
      "readTakoformTenantRunOriginal",
      "closeTakoformTenantRunOriginal",
    ] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(f.tokens, method);
      if (!descriptor) throw new Error("missing original method");
      Object.defineProperty(f.tokens, method, {
        configurable: true,
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error("must not invoke replacement");
        },
      });
      await expect(read.call(f.tokens, original, f.actualSql)).rejects.toMatchObject({
        code: "invalid_credential_authority",
      });
      Object.defineProperty(f.tokens, method, descriptor);
    }
    expect(getterCalls).toBe(0);
    expect((await read.call(f.tokens, original, f.actualSql)).claims.tokenId).toBe(f.input.tokenId);
  });

  test("never trusts a positive replacement of the public plain-claims verifier", async () => {
    const f = await tenantRunOriginalFixture();
    const original = await f.tokens.openTakoformTenantRunOriginal(f.issued.token);
    const view = await f.tokens.readTakoformTenantRunOriginal(original, f.actualSql);
    f.tokens.verifyTakoformTenantRunToken = async () => view.claims;
    await expect(
      f.tokens.openTakoformTenantRunOriginal("not-a-signed-token"),
    ).rejects.toMatchObject({ code: "malformed_token" });
    expect(await f.tokens.readTakoformTenantRunOriginal(original, f.actualSql)).toBe(view);
    await sql.run("DELETE FROM sponsorship_credential_issuance_operations WHERE token_id = ?", [
      f.input.tokenId,
    ]);
    await expect(f.tokens.verifyTakoformTenantRunToken(f.issued.token)).resolves.toBe(view.claims);
    await expect(
      f.tokens.readTakoformTenantRunOriginal(original, f.actualSql),
    ).rejects.toMatchObject({ code: "invalid_credential_authority" });
  });

  test("preserves custom admission's plain API but cannot mint built-in issuance provenance from it", async () => {
    const f = await tenantRunOriginalFixture();
    await sql.run("DELETE FROM sponsorship_credential_issuance_operations WHERE token_id = ?", [
      f.input.tokenId,
    ]);
    let customAdmissions = 0;
    const custom = createTokenService({
      sql,
      issuer: ISSUER,
      clock,
      keyCacheSeconds: 0,
      tenantRunCredentialAdmission: {
        async assertAdmitted() {
          customAdmissions += 1;
        },
      },
    });
    expect((await custom.verifyTakoformTenantRunToken(f.issued.token)).tokenId).toBe(
      f.input.tokenId,
    );
    expect(customAdmissions).toBe(1);
    await expect(custom.openTakoformTenantRunOriginal(f.issued.token)).rejects.toMatchObject({
      code: "invalid_credential_authority",
    });
    expect(customAdmissions).toBe(1);
    await expect(f.tokens.openTakoformTenantRunOriginal(f.issued.token)).rejects.toMatchObject({
      code: "invalid_credential_authority",
    });
  });

  test("revalidates all six issuance columns and rejects a withdrawn original", async () => {
    const f = await tenantRunOriginalFixture();
    const original = await f.tokens.openTakoformTenantRunOriginal(f.issued.token);
    for (const [column, changed, previous] of [
      ["org_id", "org_other", f.input.organizationId],
      ["tenant_ref", "tenant_other", f.input.tenantRef],
      ["issued_at_epoch_seconds", f.input.issuedAtEpochSeconds - 1, f.input.issuedAtEpochSeconds],
      [
        "expires_at_epoch_seconds",
        f.input.issuedAtEpochSeconds + 301,
        f.input.issuedAtEpochSeconds + f.input.ttlSeconds,
      ],
      ["credential_key_id", "other-credential-key", f.key.keyId],
    ] as const) {
      await sql.run(
        `UPDATE sponsorship_credential_issuance_operations SET ${column} = ? WHERE token_id = ?`,
        [changed, f.input.tokenId],
      );
      await expect(
        f.tokens.readTakoformTenantRunOriginal(original, f.actualSql),
      ).rejects.toMatchObject({ code: "invalid_credential_authority" });
      await sql.run(
        `UPDATE sponsorship_credential_issuance_operations SET ${column} = ? WHERE token_id = ?`,
        [previous, f.input.tokenId],
      );
    }
    await sql.run(
      "UPDATE sponsorship_credential_issuance_operations SET token_id = ? WHERE token_id = ?",
      ["tok_other", f.input.tokenId],
    );
    await expect(
      f.tokens.readTakoformTenantRunOriginal(original, f.actualSql),
    ).rejects.toMatchObject({ code: "invalid_credential_authority" });
  });

  test("reopens the signature and active key on each read under the existing key-cache policy", async () => {
    const f = await tenantRunOriginalFixture();
    const wrongKey = await provisionKey("wrong-original-signing-key");
    const wrong = await sponsorshipIssuer(wrongKey).issue(f.input);
    await expect(f.tokens.openTakoformTenantRunOriginal(wrong.token)).rejects.toMatchObject({
      code: "invalid_credential_authority",
    });
    const original = await f.tokens.openTakoformTenantRunOriginal(f.issued.token);
    await sql.run("UPDATE runtime_grant_keys SET revoked_at_epoch_seconds = ? WHERE key_id = ?", [
      Math.floor(NOW / 1_000),
      f.key.keyId,
    ]);
    await expect(
      f.tokens.readTakoformTenantRunOriginal(original, f.actualSql),
    ).rejects.toMatchObject({ code: "unknown_key" });
  });

  test("rejects changed construction or Sql query descriptors without calling their replacements", async () => {
    const f = await tenantRunOriginalFixture();
    const options = { sql: f.actualSql, issuer: ISSUER, clock, keyCacheSeconds: 0 };
    const tokens = createTokenService(options);
    const original = await tokens.openTakoformTenantRunOriginal(f.issued.token);
    const queryDescriptor = Object.getOwnPropertyDescriptor(f.actualSql, "query");
    if (!queryDescriptor) throw new Error("missing original Sql query");
    let getterCalls = 0;
    Object.defineProperty(f.actualSql, "query", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("must not invoke replacement Sql");
      },
    });
    await expect(tokens.readTakoformTenantRunOriginal(original, f.actualSql)).rejects.toMatchObject(
      { code: "invalid_credential_authority" },
    );
    Object.defineProperty(f.actualSql, "query", queryDescriptor);
    Object.defineProperty(options, "sql", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("must not invoke replacement option");
      },
    });
    await expect(tokens.readTakoformTenantRunOriginal(original, f.actualSql)).rejects.toMatchObject(
      { code: "invalid_credential_authority" },
    );
    expect(getterCalls).toBe(0);
  });

  test("rejects issuance withdrawal, expiry, replaced methods and close after real SQLite awaits", async () => {
    const held = deferredOriginalSql();
    const f = await tenantRunOriginalFixture(true, held.port);
    const original = await f.tokens.openTakoformTenantRunOriginal(f.issued.token);

    const withdrawal = held.nextIssuanceRead(1);
    const withdrawnRead = f.tokens.readTakoformTenantRunOriginal(original, f.actualSql);
    await reachOriginalRead(withdrawal.reached, withdrawnRead);
    await sql.run("DELETE FROM sponsorship_credential_issuance_operations WHERE token_id = ?", [
      f.input.tokenId,
    ]);
    withdrawal.release();
    await expect(withdrawnRead).rejects.toMatchObject({ code: "invalid_credential_authority" });
    await admitSponsorshipCredential(f.input, f.key.keyId);

    const expiry = held.nextIssuanceRead(2);
    const expiredRead = f.tokens.readTakoformTenantRunOriginal(original, f.actualSql);
    await reachOriginalRead(expiry.reached, expiredRead);
    now += f.input.ttlSeconds * 1_000;
    expiry.release();
    await expect(expiredRead).rejects.toMatchObject({ code: "token_expired" });
    now = NOW;

    const replacement = held.nextIssuanceRead(2);
    const replacedRead = f.tokens.readTakoformTenantRunOriginal(original, f.actualSql);
    await reachOriginalRead(replacement.reached, replacedRead);
    const originalRead = f.tokens.readTakoformTenantRunOriginal;
    f.tokens.readTakoformTenantRunOriginal = async () => {
      throw new Error("not the original callable");
    };
    replacement.release();
    await expect(replacedRead).rejects.toMatchObject({ code: "invalid_credential_authority" });
    f.tokens.readTakoformTenantRunOriginal = originalRead;

    const closing = held.nextIssuanceRead(2);
    const closedRead = f.tokens.readTakoformTenantRunOriginal(original, f.actualSql);
    await reachOriginalRead(closing.reached, closedRead);
    f.tokens.closeTakoformTenantRunOriginal(original, f.actualSql);
    closing.release();
    await expect(closedRead).rejects.toMatchObject({ code: "invalid_credential_authority" });
    await expect(
      f.tokens.readTakoformTenantRunOriginal(original, f.actualSql),
    ).rejects.toMatchObject({ code: "invalid_credential_authority" });
    expect(() => f.tokens.closeTakoformTenantRunOriginal(original, f.actualSql)).not.toThrow();
  });
});

describe("tenant-run original final public continuation", () => {
  test("refuses close between the inner read resolution and the public read continuation", async () => {
    const actualSql = sql;
    const events: string[] = [];
    let armed = false;
    let finalReadCount = 0;
    let closeOriginal: (() => void) | undefined;
    const port: Sql = {
      async query(statement, params) {
        const rows = await actualSql.query(statement, params);
        if (armed && statement.includes("FROM sponsorship_credential_issuance_operations")) {
          finalReadCount += 1;
          if (finalReadCount === 2) {
            const close = closeOriginal;
            if (!close) throw new Error("original close is not installed");
            events.push("final-issuance-rows");
            // The three jobs interleave with verifyOriginal and inner read
            // resolution, closing before the outer public continuation.
            queueMicrotask(() => {
              events.push("microtask-1");
              queueMicrotask(() => {
                events.push("microtask-2");
                queueMicrotask(() => {
                  events.push("close");
                  close();
                });
              });
            });
          }
        }
        return rows;
      },
      run: actualSql.run.bind(actualSql),
      batch: actualSql.batch.bind(actualSql),
    };
    const f = await tenantRunOriginalFixture(true, port);
    const original = await f.tokens.openTakoformTenantRunOriginal(f.issued.token);
    closeOriginal = () => f.tokens.closeTakoformTenantRunOriginal(original, port);
    armed = true;
    const publicRead = f.tokens.readTakoformTenantRunOriginal(original, port).then(
      (view) => {
        events.push("public-resolved");
        return view;
      },
      (error: unknown) => {
        events.push("public-rejected");
        throw error;
      },
    );
    await expect(publicRead).rejects.toMatchObject({ code: "invalid_credential_authority" });
    expect(finalReadCount).toBe(2);
    expect(events).toEqual([
      "final-issuance-rows",
      "microtask-1",
      "microtask-2",
      "close",
      "public-rejected",
    ]);
    await expect(f.tokens.readTakoformTenantRunOriginal(original, port)).rejects.toMatchObject({
      code: "invalid_credential_authority",
    });
  });
});
