import { describe, expect, test } from "bun:test";
import {
  buildApp,
  createEphemeralSql,
  createMemoryObjectStore,
  InMemoryTakoformResourceDriver,
} from "../src/index.ts";
import {
  createIntegrationOrganizationBootstrap,
  type IntegrationOrganizationBootstrapConfig,
  type IntegrationOrganizationBootstrapRequestBody,
  integrationOrganizationBootstrapClaims,
  integrationOrganizationBootstrapPath,
  integrationOrganizationBootstrapRequestBody,
} from "../src/integration-organization-bootstrap.ts";
import { canonicalDigest } from "../src/json.ts";
import { createOperatorIdentity } from "../src/operator-credentials.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";
import type { Sql } from "../src/ports.ts";

const ORIGIN = "https://api.integration.example.test";
const ORGANIZATION_ID = "org_takosumi_hosted_staging";
const ORGANIZATION_NAME = "Takosumi Hosted staging";
const PRINCIPAL_ID = "prn_integration_owner";
const SOURCE_COMMIT = "a".repeat(40);
const ARTIFACT_DIGEST = `sha256:${"b".repeat(64)}` as const;
const WORKER_VERSION_ID = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-12T12:00:00.000Z");
const OWNER = {
  provider: "google" as const,
  subject: "operator-subject",
  email: "operator@example.test",
  displayName: "Integration operator",
};

