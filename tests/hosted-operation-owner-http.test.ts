import { describe, expect, test } from "bun:test";
import { createStaticTestTakoformHost } from "../src/app.ts";
import {
  createEphemeralSql,
  createMemoryObjectStore,
  InMemoryTakoformResourceDriver,
  type InstalledTakoformForm,
} from "../src/index.ts";
import { canonicalDigest } from "../src/json.ts";
import { createSponsorshipCredentialIssuer } from "../src/sponsorship-credential.ts";
import { buildHistoricalTakoformApp } from "./helpers/historical-takoform-host.ts";
import { TEST_TAKOFORM_V2_CONFIG } from "./helpers/takoform-v2-config.ts";

const origin = "https://api.takoserver.com";
const lane = "/apis/forms.takoform.com/v1";
const formRef = {
  apiVersion: "example.forms.invalid",
  kind: "RecoveryThing",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}` as const,
};
const form: InstalledTakoformForm = {
  identity: { formRef },
  desiredSchema: { type: "object", properties: {}, additionalProperties: false },
  operations: ["create", "read", "update", "delete"],
};

describe("Hosted logical operation owner through the public Host", () => {
  test("a fresh admitted Run resumes the same Capsule, but foreign owners cannot poll or cancel", async () => {
    let now = Date.UTC(2026, 8, 27, 12, 0, 0);
    const clock = () => new Date(now);
    const sql = createEphemeralSql();
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const keyId = "hosted-operation-owner-test";
    await sql.run(
      "INSERT INTO runtime_grant_keys (key_id, public_jwk, created_at_epoch_seconds) VALUES (?, ?, ?)",
      [keyId, JSON.stringify({ kty: "OKP", crv: "Ed25519", x: jwk.x }), 0],
    );
    const issuer = createSponsorshipCredentialIssuer({
      issuer: origin,
      signingKey: { keyId, privateKey: pair.privateKey },
      clock,
    });
    const app = buildHistoricalTakoformApp({
      v2: TEST_TAKOFORM_V2_CONFIG,
      sql,
      objects: createMemoryObjectStore(),
      identity: {
        async verify() {
          throw new Error("identity verification is outside this fixture");
        },
      },
      settlement: {
        async verify() {
          throw new Error("settlement verification is outside this fixture");
        },
      },
      publicOrigin: origin,
      forms: [form],
      hostForms: [form],
      driver: new InMemoryTakoformResourceDriver(),
      offerings: [],
      clock,
      takoformHostFactory: (options) =>
        createStaticTestTakoformHost({
          ...options,
          deferredOperations: {
            shouldDefer: () => true,
            pollsBeforeCommit: 2,
            retryAfterSeconds: 0,
            executeOnAccept: false,
          },
        }),
    });
    const issue = async (
      tokenId: string,
      runRef: string,
      logicalPrincipalRef: string,
      organizationId = "org_a",
      spaceRef = "space_a",
      tenantRef = "workspace_a",
    ) => {
      const issuedAtEpochSeconds = Math.floor(now / 1_000);
      const ttlSeconds = 300;
      const input = {
        organizationId,
        tenantRef,
        spaceRef,
        runRef,
        logicalPrincipalRef,
        issuedAtEpochSeconds,
        tokenId,
        ttlSeconds,
      };
      const credential = await issuer.issue(input);
      const operationId = await canonicalDigest({ kind: "test-issuance-operation", tokenId });
      const inputDigest = await canonicalDigest({ kind: "test-issuance-input", tokenId });
      const requestDigest = await canonicalDigest({ kind: "test-issuance-request", tokenId });
      const nonceDigest = await canonicalDigest({ kind: "test-issuance-nonce", tokenId });
      await sql.run(
        `INSERT INTO sponsorship_credential_issuance_operations
           (issuance_operation_id, input_sha256, request_sha256, request_nonce_sha256,
            token_id, org_id, tenant_ref, hosted_version_id,
            issued_at_epoch_seconds, expires_at_epoch_seconds, credential_key_id,
            receipt_key_id, authority_version_id, authority_source_commit,
            authority_artifact_sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          operationId,
          inputDigest,
          requestDigest,
          nonceDigest,
          tokenId,
          organizationId,
          input.tenantRef,
          "00000000-0000-4000-8000-000000000001",
          issuedAtEpochSeconds,
          issuedAtEpochSeconds + ttlSeconds,
          keyId,
          "test-receipt-key",
          "00000000-0000-4000-8000-000000000002",
          "a".repeat(40),
          await canonicalDigest({ kind: "test-artifact" }),
          clock().toISOString(),
        ],
      );
      return { authorization: `Bearer ${credential.token}` };
    };
    const request = (path: string, authorization: string, init: RequestInit = {}) =>
      app.fetch(
        new Request(`${origin}${path}`, {
          ...init,
          headers: { authorization, ...init.headers },
        }),
      );

    const first = await issue("tok_first", "run_first", "tshlp_capsule_a");
    const desired = {
      apiVersion: formRef.apiVersion,
      kind: formRef.kind,
      form: { formRef },
      metadata: { space: "space_a", name: "recovery" },
      spec: {},
    };
    const prepared = await request(`${lane}/resources/prepare`, first.authorization, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(desired),
    });
    expect(prepared.status).toBe(200);
    const review = (await prepared.json()) as { review: { prepareDigest: string } };
    const accepted = await request(
      `${lane}/resources/${formRef.apiVersion}/${formRef.kind}/recovery`,
      first.authorization,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "hosted-capsule-recovery-0001",
          "if-none-match": "*",
        },
        body: JSON.stringify({ ...desired, review: review.review }),
      },
    );
    expect(accepted.status).toBe(202);
    const acceptedBody = (await accepted.json()) as { operation: { id: string } };
    const path = `${lane}/operations/${acceptedBody.operation.id}`;
    now += 301_000;

    const next = await issue("tok_next", "run_next", "tshlp_capsule_a");
    const otherCapsule = await issue("tok_other_capsule", "run_other", "tshlp_capsule_b");
    const otherWorkspace = await issue(
      "tok_other_workspace",
      "run_other_workspace",
      "tshlp_capsule_a",
      "org_a",
      "space_b",
      "workspace_b",
    );
    expect((await request(path, first.authorization)).status).toBe(401);
    expect((await request(path, otherCapsule.authorization)).status).toBe(404);
    expect((await request(path, otherWorkspace.authorization)).status).toBe(404);
    for (const foreign of [otherCapsule, otherWorkspace]) {
      expect(
        (await request(`${path}/cancel`, foreign.authorization, { method: "POST" })).status,
      ).toBe(404);
    }
    const resumed = await request(path, next.authorization);
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ id: acceptedBody.operation.id });
    await sql.run("UPDATE runtime_grant_keys SET revoked_at_epoch_seconds = ? WHERE key_id = ?", [
      Math.floor(now / 1_000),
      keyId,
    ]);
    now += 11_000;
    expect((await request(path, next.authorization)).status).toBe(401);
  });
});
