import { describe, expect, test } from "bun:test";
import { buildApp } from "../src/app.ts";
import type { ExternalIdentityVerifier } from "../src/auth.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { base64UrlEncode } from "../src/json.ts";
import type { FundingSettlementVerifier } from "../src/ledger.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { Sql } from "../src/ports.ts";
import { createRuntimeInputAuthority } from "../src/runtime-input-preparations.ts";
import { createSelfhostTenantRunCredentials } from "../src/selfhost-tenant-run-credentials.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import {
  createTokenService,
  type SigningKey,
  type TenantRunCredentialAdmission,
} from "../src/token.ts";
import type {
  WorkerEndpointOriginReservationProjection,
  WorkerEndpointOriginReservations,
} from "../src/worker-endpoint-origin-reservations.ts";

const ORIGIN = "https://api.selfhost.test";
const START = Date.parse("2026-09-07T12:00:00.000Z");
const identity: ExternalIdentityVerifier = {
  async verify({ assertion }) {
    return {
      providerSubject: `subject:${assertion}`,
      email: `${assertion}@example.test`,
      displayName: assertion,
    };
  },
};
const settlement: FundingSettlementVerifier = {
  async verify() {
    return { fundingRef: "unused", amountMinor: 1, currency: "USD" };
  },
};

