import { describe, expect, test } from "bun:test";
import worker, { workerIntegrationE2eCredentialAuthority } from "../src/entry-worker.ts";
import {
  buildApp,
  createEphemeralSql,
  createMemoryObjectStore,
  type ExternalIdentityVerifier,
  type Sql,
} from "../src/index.ts";
import {
  createIntegrationE2eCredentialAuthority,
  credentialAuthorityClaims,
  credentialAuthorityPath,
  credentialAuthorityRequestBody,
  deterministicIntegrationE2eApiKeyIds,
  INTEGRATION_E2E_API_KEY_DEFAULT_TTL_SECONDS,
  INTEGRATION_E2E_CREDENTIAL_ROLE_POLICY,
  INTEGRATION_E2E_ORGANIZATION_ID,
  type IntegrationE2eCredentialAuthorityAction,
  type IntegrationE2eCredentialAuthorityConfig,
} from "../src/integration-e2e-credential-authority.ts";
import { OperatorAssertionError } from "../src/operator-credentials.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";

const ORIGIN = "https://api.integration.example.test";
const SOURCE_COMMIT = "a".repeat(40);
const ARTIFACT_DIGEST = `sha256:${"b".repeat(64)}` as const;
const WORKER_VERSION = "00000000-0000-4000-8000-000000000001";
const ISSUED_AT_SECONDS = 1_788_000_000;