describe("integration organization bootstrap", () => {
  test("resolves an existing exact principal, creates the fixed owner tuple, and proves it through the owner route", async () => {
    const keyPair = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
    const exportedPublic = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    if (exportedPublic.kty !== "OKP" || exportedPublic.crv !== "Ed25519" || !exportedPublic.x) {
      throw new Error("test Ed25519 public key is unavailable");
    }
    const publicJwk = { kty: "OKP" as const, crv: "Ed25519" as const, x: exportedPublic.x };
    const sql = createEphemeralSql();
    await sql.run(
      `INSERT INTO principals (id, provider, provider_subject, email, display_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        PRINCIPAL_ID,
        OWNER.provider,
        OWNER.subject,
        OWNER.email,
        OWNER.displayName,
        NOW.toISOString(),
      ],
    );

    const app = buildApp({
      sql,
      objects: createMemoryObjectStore(),
      identity: createOperatorIdentity({
        publicKeyJwk: publicJwk,
        audience: ORIGIN,
        clock: () => NOW,
      }),
      settlement: {
        async verify() {
          throw new Error("not used");
        },
      },
      publicOrigin: ORIGIN,
      publicWorkerVersionId: WORKER_VERSION_ID,
      integrationOrganizationBootstrap: {
        environment: "integration",
        hostId: ORIGIN,
        publicJwk,
        sourceCommit: SOURCE_COMMIT,
        artifactDigest: ARTIFACT_DIGEST,
        publicWorkerVersionId: WORKER_VERSION_ID,
      },
      forms: [],
      hostForms: [],
      driver: new InMemoryTakoformResourceDriver(),
      offerings: [],
      clock: () => NOW,
    });

    const statusBody = {
      organizationId: ORGANIZATION_ID,
      organizationName: ORGANIZATION_NAME,
      owner: OWNER,
    };
    const status = await bootstrapRequest(
      app.fetch,
      keyPair.privateKey,
      "status",
      statusBody,
      null,
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      kind: "takoserver.integration-organization-bootstrap-status@v1",
      state: "eligible",
      organizationId: ORGANIZATION_ID,
      organizationName: ORGANIZATION_NAME,
      ownerPrincipalId: PRINCIPAL_ID,
      createdAt: null,
    });

    const applyBody = { ...statusBody, ownerPrincipalId: PRINCIPAL_ID };
    const applied = await bootstrapRequest(
      app.fetch,
      keyPair.privateKey,
      "apply",
      applyBody,
      PRINCIPAL_ID,
    );
    expect(applied.status).toBe(201);
    const appliedBody = (await applied.json()) as Readonly<Record<string, unknown>>;
    expect(appliedBody).toEqual({
      kind: "takoserver.integration-organization-bootstrap-status@v1",
      state: "present",
      organizationId: ORGANIZATION_ID,
      organizationName: ORGANIZATION_NAME,
      ownerPrincipalId: PRINCIPAL_ID,
      createdAt: NOW.toISOString(),
    });

    const ownerAssertion = await signOperatorAssertion({
      privateJwk: JSON.stringify(privateJwk),
      claims: {
        purpose: "sign-in",
        aud: ORIGIN,
        provider: OWNER.provider,
        subject: OWNER.subject,
        email: OWNER.email,
        displayName: OWNER.displayName,
      },
      nowSeconds: Math.floor(NOW.getTime() / 1_000),
      lifetimeSeconds: 60,
    });
    const proved = await app.fetch(
      new Request(`${ORIGIN}/v1/operator-owner-proof`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: OWNER.provider,
          method: "operator-assertion",
          assertion: ownerAssertion,
          organizationId: ORGANIZATION_ID,
        }),
      }),
    );
    expect(proved.status).toBe(200);
    expect(await proved.json()).toMatchObject({
      principal: { id: PRINCIPAL_ID },
      organization: {
        id: ORGANIZATION_ID,
        name: ORGANIZATION_NAME,
        ownerPrincipalId: PRINCIPAL_ID,
      },
    });
  });

  test("rejects every proof-binding drift and an alias origin before any database access", async () => {
    const base = await authorityFixture();
    const counted = countingSql(base.sql);
    const route = createIntegrationOrganizationBootstrap({
      configuration: base.configuration,
      sql: counted.sql,
      clock: () => NOW,
    });
    const wrongKey = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const cases: readonly {
      readonly claims?: Readonly<Record<string, unknown>>;
      readonly privateKey?: CryptoKey;
    }[] = [
      { claims: { purpose: "sign-in" } },
      { privateKey: wrongKey.privateKey },
      { claims: { aud: "https://alias.integration.example.test" } },
      { claims: { hostId: "https://alias.integration.example.test" } },
      { claims: { action: "apply" } },
      { claims: { method: "PUT" } },
      { claims: { path: integrationOrganizationBootstrapPath("apply") } },
      { claims: { bodyDigest: `sha256:${"0".repeat(64)}` } },
      { claims: { provider: "github" } },
      { claims: { subject: "other-subject" } },
      { claims: { email: "other@example.test" } },
      { claims: { displayName: "Other operator" } },
      { claims: { sourceCommit: "c".repeat(40) } },
      { claims: { artifactDigest: `sha256:${"d".repeat(64)}` } },
      {
        claims: { publicWorkerVersionId: "00000000-0000-4000-8000-000000000002" },
      },
      { claims: { unexpected: "value" } },
    ];
    for (const candidate of cases) {
      const response = await callBootstrap({
        route,
        configuration: base.configuration,
        privateKey: candidate.privateKey ?? base.keyPair.privateKey,
        action: "status",
        body: statusRequestBody(),
        ...(candidate.claims === undefined ? {} : { claims: candidate.claims }),
      });
      expect(response.response.status).toBe(401);
      expect(await response.response.json()).toMatchObject({
        error: { code: "unauthenticated", hostCode: "invalid_operator_assertion" },
      });
    }

    const alias = await callBootstrap({
      route,
      configuration: base.configuration,
      privateKey: base.keyPair.privateKey,
      action: "status",
      body: statusRequestBody(),
      origin: "https://alias.integration.example.test",
    });
    expect(alias.response.status).toBe(403);
    expect(await alias.response.json()).toMatchObject({
      error: { code: "permission_denied", hostCode: "operator_policy_mismatch" },
    });

    const overlong = await callBootstrap({
      route,
      configuration: base.configuration,
      privateKey: base.keyPair.privateKey,
      action: "status",
      body: statusRequestBody(),
      lifetimeSeconds: 61,
    });
    expect(overlong.response.status).toBe(401);
    expect(await overlong.response.json()).toMatchObject({
      error: { code: "unauthenticated", hostCode: "invalid_operator_assertion" },
    });
    expect(counted.counts).toEqual({ queries: 0, runs: 0, batches: 0 });
  });

  test("rejects the wrong fixed Organization policy before reads and never accepts a caller-chosen owner", async () => {
    const base = await authorityFixture();
    const counted = countingSql(base.sql);
    const route = createIntegrationOrganizationBootstrap({
      configuration: base.configuration,
      sql: counted.sql,
      clock: () => NOW,
    });
    for (const body of [
      { ...statusRequestBody(), organizationId: "org_attacker" },
      { ...statusRequestBody(), organizationName: "Attacker staging" },
    ]) {
      const response = await callBootstrap({
        route,
        configuration: base.configuration,
        privateKey: base.keyPair.privateKey,
        action: "status",
        body,
      });
      expect(response.response.status).toBe(403);
      expect(await response.response.json()).toMatchObject({
        error: { code: "permission_denied", hostCode: "operator_policy_mismatch" },
      });
    }
    expect(counted.counts).toEqual({ queries: 0, runs: 0, batches: 0 });

    const wrongPrincipal = await callBootstrap({
      route,
      configuration: base.configuration,
      privateKey: base.keyPair.privateKey,
      action: "apply",
      body: applyRequestBody("prn_attacker"),
    });
    expect(wrongPrincipal.response.status).toBe(409);
    expect(await wrongPrincipal.response.json()).toMatchObject({
      error: { code: "conflict", hostCode: "organization_state_conflict" },
    });
    expect(counted.counts.batches).toBe(0);
    expect(await rowCount(base.sql, "orgs", "id = ?", [ORGANIZATION_ID])).toBe(0);
  });

  test("requires one already-stored principal matching every asserted identity field", async () => {
    const absent = await authorityFixture({ seedPrincipal: false });
    const missing = await absent.call("status", statusRequestBody());
    expect(missing.response.status).toBe(409);
    expect(await missing.response.json()).toMatchObject({
      error: { code: "conflict", hostCode: "principal_unavailable" },
    });
    expect(await rowCount(absent.sql, "principals")).toBe(0);
    expect(await rowCount(absent.sql, "orgs")).toBe(0);

    const mismatch = await authorityFixture();
    for (const owner of [
      { ...OWNER, subject: "other-subject" },
      { ...OWNER, email: "other@example.test" },
      { ...OWNER, displayName: "Other operator" },
      { ...OWNER, provider: "github" as const },
    ]) {
      const response = await mismatch.call("status", { ...statusRequestBody(), owner });
      expect(response.response.status).toBe(409);
      expect(await response.response.json()).toMatchObject({
        error: { code: "conflict", hostCode: "principal_unavailable" },
      });
    }
    expect(await rowCount(mismatch.sql, "principals")).toBe(1);
    expect(await rowCount(mismatch.sql, "orgs")).toBe(0);
    expect(await rowCount(mismatch.sql, "auth_tokens")).toBe(0);
  });

  test("refuses foreign, drifted, Organization-only, membership-only, and partial tuples", async () => {
    const cases: readonly {
      readonly label: string;
      readonly seed: (sql: Sql) => Promise<void>;
    }[] = [
      {
        label: "foreign owner",
        seed: async (sql) => {
          await insertPrincipal(sql, "prn_foreign", {
            provider: "github",
            subject: "foreign-subject",
            email: "foreign@example.test",
            displayName: "Foreign owner",
          });
          await insertOrganization(sql, ORGANIZATION_NAME, "prn_foreign");
          await insertMembership(sql, "prn_foreign", "owner");
        },
      },
      {
        label: "name drift",
        seed: async (sql) => {
          await insertOrganization(sql, "Drifted staging", PRINCIPAL_ID);
          await insertMembership(sql, PRINCIPAL_ID, "owner");
        },
      },
      {
        label: "Organization only",
        seed: async (sql) => {
          await insertOrganization(sql, ORGANIZATION_NAME, PRINCIPAL_ID);
        },
      },
      {
        label: "membership only",
        seed: async (sql) => {
          await insertMembership(sql, PRINCIPAL_ID, "owner");
        },
      },
      {
        label: "wrong role",
        seed: async (sql) => {
          await insertOrganization(sql, ORGANIZATION_NAME, PRINCIPAL_ID);
          await insertMembership(sql, PRINCIPAL_ID, "member");
        },
      },
      {
        label: "second owner membership",
        seed: async (sql) => {
          await insertPrincipal(sql, "prn_foreign", {
            provider: "github",
            subject: "foreign-subject",
            email: "foreign@example.test",
            displayName: "Foreign owner",
          });
          await insertOrganization(sql, ORGANIZATION_NAME, PRINCIPAL_ID);
          await insertMembership(sql, PRINCIPAL_ID, "owner");
          await insertMembership(sql, "prn_foreign", "owner");
        },
      },
    ];
    for (const candidate of cases) {
      const fixture = await authorityFixture();
      await candidate.seed(fixture.sql);
      const before = {
        organizations: await rowCount(fixture.sql, "orgs"),
        memberships: await rowCount(fixture.sql, "org_memberships"),
      };
      const response = await fixture.call("status", statusRequestBody());
      expect(response.response.status).toBe(409);
      expect(await response.response.json()).toMatchObject({
        error: { code: "conflict", hostCode: "organization_state_conflict" },
      });
      expect(await rowCount(fixture.sql, "orgs")).toBe(before.organizations);
      expect(await rowCount(fixture.sql, "org_memberships")).toBe(before.memberships);
    }
  });

  test("lets one concurrent apply create the tuple and turns the exact loser into a no-op", async () => {
    const fixture = await authorityFixture();
    let releaseBatch!: () => void;
    let reachBatch!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachBatch = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    let paused = false;
    const delayedSql: Sql = {
      query: (sql, params) => fixture.sql.query(sql, params),
      run: (sql, params) => fixture.sql.run(sql, params),
      async batch(statements) {
        if (!paused) {
          paused = true;
          reachBatch();
          await release;
        }
        return await fixture.sql.batch(statements);
      },
    };
    const delayedRoute = createIntegrationOrganizationBootstrap({
      configuration: fixture.configuration,
      sql: delayedSql,
      clock: () => NOW,
    });
    const first = callBootstrap({
      route: delayedRoute,
      configuration: fixture.configuration,
      privateKey: fixture.keyPair.privateKey,
      action: "apply",
      body: applyRequestBody(PRINCIPAL_ID),
    });
    await reached;
    const second = await fixture.call("apply", applyRequestBody(PRINCIPAL_ID));
    releaseBatch();
    const firstResponse = await first;
    expect([firstResponse.response.status, second.response.status].sort()).toEqual([200, 201]);
    expect(await rowCount(fixture.sql, "orgs", "id = ?", [ORGANIZATION_ID])).toBe(1);
    expect(
      await rowCount(
        fixture.sql,
        "org_memberships",
        "org_id = ? AND principal_id = ? AND role = 'owner'",
        [ORGANIZATION_ID, PRINCIPAL_ID],
      ),
    ).toBe(1);
  });

  test("rolls back the Organization when the membership insert fails", async () => {
    const fixture = await authorityFixture();
    await fixture.sql.run(
      `CREATE TRIGGER reject_bootstrap_membership BEFORE INSERT ON org_memberships
       WHEN NEW.org_id = '${ORGANIZATION_ID}'
       BEGIN SELECT RAISE(ABORT, 'bootstrap membership failure'); END`,
    );
    const response = await fixture.call("apply", applyRequestBody(PRINCIPAL_ID));
    expect(response.response.status).toBe(503);
    expect(await response.response.json()).toMatchObject({
      error: { code: "unavailable", hostCode: "internal_error" },
    });
    expect(await rowCount(fixture.sql, "orgs", "id = ?", [ORGANIZATION_ID])).toBe(0);
    expect(await rowCount(fixture.sql, "org_memberships", "org_id = ?", [ORGANIZATION_ID])).toBe(0);
  });

  test("reports post-commit readback drift as unknown while retaining both rows", async () => {
    const fixture = await authorityFixture();
    const driftingReadbackSql: Sql = {
      query: (sql, params) => fixture.sql.query(sql, params),
      run: (sql, params) => fixture.sql.run(sql, params),
      async batch(statements) {
        const result = await fixture.sql.batch(statements);
        await fixture.sql.run("UPDATE principals SET email = ? WHERE id = ?", [
          "drifted@example.test",
          PRINCIPAL_ID,
        ]);
        return result;
      },
    };
    const route = createIntegrationOrganizationBootstrap({
      configuration: fixture.configuration,
      sql: driftingReadbackSql,
      clock: () => NOW,
    });
    const response = await callBootstrap({
      route,
      configuration: fixture.configuration,
      privateKey: fixture.keyPair.privateKey,
      action: "apply",
      body: applyRequestBody(PRINCIPAL_ID),
    });
    expect(response.response.status).toBe(503);
    expect(await response.response.json()).toMatchObject({
      error: { code: "unavailable", hostCode: "internal_error" },
    });
    expect(await rowCount(fixture.sql, "orgs", "id = ?", [ORGANIZATION_ID])).toBe(1);
    expect(
      await rowCount(
        fixture.sql,
        "org_memberships",
        "org_id = ? AND principal_id = ? AND role = 'owner'",
        [ORGANIZATION_ID, PRINCIPAL_ID],
      ),
    ).toBe(1);
  });

  test("does not retry a lost apply acknowledgement and lets signed status settle it", async () => {
    const fixture = await authorityFixture();
    let batches = 0;
    const lostAcknowledgementSql: Sql = {
      query: (sql, params) => fixture.sql.query(sql, params),
      run: (sql, params) => fixture.sql.run(sql, params),
      async batch(statements) {
        batches += 1;
        await fixture.sql.batch(statements);
        throw new Error("simulated lost acknowledgement");
      },
    };
    const route = createIntegrationOrganizationBootstrap({
      configuration: fixture.configuration,
      sql: lostAcknowledgementSql,
      clock: () => NOW,
    });
    const lost = await callBootstrap({
      route,
      configuration: fixture.configuration,
      privateKey: fixture.keyPair.privateKey,
      action: "apply",
      body: applyRequestBody(PRINCIPAL_ID),
    });
    expect(lost.response.status).toBe(503);
    expect(batches).toBe(1);

    const settled = await fixture.call("status", statusRequestBody());
    expect(settled.response.status).toBe(200);
    expect(await settled.response.json()).toEqual({
      kind: "takoserver.integration-organization-bootstrap-status@v1",
      state: "present",
      organizationId: ORGANIZATION_ID,
      organizationName: ORGANIZATION_NAME,
      ownerPrincipalId: PRINCIPAL_ID,
      createdAt: NOW.toISOString(),
    });
  });

  test("reads and reapplies an exact tuple without mutation or secret and identity echo", async () => {
    const fixture = await authorityFixture();
    const first = await fixture.call("apply", applyRequestBody(PRINCIPAL_ID));
    expect(first.response.status).toBe(201);
    await insertPrincipal(fixture.sql, "prn_unrelated_member", {
      provider: "github",
      subject: "unrelated-subject",
      email: "unrelated@example.test",
      displayName: "Unrelated member",
    });
    await insertMembership(fixture.sql, "prn_unrelated_member", "member");
    const repeated = await fixture.call("apply", applyRequestBody(PRINCIPAL_ID));
    expect(repeated.response.status).toBe(200);
    const status = await fixture.call("status", statusRequestBody());
    expect(status.response.status).toBe(200);
    expect(await rowCount(fixture.sql, "orgs", "id = ?", [ORGANIZATION_ID])).toBe(1);
    expect(await rowCount(fixture.sql, "org_memberships", "org_id = ?", [ORGANIZATION_ID])).toBe(2);
    expect(
      await rowCount(
        fixture.sql,
        "org_memberships",
        "org_id = ? AND principal_id = ? AND role = 'member'",
        [ORGANIZATION_ID, "prn_unrelated_member"],
      ),
    ).toBe(1);

    for (const result of [first, repeated, status]) {
      const raw = await result.response.clone().text();
      expect(raw).not.toContain(result.assertion);
      expect(raw).not.toContain(OWNER.subject);
      expect(raw).not.toContain(OWNER.email);
      expect(raw).not.toContain(OWNER.displayName);
      expect(raw).not.toContain(OWNER.provider);
      expect(raw).not.toMatch(/private|assertion|bodyDigest/u);
    }
  });

  test("rejects production and rehearsal configurations before storage or HTTP exists", async () => {
    const fixture = await authorityFixture();
    for (const environment of ["production", "rehearsal"] as const) {
      let databaseAccesses = 0;
      const refusingSql: Sql = {
        async query() {
          databaseAccesses += 1;
          throw new Error("database must not be reached");
        },
        async run() {
          databaseAccesses += 1;
          throw new Error("database must not be reached");
        },
        async batch() {
          databaseAccesses += 1;
          throw new Error("database must not be reached");
        },
      };
      expect(() =>
        createIntegrationOrganizationBootstrap({
          configuration: {
            ...fixture.configuration,
            environment,
          } as unknown as IntegrationOrganizationBootstrapConfig,
          sql: refusingSql,
          clock: () => NOW,
        }),
      ).toThrow("configuration_unavailable");
      expect(databaseAccesses).toBe(0);
    }
  });
});

async function bootstrapRequest(
  fetch: (request: Request) => Promise<Response>,
  privateKey: CryptoKey,
  action: "status" | "apply",
  body: unknown,
  ownerPrincipalId: string | null,
): Promise<Response> {
  const path = `/v1/operator/integration-e2e/organization-bootstrap/${action}`;
  const claims = {
    purpose: "integration-organization-bootstrap",
    aud: ORIGIN,
    action,
    method: "POST",
    path,
    bodyDigest: await canonicalDigest(body),
    environment: "integration",
    hostId: ORIGIN,
    sourceCommit: SOURCE_COMMIT,
    artifactDigest: ARTIFACT_DIGEST,
    publicWorkerVersionId: WORKER_VERSION_ID,
    organizationId: ORGANIZATION_ID,
    organizationName: ORGANIZATION_NAME,
    provider: OWNER.provider,
    subject: OWNER.subject,
    email: OWNER.email,
    displayName: OWNER.displayName,
    ownerPrincipalId,
  };
  const payload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({
        ...claims,
        iat: Math.floor(NOW.getTime() / 1_000),
        exp: Math.floor(NOW.getTime() / 1_000) + 60,
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(payload),
  );
  return await fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${payload}.${base64Url(new Uint8Array(signature))}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function authorityFixture(options: { readonly seedPrincipal?: boolean } = {}) {
  const keyPair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const exportedPublic = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  if (exportedPublic.kty !== "OKP" || exportedPublic.crv !== "Ed25519" || !exportedPublic.x) {
    throw new Error("test Ed25519 public key is unavailable");
  }
  const configuration = {
    environment: "integration" as const,
    hostId: ORIGIN,
    publicJwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: exportedPublic.x },
    sourceCommit: SOURCE_COMMIT,
    artifactDigest: ARTIFACT_DIGEST,
    publicWorkerVersionId: WORKER_VERSION_ID,
  } satisfies IntegrationOrganizationBootstrapConfig;
  const sql = createEphemeralSql();
  if (options.seedPrincipal !== false) await insertPrincipal(sql, PRINCIPAL_ID, OWNER);
  const route = createIntegrationOrganizationBootstrap({
    configuration,
    sql,
    clock: () => NOW,
  });
  return {
    sql,
    keyPair,
    configuration,
    route,
    async call(action: "status" | "apply", body: IntegrationOrganizationBootstrapRequestBody) {
      return await callBootstrap({
        route,
        configuration,
        privateKey: keyPair.privateKey,
        action,
        body,
      });
    },
  };
}

async function callBootstrap(input: {
  readonly route: (request: Request) => Promise<Response | null>;
  readonly configuration: IntegrationOrganizationBootstrapConfig;
  readonly privateKey: CryptoKey;
  readonly action: "status" | "apply";
  readonly body: IntegrationOrganizationBootstrapRequestBody;
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly origin?: string;
  readonly lifetimeSeconds?: number;
}): Promise<{ readonly response: Response; readonly assertion: string }> {
  const claims = {
    ...(await integrationOrganizationBootstrapClaims({
      action: input.action,
      body: input.body,
      identity: input.configuration,
    })),
    ...input.claims,
  };
  const assertion = await signOperatorAssertion({
    privateJwk: JSON.stringify(await crypto.subtle.exportKey("jwk", input.privateKey)),
    claims,
    nowSeconds: Math.floor(NOW.getTime() / 1_000),
    lifetimeSeconds: input.lifetimeSeconds ?? 60,
  });
  const response = await input.route(
    new Request(`${input.origin ?? ORIGIN}${integrationOrganizationBootstrapPath(input.action)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${assertion}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.body),
    }),
  );
  if (!response) throw new Error("bootstrap route did not recognize its exact path");
  return { response, assertion };
}

function statusRequestBody(): IntegrationOrganizationBootstrapRequestBody {
  return integrationOrganizationBootstrapRequestBody({ owner: OWNER });
}

function applyRequestBody(ownerPrincipalId: string): IntegrationOrganizationBootstrapRequestBody {
  return integrationOrganizationBootstrapRequestBody({ owner: OWNER, ownerPrincipalId });
}

async function insertPrincipal(
  sql: Sql,
  id: string,
  owner: IntegrationOrganizationBootstrapRequestBody["owner"],
): Promise<void> {
  await sql.run(
    `INSERT INTO principals (id, provider, provider_subject, email, display_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, owner.provider, owner.subject, owner.email, owner.displayName, NOW.toISOString()],
  );
}

async function insertOrganization(sql: Sql, name: string, ownerPrincipalId: string): Promise<void> {
  await sql.run("INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)", [
    ORGANIZATION_ID,
    name,
    ownerPrincipalId,
    NOW.toISOString(),
  ]);
}

async function insertMembership(
  sql: Sql,
  principalId: string,
  role: "owner" | "member",
): Promise<void> {
  await sql.run(
    "INSERT INTO org_memberships (org_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)",
    [ORGANIZATION_ID, principalId, role, NOW.toISOString()],
  );
}

async function rowCount(
  sql: Sql,
  table: "principals" | "orgs" | "org_memberships" | "auth_tokens",
  where?: string,
  params: readonly (string | number | null)[] = [],
): Promise<number> {
  const rows = await sql.query(
    `SELECT COUNT(*) AS count FROM ${table}${where === undefined ? "" : ` WHERE ${where}`}`,
    params,
  );
  return Number(rows[0]?.count);
}

function countingSql(inner: Sql): {
  readonly sql: Sql;
  readonly counts: { queries: number; runs: number; batches: number };
} {
  const counts = { queries: 0, runs: 0, batches: 0 };
  return {
    counts,
    sql: {
      async query(sql, params) {
        counts.queries += 1;
        return await inner.query(sql, params);
      },
      async run(sql, params) {
        counts.runs += 1;
        return await inner.run(sql, params);
      },
      async batch(statements) {
        counts.batches += 1;
        return await inner.batch(statements);
      },
    },
  };
}