describe("self-host tenant-run credential HTTP authority", () => {
  test("is opt-in and admits only an exact resources:write organization actor and live reservation", async () => {
    const now = START;
    const clock = () => new Date(now);
    const disabled = buildApp({
      sql: createEphemeralSql(),
      objects: createMemoryObjectStore(),
      identity,
      settlement,
      publicOrigin: ORIGIN,
      forms: [],
      hostForms: [],
      driver: new InMemoryTakoformResourceDriver(),
      offerings: [],
      clock,
    });
    expect(
      (
        await call(disabled.fetch, "POST", "/v1/selfhost/tenant-run-credentials", {
          spaceRef: "space:disabled",
          runRef: "run:disabled",
        })
      ).status,
    ).toBe(404);

    const sql = createEphemeralSql();
    const ordinaryKey = await registerKey(sql, "ordinary-runtime-key");
    const credentialKey = await registerKey(sql, "selfhost-tenant-run-key");
    const reads: { organizationId: string; reservationId: string }[] = [];
    const live = new Map<string, WorkerEndpointOriginReservationProjection>();
    const reservation = projection("reservation:live");
    const reservations = reservationAuthority(async (organizationId, reservationId) => {
      reads.push({ organizationId, reservationId });
      return live.get(`${organizationId}\0${reservationId}`) ?? null;
    });
    let randomIdCalls = 0;
    let admission: TenantRunCredentialAdmission | undefined;
    const enabled = buildApp({
      sql,
      objects: createMemoryObjectStore(),
      identity,
      settlement,
      publicOrigin: ORIGIN,
      forms: [],
      hostForms: [],
      driver: new InMemoryTakoformResourceDriver(),
      offerings: [],
      signingKey: ordinaryKey,
      originReservations: reservations,
      selfhostTenantRunCredentialAuthority(originReservations) {
        const authority = createSelfhostTenantRunCredentials({
          issuer: ORIGIN,
          signingKey: credentialKey,
          ordinarySigningKeyId: ordinaryKey.keyId,
          runtimeGrantKeys: sql,
          originReservations,
          clock,
          randomId: () => {
            randomIdCalls += 1;
            return `credential_test_${randomIdCalls}`;
          },
        });
        admission = authority;
        return authority;
      },
      clock,
    });

    const session = await call(enabled.fetch, "POST", "/v1/sessions", {
      provider: "github",
      assertion: "owner",
    });
    const sessionAuthorization = `Bearer ${stringField(session.body, "sessionToken")}`;
    const organization = await call(
      enabled.fetch,
      "POST",
      "/v1/organizations",
      { name: "Selfhost" },
      { authorization: sessionAuthorization },
    );
    const organizationId = stringField(recordField(organization.body, "organization"), "id");
    const writer = await createApiKey(
      enabled.fetch,
      organizationId,
      sessionAuthorization,
      "writer",
      ["resources:write"],
    );
    const reader = await createApiKey(
      enabled.fetch,
      organizationId,
      sessionAuthorization,
      "reader",
      ["resources:read"],
    );
    const path = "/v1/selfhost/tenant-run-credentials";
    const body = {
      spaceRef: "space:exact",
      runRef: "run:exact",
      workerEndpointOriginReservationId: reservation.reservationId,
    };

    expect((await call(enabled.fetch, "POST", path, body)).status).toBe(401);
    expect(
      (
        await call(enabled.fetch, "POST", path, body, {
          authorization: "Bearer definitely-wrong",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call(enabled.fetch, "POST", path, body, {
          authorization: sessionAuthorization,
        })
      ).status,
    ).toBe(403);
    expect((await call(enabled.fetch, "POST", path, body, reader.headers)).status).toBe(403);
    expect(
      (
        await call(
          enabled.fetch,
          "POST",
          path,
          { ...body, organizationId: "org:spoofed" },
          writer.headers,
        )
      ).status,
    ).toBe(400);

    // Same spelling under another organization is invisible. The defensive
    // projection checks also refuse a terminal or elapsed result before sign.
    live.set(`org:foreign\0${reservation.reservationId}`, reservation);
    expect((await call(enabled.fetch, "POST", path, body, writer.headers)).status).toBe(404);
    live.set(`${organizationId}\0reservation:expired`, {
      ...projection("reservation:expired"),
      expiresAt: new Date(START).toISOString(),
    });
    live.set(`${organizationId}\0reservation:released`, {
      ...projection("reservation:released"),
      status: "released",
    } as unknown as WorkerEndpointOriginReservationProjection);
    for (const unavailable of [
      "reservation:missing",
      "reservation:released",
      "reservation:expired",
    ]) {
      expect(
        (
          await call(
            enabled.fetch,
            "POST",
            path,
            { ...body, workerEndpointOriginReservationId: unavailable },
            writer.headers,
          )
        ).status,
      ).toBe(404);
    }
    expect(randomIdCalls).toBe(0);

    // Activation is the durable publication state. Its original prepare TTL
    // is no longer liveness authority, so the same scoped read must remain
    // issuable after that timestamp has elapsed.
    live.set(`${organizationId}\0reservation:activated`, {
      ...projection("reservation:activated"),
      status: "activated",
      expiresAt: new Date(START).toISOString(),
    });
    const activated = await call(
      enabled.fetch,
      "POST",
      path,
      { ...body, workerEndpointOriginReservationId: "reservation:activated" },
      writer.headers,
    );
    expect(activated.status).toBe(201);
    expect(randomIdCalls).toBe(1);

    live.set(`${organizationId}\0${reservation.reservationId}`, reservation);

    const issued = await call(enabled.fetch, "POST", path, body, writer.headers);
    expect(issued.status).toBe(201);
    expect(randomIdCalls).toBe(2);
    expect(issued.headers.get("cache-control")).toBe("private, no-store");
    const token = stringField(issued.body, "token");
    expect(stringField(issued.body, "expiresAt")).toBe(new Date(START + 300_000).toISOString());
    expect(reads.at(-1)).toEqual({
      organizationId,
      reservationId: reservation.reservationId,
    });
    if (!admission) throw new Error("self-host admission was not composed");
    const selfhostTokens = createTokenService({
      sql,
      issuer: ORIGIN,
      clock,
      keyCacheSeconds: 0,
      tenantRunCredentialAdmission: admission,
    });
    await expect(selfhostTokens.verifyTakoformTenantRunToken(token)).resolves.toMatchObject({
      organizationId,
      tenantRef: "space:exact",
      spaceRef: "space:exact",
      runRef: "run:exact",
      workerEndpointOriginReservationId: reservation.reservationId,
      mode: "tenant-run",
    });
    await expect(
      createTokenService({
        sql,
        issuer: ORIGIN,
        clock,
        keyCacheSeconds: 0,
      }).verifyTakoformTenantRunToken(token),
    ).rejects.toMatchObject({ code: "invalid_credential_authority" });
    expect(
      (
        await call(enabled.fetch, "POST", path, body, {
          authorization: `Bearer ${token}`,
        })
      ).status,
    ).toBe(401);

    const withoutReservation = await call(
      enabled.fetch,
      "POST",
      path,
      { spaceRef: "space:without-reservation", runRef: "run:without-reservation" },
      writer.headers,
    );
    expect(withoutReservation.status).toBe(201);
    expect(randomIdCalls).toBe(3);
    await expect(
      selfhostTokens.verifyTakoformTenantRunToken(stringField(withoutReservation.body, "token")),
    ).resolves.toMatchObject({
      organizationId,
      tenantRef: "space:without-reservation",
      spaceRef: "space:without-reservation",
      runRef: "run:without-reservation",
    });
  });

  test("uses one admitted tenant-run bearer for runtime-input preparation only inside its Space", async () => {
    const clock = () => new Date(START);
    const sql = createEphemeralSql();
    const ordinaryKey = await registerKey(sql, "ordinary-runtime-key");
    const credentialKey = await registerKey(sql, "selfhost-tenant-run-key");
    const sealKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    const runtimeInputs = createRuntimeInputAuthority({
      sql,
      sealKeys: { current: { keyId: "runtime-input-test-key", key: sealKey } },
      canonicalPublicOrigin: ORIGIN,
      clock,
    });
    const originReservations = reservationAuthority(async () => null);
    let credentialSequence = 0;
    const app = buildApp({
      sql,
      objects: createMemoryObjectStore(),
      identity,
      settlement,
      publicOrigin: ORIGIN,
      forms: [],
      hostForms: [],
      driver: new InMemoryTakoformResourceDriver(),
      offerings: [],
      signingKey: ordinaryKey,
      originReservations,
      runtimeInputs,
      selfhostTenantRunCredentialAuthority(reservations) {
        return createSelfhostTenantRunCredentials({
          issuer: ORIGIN,
          signingKey: credentialKey,
          ordinarySigningKeyId: ordinaryKey.keyId,
          runtimeGrantKeys: sql,
          originReservations: reservations,
          clock,
          randomId: () => `runtime_input_${++credentialSequence}`,
        });
      },
      clock,
    });

    const session = await call(app.fetch, "POST", "/v1/sessions", {
      provider: "github",
      assertion: "runtime-input-owner",
    });
    const sessionHeaders = {
      authorization: `Bearer ${stringField(session.body, "sessionToken")}`,
    };
    const organization = await call(
      app.fetch,
      "POST",
      "/v1/organizations",
      { name: "Runtime input owner" },
      sessionHeaders,
    );
    const organizationId = stringField(recordField(organization.body, "organization"), "id");
    const writer = await createApiKey(
      app.fetch,
      organizationId,
      sessionHeaders.authorization,
      "runtime-input-writer",
      ["resources:write"],
    );
    const issue = async (spaceRef: string, runRef: string) => {
      const response = await call(
        app.fetch,
        "POST",
        "/v1/selfhost/tenant-run-credentials",
        { spaceRef, runRef },
        writer.headers,
      );
      expect(response.status).toBe(201);
      return { authorization: `Bearer ${stringField(response.body, "token")}` };
    };
    const exactRun = await issue("space:exact", "run:one");
    const sameSpaceRun = await issue("space:exact", "run:two");
    const otherSpaceRun = await issue("space:other", "run:other");
    const operationKey = `tenant-run-runtime-input-${"a".repeat(32)}`;
    const path = `/v1/takoform/worker-runtime-input-preparations/${operationKey}`;
    const missingKey = `tenant-run-runtime-input-${"b".repeat(32)}`;
    const missingPath = `/v1/takoform/worker-runtime-input-preparations/${missingKey}`;
    const headers = (authorization: Readonly<Record<string, string>>, key = operationKey) => ({
      ...authorization,
      "idempotency-key": key,
    });

    // A valid admitted bearer reaches the value-free lookup. Absence is a 404,
    // not the API-key-only 401 that originally blocked the provider sequence.
    const missing = await call(
      app.fetch,
      "GET",
      missingPath,
      undefined,
      headers(exactRun, missingKey),
    );
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: "operation_not_found" } });

    const input = runtimeInputPreparationRequest("space:exact");
    const prepared = await call(app.fetch, "PUT", path, input, headers(exactRun));
    expect(prepared.status).toBe(200);
    expect(prepared.body).toMatchObject({ status: "prepared", operationKey });
    const [stored] = await sql.query(
      `SELECT organization_id, operation_key, space
       FROM worker_runtime_input_preparations
       WHERE organization_id = ? AND operation_key = ?`,
      [organizationId, operationKey],
    );
    expect(stored).toEqual({
      organization_id: organizationId,
      operation_key: operationKey,
      space: "space:exact",
    });

    // The canonical credential authority is one Space, not one runRef. A
    // second admitted credential for that Space has the same value-free view.
    expect((await call(app.fetch, "GET", path, undefined, headers(sameSpaceRun))).status).toBe(200);
    for (const denied of [
      await call(app.fetch, "GET", path, undefined, headers(otherSpaceRun)),
      await call(app.fetch, "PUT", path, input, headers(otherSpaceRun)),
    ]) {
      expect(denied.status).toBe(404);
      expect(denied.body).toMatchObject({ error: { code: "operation_not_found" } });
    }

    const foreignKey = `tenant-run-runtime-input-${"c".repeat(32)}`;
    const foreignPath = `/v1/takoform/worker-runtime-input-preparations/${foreignKey}`;
    const crossSpacePut = await call(
      app.fetch,
      "PUT",
      foreignPath,
      runtimeInputPreparationRequest("space:other"),
      headers(exactRun, foreignKey),
    );
    expect(crossSpacePut.status).toBe(404);
    expect(crossSpacePut.body).toMatchObject({ error: { code: "operation_not_found" } });
    expect(
      await sql.query(
        "SELECT operation_key FROM worker_runtime_input_preparations WHERE operation_key = ?",
        [foreignKey],
      ),
    ).toHaveLength(0);

    expect((await call(app.fetch, "GET", path, undefined, headers(sessionHeaders))).status).toBe(
      403,
    );
    // Revocation remains an organization-writer operation; the run bearer can
    // prepare and recover but cannot broaden itself into administrative erase.
    expect((await call(app.fetch, "DELETE", path, undefined, headers(exactRun))).status).toBe(401);
    expect((await call(app.fetch, "DELETE", path, undefined, headers(writer.headers))).status).toBe(
      204,
    );
  });
});