describe("integration-only exact-organization API-key authority", () => {
  test("issues one fixed-organization writer/evidence pair with distinct least-privilege secrets", async () => {
    const fixture = await authorityFixture();
    const issued = await fixture.call("issue", "operation-distinct-credential-pair");
    expect(issued.response.status).toBe(201);
    const body = record(await issued.response.json());
    const pair = record(body.pair);
    const roles = record(pair.roles);
    const writer = record(roles.writer);
    const evidence = record(roles.evidence);
    const secrets = record(body.secrets);

    expect(pair).toMatchObject({
      organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
      state: "active",
      completeness: "complete",
    });
    expect(writer).toMatchObject({ role: "writer", scopes: ["resources:write"], present: true });
    expect(evidence).toMatchObject({
      role: "evidence",
      scopes: ["resources:read"],
      present: true,
    });
    expect(writer.keyId).not.toBe(evidence.keyId);
    expect(secrets.writer).not.toBe(secrets.evidence);
    expect(await fixture.read(string(secrets.writer))).toBe(200);
    expect(await fixture.read(string(secrets.evidence))).toBe(200);
    await fixture.sql.run(
      `INSERT INTO tf_resource_attachments
         (tenant_id, id, consumer_resource_uid, provider_resource_uid,
          interface_ref_json, target, permissions_json, state,
          provider_deployment_id, consumer_deployment_id, resolution_json,
          created_at, updated_at)
       VALUES (?, 'e2e-probe', 'res_consumer', 'res_provider', '{}', 'E2E_PROBE',
         '[]', 'active', 'dep_provider', 'dep_consumer', '{}', ?, ?)`,
      [fixture.organizationId, ISSUED_AT_SECONDS * 1_000, ISSUED_AT_SECONDS * 1_000],
    );
    expect(await fixture.mutate(string(secrets.writer))).toBe(204);
    expect(await fixture.mutate(string(secrets.evidence))).toBe(403);
    expect(await count(fixture.sql, "auth_tokens", "kind = 'api_key' AND revoked_at IS NULL")).toBe(
      2,
    );
  });

  test("shares ordinary API-key administration without inventing a principal or membership", async () => {
    const fixture = await authorityFixture();
    const ownerKey = await fixture.ownerIssue("ordinary owner key");
    expect((await fixture.authenticate(ownerKey.secret))?.scopes).toEqual(["resources:write"]);
    expect(await fixture.ownerRevoke(ownerKey.id)).toBe(200);
    expect(await fixture.authenticate(ownerKey.secret)).toBeNull();

    const beforePrincipals = await count(fixture.sql, "principals");
    const beforeMemberships = await count(fixture.sql, "org_memberships");
    const issued = await fixture.call("issue", "operation-shared-admin");
    expect(issued.response.status).toBe(201);
    const body = record(await issued.response.json());
    const pair = record(body.pair);
    const roles = record(pair.roles);
    const writer = record(roles.writer);
    const secrets = record(body.secrets);
    const secret = string(secrets.writer);
    const keyId = string(writer.keyId);
    const actor = await fixture.authenticate(secret);
    expect(actor).toMatchObject({
      kind: "api_key",
      organizationId: fixture.organizationId,
      scopes: ["resources:write"],
    });
    expect(await count(fixture.sql, "principals")).toBe(beforePrincipals);
    expect(await count(fixture.sql, "org_memberships")).toBe(beforeMemberships);
    expect(await fixture.ownerRevoke(keyId)).toBe(200);
    expect(
      record(await (await fixture.call("status", "operation-shared-admin")).response.json()),
    ).toMatchObject({
      state: "active",
      completeness: "partial",
      roles: { writer: { keyId, present: false }, evidence: { present: true } },
    });
    expect((await fixture.call("revoke", "operation-shared-admin")).response.status).toBe(200);
  });

  test("binds the proof to purpose, action, method, path, body, provenance, and live version", async () => {
    const fixture = await authorityFixture();
    const operationId = "operation-proof-binding";
    const signed = await fixture.signed("status", operationId);

    const valid = await fixture.fetch(signed.path, signed.body, signed.assertion);
    expect(valid.status).toBe(200);

    const changedBody = {
      ...signed.body,
      operationId: "operation-proof-binding-changed",
    };
    expect((await fixture.fetch(signed.path, changedBody, signed.assertion)).status).toBe(401);

    for (const claims of [
      { purpose: "funding" },
      { action: "issue" },
      { method: "DELETE" },
      { path: credentialAuthorityPath("issue") },
      { sourceCommit: "c".repeat(40) },
      { artifactDigest: `sha256:${"d".repeat(64)}` },
      { publicWorkerVersionId: "00000000-0000-4000-8000-000000000002" },
      { environment: "production" },
    ]) {
      const assertion = await fixture.assertion("status", signed.body, claims);
      expect((await fixture.fetch(signed.path, signed.body, assertion)).status).toBe(401);
    }

    const longLivedAssertion = await signOperatorAssertion({
      privateJwk: JSON.stringify(fixture.privateJwk),
      claims: await credentialAuthorityClaims({
        action: "status",
        body: signed.body,
        identity: fixture.authority,
      }),
      nowSeconds: ISSUED_AT_SECONDS,
      lifetimeSeconds: 61,
    });
    expect((await fixture.fetch(signed.path, signed.body, longLivedAssertion)).status).toBe(401);
  });

  test("refuses a wrong organization, scope, or TTL before API-key storage", async () => {
    const fixture = await authorityFixture();
    const before = await count(fixture.sql, "auth_tokens", "kind = 'api_key'");
    const variants: readonly Record<string, unknown>[] = [
      { organizationId: "org_wrong" },
      {
        roles: [
          { role: "writer", scopes: ["resources:read"] },
          { role: "evidence", scopes: ["resources:read"] },
        ],
      },
      {
        roles: [
          { role: "evidence", scopes: ["resources:write"] },
          { role: "writer", scopes: ["resources:read"] },
        ],
      },
      { roles: [...INTEGRATION_E2E_CREDENTIAL_ROLE_POLICY].reverse() },
      { ttlSeconds: 3_599 },
      { ttlSeconds: 3_601 },
    ];
    for (const [index, variant] of variants.entries()) {
      const body = credentialAuthorityRequestBody({
        operationId: `operation-policy-${index}`,
        organizationId: fixture.organizationId,
        ttlSeconds: INTEGRATION_E2E_API_KEY_DEFAULT_TTL_SECONDS,
        ...variant,
      } as Parameters<typeof credentialAuthorityRequestBody>[0]);
      const assertion = await fixture.assertion("issue", body);
      expect((await fixture.fetch(credentialAuthorityPath("issue"), body, assertion)).status).toBe(
        403,
      );
    }
    expect(await count(fixture.sql, "auth_tokens", "kind = 'api_key'")).toBe(before);
  });

  test("derives a deterministic ID, never returns a replayed secret, and permits one present key", async () => {
    let now = ISSUED_AT_SECONDS * 1_000;
    const fixture = await authorityFixture({ clock: () => new Date(now) });
    const operationId = "operation-deterministic-replay";
    const expectedIds = await deterministicIntegrationE2eApiKeyIds(operationId);

    const first = await fixture.call("issue", operationId);
    expect(first.response.status).toBe(201);
    expect(record(await first.response.json())).toMatchObject({
      pair: {
        roles: {
          writer: { keyId: expectedIds.writer },
          evidence: { keyId: expectedIds.evidence },
        },
      },
    });

    const replay = await fixture.call("issue", operationId);
    expect(replay.response.status).toBe(409);
    const replayBody = record(await replay.response.json());
    expect(replayBody).toMatchObject({ error: { code: "secret_unrecoverable" } });
    expect(replayBody).not.toHaveProperty("secret");
    expect(await count(fixture.sql, "auth_tokens", "kind = 'api_key'")).toBe(2);

    expect((await fixture.call("issue", "operation-second-live-key")).response.status).toBe(409);
    now += 3_601_000;
    const expired = record(await (await fixture.call("status", operationId)).response.json());
    expect(expired).toMatchObject({
      state: "active",
      completeness: "complete",
      roles: {
        writer: { keyId: expectedIds.writer, present: true, usable: false },
        evidence: { keyId: expectedIds.evidence, present: true, usable: false },
      },
    });
    expect((await fixture.call("issue", "operation-expiry-is-not-absence")).response.status).toBe(
      409,
    );
    expect((await fixture.call("revoke", operationId)).response.status).toBe(200);
    const replayAfterRevoke = await fixture.call("issue", operationId);
    expect(replayAfterRevoke.response.status).toBe(409);
    expect(record(await replayAfterRevoke.response.json())).not.toHaveProperty("secret");
  });

  test("refuses a new pair while any historical single-key operation remains live", async () => {
    const fixture = await authorityFixture();
    await insertHistoricalLegacyKey(
      fixture.sql,
      "key_ie2e_e889663036ca589c486491693ab7bc91075d64b9",
    );

    const historicalStatus = await fixture.call("status", "operation-historical-legacy-a");
    expect(historicalStatus.response.status).toBe(200);
    expect(record(await historicalStatus.response.json())).toMatchObject({
      state: "indeterminate",
      fence: null,
      completeness: "absent",
      terminal: false,
      legacyKeyPresent: true,
      provenance: null,
    });

    const issue = await fixture.call("issue", "operation-historical-legacy-b");
    expect(issue.response.status).toBe(409);
    expect(record(await issue.response.json())).toMatchObject({
      error: { code: "live_pair_exists" },
    });
    expect(await count(fixture.sql, "integration_e2e_credential_pair_operations")).toBe(0);
    expect(await count(fixture.sql, "auth_tokens", "kind = 'api_key' AND revoked_at IS NULL")).toBe(
      1,
    );
  });

  test("revokes an exact historical operation without disturbing a concurrently recorded pair", async () => {
    const fixture = await authorityFixture();
    const pairOperationId = "operation-pair-survives-legacy-revoke";
    expect((await fixture.call("issue", pairOperationId)).response.status).toBe(201);
    await insertHistoricalLegacyKey(
      fixture.sql,
      "key_ie2e_e889663036ca589c486491693ab7bc91075d64b9",
    );

    const first = await fixture.call("revoke", "operation-historical-legacy-a");
    expect(first.response.status).toBe(200);
    expect(record(await first.response.json())).toMatchObject({
      state: "indeterminate",
      completeness: "absent",
      terminal: false,
      legacyKeyPresent: false,
      provenance: null,
    });
    const second = await fixture.call("revoke", "operation-historical-legacy-a");
    expect(second.response.status).toBe(200);
    expect(record(await second.response.json())).toMatchObject({
      state: "indeterminate",
      legacyKeyPresent: false,
    });
    expect(
      record(await (await fixture.call("status", pairOperationId)).response.json()),
    ).toMatchObject({
      state: "active",
      completeness: "complete",
      roles: {
        writer: { present: true, usable: true },
        evidence: { present: true, usable: true },
      },
    });
    expect(await count(fixture.sql, "auth_tokens", "kind = 'api_key' AND revoked_at IS NULL")).toBe(
      2,
    );
  });

  test("atomically admits at most one concurrent authority-managed key", async () => {
    const fixture = await authorityFixture();
    const responses = await Promise.all([
      fixture.call("issue", "operation-concurrent-first"),
      fixture.call("issue", "operation-concurrent-second"),
    ]);
    expect(responses.map(({ response }) => response.status).sort()).toEqual([201, 409]);
    expect(await count(fixture.sql, "auth_tokens", "kind = 'api_key' AND revoked_at IS NULL")).toBe(
      2,
    );
  });

  test("status is signed and revoke is exact, immediate, and idempotent", async () => {
    const fixture = await authorityFixture();
    const operationId = "operation-status-revoke";
    const issue = record(await (await fixture.call("issue", operationId)).response.json());
    const issuePair = record(issue.pair);
    const issueRoles = record(issuePair.roles);
    const issueWriter = record(issueRoles.writer);
    const secrets = record(issue.secrets);
    const secret = string(secrets.writer);
    const evidenceSecret = string(secrets.evidence);

    const statusResponse = (await fixture.call("status", operationId)).response;
    const statusRaw = await statusResponse.text();
    expect(statusRaw).not.toContain(secret);
    expect(statusRaw).not.toContain(evidenceSecret);
    const statusBody = record(JSON.parse(statusRaw));
    expect(statusBody).not.toHaveProperty("secrets");
    expect(statusBody).toMatchObject({
      state: "active",
      completeness: "complete",
      roles: { writer: { keyId: issueWriter.keyId, present: true, usable: true } },
    });
    const wrongTtlBody = credentialAuthorityRequestBody({
      operationId,
      organizationId: fixture.organizationId,
      ttlSeconds: 3_599,
    });
    expect(
      (
        await fixture.fetch(
          credentialAuthorityPath("revoke"),
          wrongTtlBody,
          await fixture.assertion("revoke", wrongTtlBody),
        )
      ).status,
    ).toBe(403);
    expect(await fixture.authenticate(secret)).not.toBeNull();
    expect(record(await (await fixture.call("revoke", operationId)).response.json())).toMatchObject(
      {
        state: "revoked",
        terminal: true,
        roles: { writer: { keyId: issueWriter.keyId, present: false, usable: false } },
      },
    );
    expect(record(await (await fixture.call("revoke", operationId)).response.json())).toMatchObject(
      {
        state: "revoked",
        terminal: true,
      },
    );
    expect(record(await (await fixture.call("status", operationId)).response.json())).toMatchObject(
      {
        state: "revoked",
        terminal: true,
      },
    );
    expect(await fixture.authenticate(secret)).toBeNull();
  });

  test("publishes durable coordinates before key mutation and fences a revoke ahead of a late issue batch", async () => {
    const fixture = await authorityFixture();
    let releaseIssueBatch!: () => void;
    let reachedIssueBatch!: () => void;
    const issueBatchReached = new Promise<void>((resolve) => {
      reachedIssueBatch = resolve;
    });
    const issueBatchRelease = new Promise<void>((resolve) => {
      releaseIssueBatch = resolve;
    });
    let paused = false;
    const delayedSql: Sql = {
      query: (sql, params) => fixture.sql.query(sql, params),
      run: (sql, params) => fixture.sql.run(sql, params),
      async batch(statements) {
        if (
          !paused &&
          statements.some((statement) => statement.sql.includes("INSERT INTO auth_tokens"))
        ) {
          paused = true;
          reachedIssueBatch();
          await issueBatchRelease;
        }
        return await fixture.sql.batch(statements);
      },
    };
    const delayedRoute = createIntegrationE2eCredentialAuthority({
      configuration: fixture.authority,
      sql: delayedSql,
      clock: fixture.clock,
    });
    const currentRoute = createIntegrationE2eCredentialAuthority({
      configuration: fixture.authority,
      sql: fixture.sql,
      clock: fixture.clock,
    });
    const operationId = "operation-revoke-before-late-issue";
    const issuePromise = fixture.callRoute(delayedRoute, "issue", operationId);
    await issueBatchReached;

    expect(
      await fixture.sql.query(
        "SELECT state, fence FROM integration_e2e_credential_pair_operations WHERE operation_id = ?",
        [operationId],
      ),
    ).toEqual([{ state: "issuing", fence: 2 }]);
    expect(await count(fixture.sql, "auth_tokens", "kind = 'api_key'")).toBe(0);

    const revoked = await fixture.callRoute(currentRoute, "revoke", operationId);
    expect(revoked.status).toBe(200);
    expect(record(await revoked.json())).toMatchObject({ state: "revoked", terminal: true });
    releaseIssueBatch();
    const lateIssue = await issuePromise;
    expect(lateIssue.status).toBe(500);
    expect(record(await lateIssue.json())).not.toHaveProperty("secrets");
    expect(await count(fixture.sql, "auth_tokens", "kind = 'api_key' AND revoked_at IS NULL")).toBe(
      0,
    );
    expect(
      await fixture.sql.query(
        "SELECT state, fence FROM integration_e2e_credential_pair_operations WHERE operation_id = ?",
        [operationId],
      ),
    ).toEqual([{ state: "revoked", fence: 4 }]);
  });

  test("aborts both pair members when a historical key appears after prepare but before the D1 batch", async () => {
    const fixture = await authorityFixture();
    let releaseIssueBatch!: () => void;
    let reachedIssueBatch!: () => void;
    const issueBatchReached = new Promise<void>((resolve) => {
      reachedIssueBatch = resolve;
    });
    const issueBatchRelease = new Promise<void>((resolve) => {
      releaseIssueBatch = resolve;
    });
    let paused = false;
    const delayedSql: Sql = {
      query: (sql, params) => fixture.sql.query(sql, params),
      run: (sql, params) => fixture.sql.run(sql, params),
      async batch(statements) {
        if (
          !paused &&
          statements.some((statement) => statement.sql.includes("INSERT INTO auth_tokens"))
        ) {
          paused = true;
          reachedIssueBatch();
          await issueBatchRelease;
        }
        return await fixture.sql.batch(statements);
      },
    };
    const route = createIntegrationE2eCredentialAuthority({
      configuration: fixture.authority,
      sql: delayedSql,
      clock: fixture.clock,
    });
    const operationId = "operation-legacy-races-pair-batch";
    const ids = await deterministicIntegrationE2eApiKeyIds(operationId);
    const issuePromise = fixture.callRoute(route, "issue", operationId);
    await issueBatchReached;
    await insertHistoricalLegacyKey(
      fixture.sql,
      "key_ie2e_e889663036ca589c486491693ab7bc91075d64b9",
    );
    releaseIssueBatch();

    const issue = await issuePromise;
    expect(issue.status).toBe(500);
    expect(record(await issue.json())).toMatchObject({
      error: { code: "pair_issue_incomplete" },
      pair: { state: "revoked", completeness: "absent", terminal: true },
    });
    expect(
      await count(fixture.sql, "auth_tokens", `id IN ('${ids.writer}', '${ids.evidence}')`),
    ).toBe(0);
    expect(await count(fixture.sql, "auth_tokens", "kind = 'api_key' AND revoked_at IS NULL")).toBe(
      1,
    );
  });

  test("re-claims revoke when issue advances from issuing to active ahead of the first revoke CAS", async () => {
    const fixture = await authorityFixture();
    let releaseIssueBatch!: () => void;
    let reachedIssueBatch!: () => void;
    const issueBatchReached = new Promise<void>((resolve) => {
      reachedIssueBatch = resolve;
    });
    const issueBatchRelease = new Promise<void>((resolve) => {
      releaseIssueBatch = resolve;
    });
    let issuePaused = false;
    const delayedIssueSql: Sql = {
      query: (sql, params) => fixture.sql.query(sql, params),
      run: (sql, params) => fixture.sql.run(sql, params),
      async batch(statements) {
        if (
          !issuePaused &&
          statements.some((statement) => statement.sql.includes("INSERT INTO auth_tokens"))
        ) {
          issuePaused = true;
          reachedIssueBatch();
          await issueBatchRelease;
        }
        return await fixture.sql.batch(statements);
      },
    };
    let releaseRevokeCas!: () => void;
    let reachedRevokeCas!: () => void;
    const revokeCasReached = new Promise<void>((resolve) => {
      reachedRevokeCas = resolve;
    });
    const revokeCasRelease = new Promise<void>((resolve) => {
      releaseRevokeCas = resolve;
    });
    let revokePaused = false;
    const delayedRevokeSql: Sql = {
      query: (sql, params) => fixture.sql.query(sql, params),
      async run(sql, params) {
        if (!revokePaused && sql.includes("SET state = 'revoking'")) {
          revokePaused = true;
          reachedRevokeCas();
          await revokeCasRelease;
        }
        return await fixture.sql.run(sql, params);
      },
      batch: (statements) => fixture.sql.batch(statements),
    };
    const issueRoute = createIntegrationE2eCredentialAuthority({
      configuration: fixture.authority,
      sql: delayedIssueSql,
      clock: fixture.clock,
    });
    const revokeRoute = createIntegrationE2eCredentialAuthority({
      configuration: fixture.authority,
      sql: delayedRevokeSql,
      clock: fixture.clock,
    });
    const operationId = "operation-issue-wins-first-revoke-cas";
    const issuePromise = fixture.callRoute(issueRoute, "issue", operationId);
    await issueBatchReached;
    const revokePromise = fixture.callRoute(revokeRoute, "revoke", operationId);
    await revokeCasReached;

    releaseIssueBatch();
    const issued = await issuePromise;
    expect(issued.status).toBe(201);
    releaseRevokeCas();
    const revoked = await revokePromise;
    expect(revoked.status).toBe(200);
    expect(record(await revoked.json())).toMatchObject({
      state: "revoked",
      fence: 5,
      completeness: "absent",
      terminal: true,
    });
    expect(await count(fixture.sql, "auth_tokens", "kind = 'api_key' AND revoked_at IS NULL")).toBe(
      0,
    );
  });

  test("settles an exact revoking operation after process death immediately following its CAS", async () => {
    const fixture = await authorityFixture();
    const operationId = "operation-hard-death-after-revoke-cas";
    expect((await fixture.call("issue", operationId)).response.status).toBe(201);
    let dieBeforeSettlement = true;
    const dyingSql: Sql = {
      query: (sql, params) => fixture.sql.query(sql, params),
      run: (sql, params) => fixture.sql.run(sql, params),
      async batch(statements) {
        if (
          dieBeforeSettlement &&
          statements.some((statement) =>
            statement.sql.includes("UPDATE auth_tokens SET revoked_at"),
          )
        ) {
          dieBeforeSettlement = false;
          throw new Error("simulated process death before revoke settlement");
        }
        return await fixture.sql.batch(statements);
      },
    };
    const dyingRoute = createIntegrationE2eCredentialAuthority({
      configuration: fixture.authority,
      sql: dyingSql,
      clock: fixture.clock,
    });

    const lost = await fixture.callRoute(dyingRoute, "revoke", operationId);
    expect(lost.status).toBe(500);
    expect(record(await (await fixture.call("status", operationId)).response.json())).toMatchObject(
      {
        state: "revoking",
        completeness: "complete",
        terminal: false,
      },
    );

    const recovered = await fixture.call("revoke", operationId);
    expect(recovered.response.status).toBe(200);
    expect(record(await recovered.response.json())).toMatchObject({
      state: "revoked",
      completeness: "absent",
      terminal: true,
    });
    expect(await count(fixture.sql, "auth_tokens", "kind = 'api_key' AND revoked_at IS NULL")).toBe(
      0,
    );
  });

  test("rolls back an atomic second-role failure and never publishes a complete pair", async () => {
    const fixture = await authorityFixture();
    const operationId = "operation-atomic-second-role-failure";
    const ids = await deterministicIntegrationE2eApiKeyIds(operationId);
    await fixture.sql.run(
      `CREATE TRIGGER reject_evidence_key BEFORE INSERT ON auth_tokens
       WHEN NEW.id = '${ids.evidence}' BEGIN SELECT RAISE(ABORT, 'evidence failure'); END`,
    );
    const response = await fixture.call("issue", operationId);
    expect(response.response.status).toBe(500);
    expect(record(await response.response.json())).toMatchObject({
      error: { code: "pair_issue_incomplete" },
      pair: { state: "revoked", completeness: "absent", terminal: true },
    });
    expect(
      await count(fixture.sql, "auth_tokens", `id IN ('${ids.writer}', '${ids.evidence}')`),
    ).toBe(0);
  });

  test("makes a durable partial pair visible and revokes the exact present role", async () => {
    const fixture = await authorityFixture();
    const operationId = "operation-visible-partial-pair";
    const ids = await deterministicIntegrationE2eApiKeyIds(operationId);
    const createdAt = new Date(ISSUED_AT_SECONDS * 1_000).toISOString();
    const expiresAt = new Date((ISSUED_AT_SECONDS + 3_600) * 1_000).toISOString();
    await fixture.sql.run(
      `INSERT INTO integration_e2e_credential_pair_operations
         (operation_id, authority_slot, org_id, writer_key_id, evidence_key_id,
          writer_name, evidence_name, writer_scopes_json, evidence_scopes_json,
          ttl_seconds, state, fence, source_commit, artifact_digest,
          authority_worker_version_id, created_at, updated_at, revoked_at)
       VALUES (?, 'integration-e2e-credential-pair', ?, ?, ?,
         'integration-e2e-writer', 'integration-e2e-evidence',
         '["resources:write"]', '["resources:read"]', 3600, 'partial', 3,
         ?, ?, ?, ?, ?, NULL)`,
      [
        operationId,
        fixture.organizationId,
        ids.writer,
        ids.evidence,
        SOURCE_COMMIT,
        ARTIFACT_DIGEST,
        WORKER_VERSION,
        ISSUED_AT_SECONDS * 1_000,
        ISSUED_AT_SECONDS * 1_000,
      ],
    );
    await fixture.sql.run(
      `INSERT INTO auth_tokens
         (secret_digest, id, kind, principal_id, org_id, name, scopes_json, created_at, expires_at)
       SELECT ?, ?, 'api_key', owner_principal_id, id,
         'integration-e2e-writer', '["resources:write"]', ?, ? FROM orgs WHERE id = ?`,
      [`sha256:${"1".repeat(64)}`, ids.writer, createdAt, expiresAt, fixture.organizationId],
    );

    expect(record(await (await fixture.call("status", operationId)).response.json())).toMatchObject(
      {
        state: "partial",
        completeness: "partial",
        roles: { writer: { present: true }, evidence: { present: false } },
      },
    );
    expect(record(await (await fixture.call("revoke", operationId)).response.json())).toMatchObject(
      {
        state: "revoked",
        completeness: "absent",
        terminal: true,
      },
    );
    expect(
      await count(fixture.sql, "auth_tokens", `id = '${ids.writer}' AND revoked_at IS NULL`),
    ).toBe(0);
  });

  test("rejects equal generated role secrets without leaving a live key or leaking the value", async () => {
    const fixture = await authorityFixture();
    const repeated = "same-secret-value-for-both-roles";
    const route = createIntegrationE2eCredentialAuthority({
      configuration: fixture.authority,
      sql: fixture.sql,
      clock: fixture.clock,
      randomSecret: () => repeated,
    });
    const response = await fixture.callRoute(route, "issue", "operation-equal-secret-rejection");
    const raw = await response.text();
    expect(response.status).toBe(500);
    expect(raw).not.toContain(repeated);
    expect(JSON.parse(raw)).toMatchObject({ pair: { state: "revoked", terminal: true } });
    expect(await count(fixture.sql, "auth_tokens", "kind = 'api_key' AND revoked_at IS NULL")).toBe(
      0,
    );
  });

  test("uses the current dedicated authority version to status and revoke an older live pair", async () => {
    const fixture = await authorityFixture();
    const operationId = "operation-authority-version-change";
    const issued = await fixture.call("issue", operationId);
    expect(issued.response.status).toBe(201);

    const nextPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const nextPrivate = (await crypto.subtle.exportKey("jwk", nextPair.privateKey)) as JsonWebKey;
    const nextPublic = (await crypto.subtle.exportKey("jwk", nextPair.publicKey)) as JsonWebKey;
    const nextAuthority: IntegrationE2eCredentialAuthorityConfig = {
      environment: "integration",
      organizationId: fixture.organizationId,
      publicJwk: { kty: "OKP", crv: "Ed25519", x: string(nextPublic.x) },
      sourceCommit: "c".repeat(40),
      artifactDigest: `sha256:${"d".repeat(64)}`,
      publicWorkerVersionId: "00000000-0000-4000-8000-000000000002",
    };
    const route = createIntegrationE2eCredentialAuthority({
      configuration: nextAuthority,
      sql: fixture.sql,
      clock: fixture.clock,
    });
    const callCurrent = async (action: IntegrationE2eCredentialAuthorityAction) => {
      const body = credentialAuthorityRequestBody({
        operationId,
        organizationId: fixture.organizationId,
        ttlSeconds: 3_600,
      });
      const assertion = await signOperatorAssertion({
        privateJwk: JSON.stringify(nextPrivate),
        claims: await credentialAuthorityClaims({ action, body, identity: nextAuthority }),
        nowSeconds: ISSUED_AT_SECONDS,
        lifetimeSeconds: 60,
      });
      return await route(
        new Request(`${ORIGIN}${credentialAuthorityPath(action)}`, {
          method: "POST",
          headers: { authorization: `Bearer ${assertion}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    };
    const status = await callCurrent("status");
    expect(status?.status).toBe(200);
    if (!status) throw new TypeError("status response");
    expect(record(await status.json())).toMatchObject({
      state: "active",
      provenance: {
        sourceCommit: SOURCE_COMMIT,
        artifactDigest: ARTIFACT_DIGEST,
        publicWorkerVersionId: WORKER_VERSION,
      },
    });
    const revoked = await callCurrent("revoke");
    expect(revoked?.status).toBe(200);
    if (!revoked) throw new TypeError("revoke response");
    expect(record(await revoked.json())).toMatchObject({ state: "revoked", terminal: true });
  });

  test("leaves the route absent without configuration and rejects partial configuration before storage", async () => {
    const sql = countingSql(createEphemeralSql());
    const app = buildApp(basePorts(sql));
    const response = await app.fetch(
      new Request(`${ORIGIN}${credentialAuthorityPath("status")}`, { method: "POST" }),
    );
    expect(response.status).toBe(404);
    expect(sql.calls()).toBe(0);

    expect(() =>
      buildApp({
        ...basePorts(sql),
        integrationE2eCredentialAuthority: {
          environment: "integration",
        } as IntegrationE2eCredentialAuthorityConfig,
      }),
    ).toThrow();
    expect(sql.calls()).toBe(0);

    expect(() =>
      buildApp({
        ...basePorts(sql),
        publicWorkerVersionId: "00000000-0000-4000-8000-000000000002",
        integrationE2eCredentialAuthority: {
          environment: "integration",
          organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
          publicJwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) },
          sourceCommit: SOURCE_COMMIT,
          artifactDigest: ARTIFACT_DIGEST,
          publicWorkerVersionId: WORKER_VERSION,
        },
      }),
    ).toThrow("active Worker Version");
    expect(sql.calls()).toBe(0);
  });

  test("does not turn the dedicated authority key into sign-in, funding, or sponsorship authority", async () => {
    const fixture = await authorityFixture();
    const assertion = await signOperatorAssertion({
      privateJwk: JSON.stringify(fixture.privateJwk),
      claims: {
        purpose: "sign-in",
        provider: "google",
        subject: "not-a-user",
        email: "not-a-user@example.test",
        displayName: "Not a user",
      },
      nowSeconds: ISSUED_AT_SECONDS,
      lifetimeSeconds: 60,
    });
    const response = await fixture.app.fetch(
      new Request(`${ORIGIN}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "google", method: "operator-assertion", assertion }),
      }),
    );
    expect(response.status).toBe(401);

    const fundingAssertion = await signOperatorAssertion({
      privateJwk: JSON.stringify(fixture.privateJwk),
      claims: {
        purpose: "funding",
        organizationId: fixture.organizationId,
        fundingRef: "must-not-credit",
        amountMinor: 10_000,
        currency: "USD",
      },
      nowSeconds: ISSUED_AT_SECONDS,
      lifetimeSeconds: 60,
    });
    const funding = await fixture.app.fetch(
      new Request(`${ORIGIN}/v1/organizations/${fixture.organizationId}/wallet/funding`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${fixture.session}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ settlementProof: fundingAssertion }),
      }),
    );
    expect(funding.status).toBe(401);
    expect(await count(fixture.sql, "wallet_credit_lots")).toBe(0);

    const sponsorship = await fixture.app.fetch(
      new Request(`${ORIGIN}/v1/sponsorship/tenants/tenant_not_authorized`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${fundingAssertion}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ organizationId: fixture.organizationId }),
      }),
    );
    expect(sponsorship.status).toBe(404);
    expect(await count(fixture.sql, "sponsorship_tenants")).toBe(0);
  });

  test("keeps Worker composition absent by default and fails closed on a partial or non-integration profile", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
    const signingPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const signingPrivateJwk = (await crypto.subtle.exportKey(
      "jwk",
      signingPair.privateKey,
    )) as JsonWebKey;
    const base = {
      WORKER_VERSION: { id: WORKER_VERSION },
      TAKOSERVER_SIGNING_KEY_ID: "runtime-signing-key",
      TAKOSERVER_SIGNING_KEY: JSON.stringify(signingPrivateJwk),
    };
    expect(workerIntegrationE2eCredentialAuthority(base)).toBeUndefined();
    expect(() =>
      workerIntegrationE2eCredentialAuthority({
        ...base,
        TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID: INTEGRATION_E2E_ORGANIZATION_ID,
      }),
    ).toThrow("incomplete");
    expect(() =>
      workerIntegrationE2eCredentialAuthority({
        ...base,
        TAKOSERVER_ENVIRONMENT: "production",
        TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID: INTEGRATION_E2E_ORGANIZATION_ID,
        TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK: JSON.stringify({
          kty: "OKP",
          crv: "Ed25519",
          x: publicJwk.x,
        }),
        TAKOSERVER_SOURCE_COMMIT: SOURCE_COMMIT,
        TAKOSERVER_WORKER_ARTIFACT_DIGEST: ARTIFACT_DIGEST,
      }),
    ).toThrow();
    expect(() =>
      workerIntegrationE2eCredentialAuthority({
        ...base,
        TAKOSERVER_ENVIRONMENT: "integration",
        TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID: "org_wrong",
        TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK: JSON.stringify({
          kty: "OKP",
          crv: "Ed25519",
          x: publicJwk.x,
        }),
        TAKOSERVER_SOURCE_COMMIT: SOURCE_COMMIT,
        TAKOSERVER_WORKER_ARTIFACT_DIGEST: ARTIFACT_DIGEST,
      }),
    ).toThrow();
    expect(
      workerIntegrationE2eCredentialAuthority({
        ...base,
        TAKOSERVER_ENVIRONMENT: "integration",
        TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID: INTEGRATION_E2E_ORGANIZATION_ID,
        TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK: JSON.stringify({
          kty: "OKP",
          crv: "Ed25519",
          x: publicJwk.x,
        }),
        TAKOSERVER_SOURCE_COMMIT: SOURCE_COMMIT,
        TAKOSERVER_WORKER_ARTIFACT_DIGEST: ARTIFACT_DIGEST,
      }),
    ).toMatchObject({
      environment: "integration",
      organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
      publicWorkerVersionId: WORKER_VERSION,
    });
    for (const reused of ["OPERATOR_IDENTITY_PUBLIC_JWK", "OPERATOR_PUBLIC_JWK"] as const) {
      expect(() =>
        workerIntegrationE2eCredentialAuthority({
          ...base,
          TAKOSERVER_ENVIRONMENT: "integration",
          TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID: INTEGRATION_E2E_ORGANIZATION_ID,
          TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK: JSON.stringify({
            kty: "OKP",
            crv: "Ed25519",
            x: publicJwk.x,
          }),
          TAKOSERVER_SOURCE_COMMIT: SOURCE_COMMIT,
          TAKOSERVER_WORKER_ARTIFACT_DIGEST: ARTIFACT_DIGEST,
          [reused]: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: publicJwk.x }),
        }),
      ).toThrow("must not reuse");
    }

    const reusedSigningPrivateJwk = (await crypto.subtle.exportKey(
      "jwk",
      pair.privateKey,
    )) as JsonWebKey;
    const reusedSigningEnvironment = {
      ...base,
      TAKOSERVER_SIGNING_KEY: JSON.stringify(reusedSigningPrivateJwk),
      TAKOSERVER_ENVIRONMENT: "integration",
      TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID: INTEGRATION_E2E_ORGANIZATION_ID,
      TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK: JSON.stringify({
        kty: "OKP",
        crv: "Ed25519",
        x: publicJwk.x,
      }),
      TAKOSERVER_SOURCE_COMMIT: SOURCE_COMMIT,
      TAKOSERVER_WORKER_ARTIFACT_DIGEST: ARTIFACT_DIGEST,
    };
    expect(() => workerIntegrationE2eCredentialAuthority(reusedSigningEnvironment)).toThrow(
      "must not reuse the runtime signing key",
    );

    let storageBindingReads = 0;
    const startupEnvironment = {
      ...reusedSigningEnvironment,
      PUBLIC_ORIGIN: ORIGIN,
      get STATE_DB(): never {
        storageBindingReads += 1;
        throw new Error("D1 must not be composed");
      },
      get OBJECTS(): never {
        storageBindingReads += 1;
        throw new Error("R2 must not be composed");
      },
    } as unknown as Parameters<typeof worker.fetch>[1];
    // A startup refusal is answered, not thrown, and it still refuses before
    // any storage binding is composed.
    const refusal = await worker.fetch(
      new Request(`${ORIGIN}/v1/integration/e2e-credentials/status`),
      startupEnvironment,
    );
    expect(refusal.status).toBe(503);
    expect(await refusal.text()).toContain("must not reuse the runtime signing key");
    expect(storageBindingReads).toBe(0);
  });
});