describe("self-host tenant-run credential cryptographic admission", () => {
  test("pins the dedicated kid and 300-second lifetime, then follows active-key cache revocation", async () => {
    let now = START;
    const clock = () => new Date(now);
    const sql = createEphemeralSql();
    const ordinaryKey = await registerKey(sql, "ordinary-runtime-key");
    const credentialKey = await registerKey(sql, "selfhost-tenant-run-key");
    const authority = createSelfhostTenantRunCredentials({
      issuer: ORIGIN,
      signingKey: credentialKey,
      ordinarySigningKeyId: ordinaryKey.keyId,
      runtimeGrantKeys: sql,
      originReservations: reservationAuthority(async () => null),
      clock,
      randomId: () => "credential_crypto_01",
    });
    const claims = {
      organizationId: "org:exact",
      tenantRef: "space:exact",
      spaceRef: "space:exact",
      runRef: "run:exact",
      issuedAtEpochSeconds: Math.floor(START / 1_000),
      tokenId: "credential_crypto_01",
    } as const;
    const tokens = createTokenService({
      sql,
      issuer: ORIGIN,
      clock,
      keyCacheSeconds: 10,
      tenantRunCredentialAdmission: authority,
    });

    const ordinary = await rawTenantRunToken(ordinaryKey, claims, 300);
    await expect(tokens.verifyTakoformTenantRunToken(ordinary)).rejects.toMatchObject({
      code: "invalid_credential_authority",
    });
    const oversized = await rawTenantRunToken(credentialKey, claims, 301);
    await expect(tokens.verifyTakoformTenantRunToken(oversized)).rejects.toMatchObject({
      code: "invalid_credential_authority",
    });
    const accepted = await rawTenantRunToken(credentialKey, claims, 300);
    await expect(tokens.verifyTakoformTenantRunToken(accepted)).resolves.toMatchObject({
      runRef: "run:exact",
    });

    await sql.run("UPDATE runtime_grant_keys SET revoked_at_epoch_seconds = ? WHERE key_id = ?", [
      Math.floor(now / 1_000),
      credentialKey.keyId,
    ]);
    now += 9_000;
    await expect(tokens.verifyTakoformTenantRunToken(accepted)).resolves.toMatchObject({
      runRef: "run:exact",
    });
    now += 1_000;
    await expect(tokens.verifyTakoformTenantRunToken(accepted)).rejects.toMatchObject({
      code: "unknown_key",
    });

    const freshSql = createEphemeralSql();
    const freshKey = await registerKey(freshSql, "selfhost-tenant-run-fresh");
    const freshAuthority = createSelfhostTenantRunCredentials({
      issuer: ORIGIN,
      signingKey: freshKey,
      ordinarySigningKeyId: "ordinary-other-key",
      runtimeGrantKeys: freshSql,
      originReservations: reservationAuthority(async () => null),
      clock,
      randomId: () => "credential_expired_01",
    });
    const expired = await rawTenantRunToken(
      freshKey,
      { ...claims, issuedAtEpochSeconds: Math.floor(now / 1_000) - 300 },
      300,
    );
    await expect(
      createTokenService({
        sql: freshSql,
        issuer: ORIGIN,
        clock,
        keyCacheSeconds: 0,
        tenantRunCredentialAdmission: freshAuthority,
      }).verifyTakoformTenantRunToken(expired),
    ).rejects.toMatchObject({ code: "token_expired" });
  });

  test("refuses to compose the ordinary runtime signing identity as the credential authority", async () => {
    const sql = createEphemeralSql();
    const key = await registerKey(sql, "same-runtime-key");
    expect(() =>
      createSelfhostTenantRunCredentials({
        issuer: ORIGIN,
        signingKey: key,
        ordinarySigningKeyId: key.keyId,
        runtimeGrantKeys: sql,
        originReservations: reservationAuthority(async () => null),
        clock: () => new Date(START),
        randomId: () => "credential_never_01",
      }),
    ).toThrow("must differ");
  });

  test("issues only while the dedicated private key matches its exact active registry row", async () => {
    const sql = createEphemeralSql();
    const ordinaryKey = await registerKey(sql, "ordinary-runtime-key");
    const credentialKey = await registerKey(sql, "selfhost-tenant-run-key");
    const unrelatedKey = await registerKey(sql, "unrelated-runtime-key");
    const [credentialRegistration] = await sql.query(
      "SELECT public_jwk FROM runtime_grant_keys WHERE key_id = ?",
      [credentialKey.keyId],
    );
    const [unrelatedRegistration] = await sql.query(
      "SELECT public_jwk FROM runtime_grant_keys WHERE key_id = ?",
      [unrelatedKey.keyId],
    );
    if (!credentialRegistration || !unrelatedRegistration) {
      throw new Error("missing runtime grant key fixture");
    }
    let randomIdCalls = 0;
    const authority = createSelfhostTenantRunCredentials({
      issuer: ORIGIN,
      signingKey: credentialKey,
      ordinarySigningKeyId: ordinaryKey.keyId,
      runtimeGrantKeys: sql,
      originReservations: reservationAuthority(async () => null),
      clock: () => new Date(START),
      randomId: () => {
        randomIdCalls += 1;
        return `credential_registry_${randomIdCalls}`;
      },
    });
    const input = {
      organizationId: "org:exact",
      spaceRef: "space:exact",
      runRef: "run:exact",
    } as const;

    await sql.run("UPDATE runtime_grant_keys SET public_jwk = ? WHERE key_id = ?", [
      unrelatedRegistration.public_jwk as string,
      credentialKey.keyId,
    ]);
    await expect(authority.issue(input)).rejects.toThrow("exact active runtime grant key");
    expect(randomIdCalls).toBe(0);

    await sql.run(
      "UPDATE runtime_grant_keys SET public_jwk = ?, revoked_at_epoch_seconds = ? WHERE key_id = ?",
      [credentialRegistration.public_jwk as string, Math.floor(START / 1_000), credentialKey.keyId],
    );
    await expect(authority.issue(input)).rejects.toThrow("exact active runtime grant key");
    expect(randomIdCalls).toBe(0);

    const rotatedKey = await registerKey(sql, "selfhost-tenant-run-key-rotated");
    const rotated = createSelfhostTenantRunCredentials({
      issuer: ORIGIN,
      signingKey: rotatedKey,
      ordinarySigningKeyId: ordinaryKey.keyId,
      runtimeGrantKeys: sql,
      originReservations: reservationAuthority(async () => null),
      clock: () => new Date(START),
      randomId: () => "credential_rotated_01",
    });
    await expect(rotated.issue(input)).resolves.toMatchObject({
      expiresAt: new Date(START + 300_000).toISOString(),
    });
  });
});

async function registerKey(sql: Sql, keyId: string): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  await sql.run(
    `INSERT INTO runtime_grant_keys (key_id, public_jwk, created_at_epoch_seconds)
     VALUES (?, ?, ?)`,
    [keyId, JSON.stringify({ kty: "OKP", crv: "Ed25519", x: publicJwk.x }), 0],
  );
  return { keyId, privateKey: pair.privateKey };
}

function projection(reservationId: string): WorkerEndpointOriginReservationProjection {
  return {
    format: "takoserver.worker-endpoint-origin-reservation.v2",
    reservationId,
    requestedSubdomain: "exact",
    canonicalPublicOrigin: "https://exact.workers.test",
    revision: "1",
    expiresAt: new Date(START + 600_000).toISOString(),
    status: "prepared",
  };
}

function runtimeInputPreparationRequest(space: string): Record<string, unknown> {
  const workerVersion = currentTakoformCandidates().forms.find(
    (form) => form.identity.formRef.kind === "WorkerVersion",
  );
  if (!workerVersion) throw new Error("WorkerVersion candidate is missing");
  const formRef = workerVersion.identity.formRef;
  const name = "app-v1";
  const publicBody = JSON.stringify({
    apiVersion: formRef.apiVersion,
    kind: formRef.kind,
    form: {
      formRef,
      ...(workerVersion.identity.packageDigest
        ? { packageDigest: workerVersion.identity.packageDigest }
        : {}),
    },
    metadata: { name, space },
    spec: {},
    review: { prepareDigest: `sha256:${"d".repeat(64)}` },
  });
  return {
    format: "takoserver.worker-runtime-input-preparation@v2",
    canonicalPublicOrigin: ORIGIN,
    publicApply: {
      method: "PUT",
      path: `/apis/forms.takoform.com/v1/resources/${formRef.apiVersion}/${formRef.kind}/${name}`,
      fences: { ifNoneMatch: "*" },
      body: publicBody,
    },
    bindings: { ENCRYPTION_KEY: "placeholder-encryption-value" },
  };
}