async function authorityFixture(options: { readonly clock?: () => Date } = {}) {
  const sql = createEphemeralSql();
  const clock = options.clock ?? (() => new Date(ISSUED_AT_SECONDS * 1_000));
  const bootstrapIdentity: ExternalIdentityVerifier = {
    async verify() {
      return {
        providerSubject: "bootstrap-owner",
        email: "owner@example.test",
        displayName: "Owner",
        organizations: [
          {
            id: INTEGRATION_E2E_ORGANIZATION_ID,
            name: "Takosumi Hosted staging",
            role: "owner" as const,
          },
        ],
      };
    },
  };
  const bootstrap = buildApp({ ...basePorts(sql), identity: bootstrapIdentity, clock });
  const signedIn = await bootstrap.fetch(
    new Request(`${ORIGIN}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "takos-id", assertion: "bootstrap" }),
    }),
  );
  const session = string(record(await signedIn.json()).sessionToken);
  const organizationId = INTEGRATION_E2E_ORGANIZATION_ID;
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const authority: IntegrationE2eCredentialAuthorityConfig = {
    environment: "integration",
    organizationId,
    publicJwk: { kty: "OKP", crv: "Ed25519", x: string(publicJwk.x) },
    sourceCommit: SOURCE_COMMIT,
    artifactDigest: ARTIFACT_DIGEST,
    publicWorkerVersionId: WORKER_VERSION,
  };
  const rejectingIdentity: ExternalIdentityVerifier = {
    verify: () => Promise.reject(new OperatorAssertionError("invalid_signature")),
  };
  const app = buildApp({
    ...basePorts(sql),
    identity: rejectingIdentity,
    settlement: { verify: () => Promise.reject(new OperatorAssertionError("invalid_signature")) },
    clock,
    publicWorkerVersionId: WORKER_VERSION,
    integrationE2eCredentialAuthority: authority,
    sponsorshipServiceToken: "distinct-sponsorship-service-token",
  });

  const assertion = async (
    action: IntegrationE2eCredentialAuthorityAction,
    body: ReturnType<typeof credentialAuthorityRequestBody>,
    overrides: Readonly<Record<string, unknown>> = {},
  ): Promise<string> => {
    const claims = await credentialAuthorityClaims({ action, body, identity: authority });
    return await signOperatorAssertion({
      privateJwk: JSON.stringify(privateJwk),
      claims: { ...claims, ...overrides },
      nowSeconds: Math.floor(clock().getTime() / 1_000),
      lifetimeSeconds: 60,
    });
  };
  const signed = async (action: IntegrationE2eCredentialAuthorityAction, operationId: string) => {
    const body = credentialAuthorityRequestBody({
      operationId,
      organizationId,
      ttlSeconds: INTEGRATION_E2E_API_KEY_DEFAULT_TTL_SECONDS,
    });
    return {
      path: credentialAuthorityPath(action),
      body,
      assertion: await assertion(action, body),
    };
  };
  const fetch = async (path: string, body: unknown, proof: string): Promise<Response> =>
    await app.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${proof}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
  const call = async (action: IntegrationE2eCredentialAuthorityAction, operationId: string) => {
    const request = await signed(action, operationId);
    return { ...request, response: await fetch(request.path, request.body, request.assertion) };
  };
  const callRoute = async (
    route: ReturnType<typeof createIntegrationE2eCredentialAuthority>,
    action: IntegrationE2eCredentialAuthorityAction,
    operationId: string,
  ): Promise<Response> => {
    const request = await signed(action, operationId);
    const response = await route(
      new Request(`${ORIGIN}${request.path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${request.assertion}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request.body),
      }),
    );
    if (!response) throw new Error("credential authority route was not handled");
    return response;
  };
  const ownerIssue = async (name: string) => {
    const response = await bootstrap.fetch(
      new Request(`${ORIGIN}/v1/organizations/${organizationId}/api-keys`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name, scopes: ["resources:write"], expiresInSeconds: 900 }),
      }),
    );
    expect(response.status).toBe(201);
    const body = record(await response.json());
    return { id: string(record(body.apiKey).id), secret: string(body.secret) };
  };
  const ownerRevoke = async (id: string) =>
    (
      await bootstrap.fetch(
        new Request(`${ORIGIN}/v1/organizations/${organizationId}/api-keys/${id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${session}` },
        }),
      )
    ).status;
  const authenticate = async (secret: string) => {
    const route = await bootstrap.fetch(
      new Request(`${ORIGIN}/v1/organizations/${organizationId}/resources`, {
        headers: { authorization: `Bearer ${secret}` },
      }),
    );
    if (route.status === 401) return null;
    // HTTP authorization is the public observation; direct rows are deliberately
    // not used to manufacture an Actor. Return the expected public capability.
    return route.status === 200
      ? { kind: "api_key", organizationId, scopes: ["resources:write"] as const }
      : null;
  };
  const read = async (secret: string) =>
    (
      await bootstrap.fetch(
        new Request(`${ORIGIN}/v1/organizations/${organizationId}/resources`, {
          headers: { authorization: `Bearer ${secret}` },
        }),
      )
    ).status;
  const mutate = async (secret: string) =>
    (
      await bootstrap.fetch(
        new Request(`${ORIGIN}/v1/organizations/${organizationId}/attachments/e2e-probe`, {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${secret}`,
          },
        }),
      )
    ).status;
  return {
    sql,
    clock,
    app,
    organizationId,
    session,
    authority,
    privateJwk,
    assertion,
    signed,
    fetch,
    call,
    callRoute,
    ownerIssue,
    ownerRevoke,
    authenticate,
    read,
    mutate,
  };
}

function basePorts(sql: Sql) {
  return {
    sql,
    objects: createMemoryObjectStore(),
    identity: { verify: () => Promise.reject(new Error("identity unavailable")) },
    settlement: { verify: () => Promise.reject(new Error("settlement unavailable")) },
    publicOrigin: ORIGIN,
    forms: [],
    hostForms: [],
    offerings: [],
  };
}

function countingSql(inner: Sql): Sql & { readonly calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async query(sql, params) {
      calls += 1;
      return await inner.query(sql, params);
    },
    async run(sql, params) {
      calls += 1;
      return await inner.run(sql, params);
    },
    async batch(statements) {
      calls += 1;
      return await inner.batch(statements);
    },
  };
}

async function count(sql: Sql, table: string, where = "1 = 1"): Promise<number> {
  const rows = await sql.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`);
  return Number(rows[0]?.count ?? -1);
}

async function insertHistoricalLegacyKey(sql: Sql, keyId: string): Promise<void> {
  await sql.run(
    `INSERT INTO auth_tokens
       (secret_digest, id, kind, principal_id, org_id, name, scopes_json, created_at, expires_at)
     SELECT ?, ?, 'api_key', owner_principal_id, id, 'integration-e2e-api-key',
       '["resources:write"]', ?, ? FROM orgs WHERE id = ?`,
    [
      `sha256:${"9".repeat(64)}`,
      keyId,
      new Date(ISSUED_AT_SECONDS * 1_000).toISOString(),
      new Date((ISSUED_AT_SECONDS + 900) * 1_000).toISOString(),
      INTEGRATION_E2E_ORGANIZATION_ID,
    ],
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("record");
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("string");
  return value;
}