function reservationAuthority(
  read: WorkerEndpointOriginReservations["read"],
): WorkerEndpointOriginReservations {
  return { read } as WorkerEndpointOriginReservations;
}

async function rawTenantRunToken(
  key: SigningKey,
  claims: {
    readonly organizationId: string;
    readonly tenantRef: string;
    readonly spaceRef: string;
    readonly runRef: string;
    readonly issuedAtEpochSeconds: number;
    readonly tokenId: string;
  },
  ttlSeconds: number,
): Promise<string> {
  const encode = (value: unknown) =>
    base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
  const header = encode({ alg: "EdDSA", kid: key.keyId, typ: "takoserver-token+jwt" });
  const payload = encode({
    aud: "takoform.run",
    exp: claims.issuedAtEpochSeconds + ttlSeconds,
    iat: claims.issuedAtEpochSeconds,
    iss: ORIGIN,
    jti: claims.tokenId,
    mode: "tenant-run",
    nbf: claims.issuedAtEpochSeconds,
    organizationId: claims.organizationId,
    runRef: claims.runRef,
    spaceRef: claims.spaceRef,
    tenantRef: claims.tenantRef,
  });
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "Ed25519",
    key.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function createApiKey(
  fetch: (request: Request) => Promise<Response>,
  organizationId: string,
  sessionAuthorization: string,
  name: string,
  scopes: readonly string[],
): Promise<{ readonly headers: { readonly authorization: string } }> {
  const created = await call(
    fetch,
    "POST",
    `/v1/organizations/${organizationId}/api-keys`,
    { name, scopes, expiresInSeconds: 3_600 },
    { authorization: sessionAuthorization },
  );
  expect(created.status).toBe(201);
  return { headers: { authorization: `Bearer ${stringField(created.body, "secret")}` } };
}

async function call(
  fetch: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<{
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}> {
  const response = await fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

function stringField(value: Record<string, unknown>, key: string): string {
  const found = value[key];
  if (typeof found !== "string") throw new Error(`missing ${key}`);
  return found;
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const found = value[key];
  if (!found || typeof found !== "object" || Array.isArray(found)) {
    throw new Error(`missing ${key}`);
  }
  return found as Record<string, unknown>;
}
