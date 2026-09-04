import { expect, test } from "bun:test";
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExactArtifactRecoveryRequest } from "../scripts/exact-artifact-recovery.ts";
import {
  ARTIFACT_RECOVERY_LINEAGE_DIGEST,
  ARTIFACT_RECOVERY_LINEAGE_MIGRATION,
  ARTIFACT_RECOVERY_LOST_ACK_FORMAT,
  ARTIFACT_RECOVERY_REQUEST_FORMAT,
  ARTIFACT_RECOVERY_RETENTION_FORMAT,
  type ArtifactRecoveryRequest,
  canonicalArtifactRecoveryRequest,
  parseArtifactRecoveryLostAckAuthorization,
} from "../src/artifact-recovery.ts";
import {
  deterministicIntegrationE2eApiKeyIds,
  INTEGRATION_E2E_ORGANIZATION_ID,
} from "../src/integration-e2e-credential-authority.ts";
import {
  handleIntegrationFormAuthorityGateway,
  type IntegrationFormAuthorityGatewayEnv,
} from "../src/integration-form-authority-gateway.ts";
import { canonicalDigest } from "../src/json.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";

const digest = (digit: string): `sha256:${string}` => `sha256:${digit.repeat(64)}`;

test("canonicalizes the exact incident set and derives one receipt per upload", async () => {
  const request = await recoveryRequest();
  const canonical = await canonicalArtifactRecoveryRequest(request);

  expect(canonical.request).toEqual(request);
  expect(canonical.requestDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(canonical.receipts).toHaveLength(5);
  expect(new Set(canonical.receipts.map(({ receiptId }) => receiptId)).size).toBe(5);
  expect(
    canonical.receipts.every(({ receiptId }) => /^recovery-receipt-[0-9a-f]{64}$/u.test(receiptId)),
  ).toBe(true);
});

test("validates the immutable lost-ack binding without a structural cast", () => {
  const common = {
    kind: ARTIFACT_RECOVERY_LOST_ACK_FORMAT,
    candidateOrdinal: 27,
    predecessorWorkerVersionId: "10000000-0000-4000-8000-000000000001",
    quiescenceEvidenceDigest: digest("a"),
  };
  expect(
    parseArtifactRecoveryLostAckAuthorization({
      ...common,
      resolution: { kind: "confirm-head-absent" },
    }),
  ).toEqual({ ...common, resolution: { kind: "confirm-head-absent" } });
  expect(
    parseArtifactRecoveryLostAckAuthorization({
      ...common,
      resolution: {
        kind: "reviewed-retry",
        observedEtag: '"etag"',
        operationId: "reviewed-retry-1",
        candidateFence: 2,
        reviewEvidenceDigest: digest("b"),
      },
    }),
  ).toMatchObject({ resolution: { kind: "reviewed-retry", candidateFence: 2 } });
  expect(() =>
    parseArtifactRecoveryLostAckAuthorization({
      ...common,
      unexpected: true,
      resolution: { kind: "confirm-head-absent" },
    }),
  ).toThrow();
  expect(() =>
    parseArtifactRecoveryLostAckAuthorization({
      ...common,
      candidateOrdinal: 28,
      resolution: { kind: "confirm-head-absent" },
    }),
  ).toThrow();
});

test("rejects group drift, caller closure claims, and non-E2E owners", async () => {
  const request = await recoveryRequest();
  await expect(
    canonicalArtifactRecoveryRequest({ ...request, uploads: [...request.uploads].reverse() }),
  ).rejects.toThrow("uploads must be canonically ordered");
  await expect(
    canonicalArtifactRecoveryRequest({
      ...request,
      owners: [
        { ...request.owners[0], principalId: "run:caller-asserted" },
        ...request.owners.slice(1),
      ],
    }),
  ).rejects.toThrow("integration E2E writer");
  await expect(
    canonicalArtifactRecoveryRequest({
      ...request,
      memberDigests: [
        request.memberDigests[0],
        request.memberDigests[0],
        ...request.memberDigests.slice(2),
      ],
    }),
  ).rejects.toThrow("memberDigests must be a sorted unique set");
  await expect(
    canonicalArtifactRecoveryRequest({ ...request, closedAt: Date.now() }),
  ).rejects.toThrow("unexpected or missing fields");
  await expect(
    canonicalArtifactRecoveryRequest({ ...request, tenantId: "org_other" }),
  ).rejects.toThrow("exact integration E2E organization");
});

test("rejects every identity, cardinality, set digest, lineage, R2 and source drift", async () => {
  const request = await recoveryRequest();
  const invalid: readonly unknown[] = [
    { ...request, owners: request.owners.slice(0, 3) },
    {
      ...request,
      owners: [
        { ...request.owners[0], operationId: "different-operation" },
        ...request.owners.slice(1),
      ],
    },
    { ...request, uploads: request.uploads.slice(0, 4) },
    {
      ...request,
      uploads: [{ ...request.uploads[0], uploadFence: 1 }, ...request.uploads.slice(1)],
    },
    { ...request, memberDigests: request.memberDigests.slice(0, 27) },
    { ...request, expectedReplays: { ...request.expectedReplays, count: 1 } },
    {
      ...request,
      expectedHolds: {
        ...request.expectedHolds,
        entries: request.expectedHolds.entries.slice(0, 28),
      },
    },
    { ...request, logicalTargetDigest: digest("0") },
    { ...request, ownerSetDigest: digest("0") },
    { ...request, uploadSetDigest: digest("0") },
    { ...request, memberSetDigest: digest("0") },
    { ...request, expectedReplays: { ...request.expectedReplays, setDigest: digest("0") } },
    { ...request, expectedHolds: { ...request.expectedHolds, setDigest: digest("0") } },
    { ...request, lineage: { ...request.lineage, migration: "0044_wrong.sql" } },
    { ...request, lineage: { ...request.lineage, digest: digest("0") } },
    { ...request, r2: { ...request.r2, accountId: "b".repeat(32) } },
    { ...request, r2: { ...request.r2, bucketName: "another-staging-bucket" } },
    { ...request, r2: { ...request.r2, identityDigest: digest("0") } },
    { ...request, source: { ...request.source, repository: "other" } },
    { ...request, source: { ...request.source, commit: "A".repeat(40) } },
    { ...request, source: { ...request.source, version: "" } },
    {
      ...request,
      retentionPolicy: { ...request.retentionPolicy, detailRetentionMilliseconds: 0 },
    },
  ];
  for (const drifted of invalid) {
    await expect(canonicalArtifactRecoveryRequest(drifted)).rejects.toThrow();
  }
});

test("reads only one canonical owner-only link-free descriptor outside the repository", async () => {
  const request = await recoveryRequest();
  const canonical = await canonicalArtifactRecoveryRequest(request);
  const directory = mkdtempSync(join(tmpdir(), "takoserver-recovery-"));
  chmodSync(directory, 0o700);
  const path = join(directory, "request.json");
  try {
    writeFileSync(path, canonical.canonicalJson, { mode: 0o600 });
    expect(await loadExactArtifactRecoveryRequest(path)).toEqual({
      request,
      requestDigest: canonical.requestDigest,
    });

    chmodSync(path, 0o640);
    await expect(loadExactArtifactRecoveryRequest(path)).rejects.toThrow("owned 0600");
    chmodSync(path, 0o600);

    const hardlink = join(directory, "hardlink.json");
    linkSync(path, hardlink);
    await expect(loadExactArtifactRecoveryRequest(path)).rejects.toThrow("link-free");
    rmSync(hardlink);

    const symlink = join(directory, "symlink.json");
    symlinkSync(path, symlink);
    await expect(loadExactArtifactRecoveryRequest(symlink)).rejects.toThrow("link-free");
    rmSync(symlink);

    writeFileSync(path, JSON.stringify(request, null, 2), { mode: 0o600 });
    await expect(loadExactArtifactRecoveryRequest(path)).rejects.toThrow("not canonical JSON");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the authenticated gateway pins the request and immutable recovery Worker version", async () => {
  const request = await recoveryRequest();
  const canonical = await canonicalArtifactRecoveryRequest(request);
  const now = new Date("2026-09-04T00:00:00.000Z");
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const workerVersionId = "10000000-0000-4000-8000-000000000001";
  const liveIdentity = {
    kind: "takoserver.public-host-identity@v2",
    hostId: "host.integration.test",
    workerVersionId: "20000000-0000-4000-8000-000000000002",
    workerArtifactDigest: digest("1"),
    implementationPayloadDigest: digest("3"),
    capabilityDigest: digest("4"),
    implementationDigest: digest("2"),
  } as const;
  const identity = {
    hostId: liveIdentity.hostId,
    workerArtifactDigest: liveIdentity.workerArtifactDigest,
    publicWorkerVersionId: liveIdentity.workerVersionId,
    implementationDigest: liveIdentity.implementationDigest,
  } as const;
  const assertion = await signOperatorAssertion({
    privateJwk: JSON.stringify(privateJwk),
    nowSeconds: Math.floor(now.getTime() / 1_000),
    lifetimeSeconds: 60,
    claims: {
      purpose: "exact-artifact-recovery",
      action: "status",
      method: "POST",
      path: "/v1/exact-artifact-recovery/status",
      bodyDigest: await canonicalDigest(request),
      environment: "integration",
      ...identity,
      requestDigest: canonical.requestDigest,
      recoveryWorkerVersionId: workerVersionId,
    },
  });
  let calls = 0;
  let forwarded: unknown;
  const env = {
    TAKOSERVER_ENVIRONMENT: "integration",
    TAKOSERVER_FORM_AUTHORITY_HOST_ID: identity.hostId,
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_ORIGIN: "https://operator.example.test",
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: JSON.stringify({
      kty: "OKP",
      crv: "Ed25519",
      x: publicJwk.x,
    }),
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID: "unused",
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE: "unused",
    FORM_AUTHORITY: {} as never,
    PUBLIC_HOST_IDENTITY: {
      async identity() {
        return liveIdentity;
      },
    },
    EXACT_ARTIFACT_RECOVERY: {
      async identity() {
        return {
          kind: "takoserver.exact-artifact-recovery-worker-identity@v1",
          requestDigest: canonical.requestDigest,
          workerVersionId,
        };
      },
      async status(invocation: unknown) {
        calls += 1;
        forwarded = invocation;
        return { kind: "safe-status", phase: "eligible", action: "prepare" };
      },
      async apply() {
        throw new Error("not used");
      },
      async purge() {
        throw new Error("not used");
      },
    },
    TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_DIGEST: canonical.requestDigest,
    TAKOSERVER_EXACT_ARTIFACT_RECOVERY_WORKER_VERSION_ID: workerVersionId,
  } satisfies IntegrationFormAuthorityGatewayEnv;
  const invoke = (selected: IntegrationFormAuthorityGatewayEnv = env) =>
    handleIntegrationFormAuthorityGateway(
      new Request("https://operator.example.test/v1/exact-artifact-recovery/status", {
        method: "POST",
        headers: { authorization: `Bearer ${assertion}`, "content-type": "application/json" },
        body: canonical.canonicalJson,
      }),
      selected,
      () => now,
    );
  const response = await invoke();
  expect({ status: response.status, body: await response.json() }).toEqual({
    status: 200,
    body: { kind: "safe-status", phase: "eligible", action: "prepare" },
  });
  expect(calls).toBe(1);
  expect(forwarded).toMatchObject({
    kind: "takoserver.signed-exact-artifact-recovery-rpc@v1",
    action: "status",
    assertion,
    body: request,
  });

  const drifted = {
    ...env,
    EXACT_ARTIFACT_RECOVERY: {
      ...env.EXACT_ARTIFACT_RECOVERY,
      async identity() {
        return {
          kind: "takoserver.exact-artifact-recovery-worker-identity@v1",
          requestDigest: canonical.requestDigest,
          workerVersionId: "30000000-0000-4000-8000-000000000003",
        } as const;
      },
    },
  } satisfies IntegrationFormAuthorityGatewayEnv;
  expect((await invoke(drifted)).status).toBe(409);
  expect(calls).toBe(1);

  const failed = {
    ...env,
    EXACT_ARTIFACT_RECOVERY: {
      ...env.EXACT_ARTIFACT_RECOVERY,
      async status() {
        throw new Error("private descriptor detail must not cross the gateway");
      },
    },
  } satisfies IntegrationFormAuthorityGatewayEnv;
  const failedResponse = await invoke(failed);
  const failedBody = await failedResponse.text();
  expect({ status: failedResponse.status, body: JSON.parse(failedBody) }).toEqual({
    status: 400,
    body: { error: { code: "invalid_request" } },
  });
  expect(failedBody).not.toContain("private descriptor detail");
});

export async function recoveryRequest(): Promise<ArtifactRecoveryRequest> {
  const operationIds = [
    "operation-artifact-a",
    "operation-artifact-b",
    "operation-artifact-c",
    "operation-artifact-d",
  ];
  const owners = await Promise.all(
    operationIds.map(async (operationId) => ({
      operationId,
      principalId: `api-key:${(await deterministicIntegrationE2eApiKeyIds(operationId)).writer}`,
    })),
  );
  owners.sort((left, right) => left.principalId.localeCompare(right.principalId));
  const uploads = owners
    .flatMap((owner, index) => [
      {
        principalId: owner.principalId,
        uploadId: `up_exact_${index}_a`,
        uploadFence: 2,
        rootFence: 2,
      },
      ...(index === 0
        ? [
            {
              principalId: owner.principalId,
              uploadId: `up_exact_${index}_b`,
              uploadFence: 2,
              rootFence: 2,
            },
          ]
        : []),
    ])
    .sort((left, right) =>
      `${left.principalId}\u0000${left.uploadId}`.localeCompare(
        `${right.principalId}\u0000${right.uploadId}`,
      ),
    );
  const memberDigests = Array.from(
    { length: 28 },
    (_, index) => `sha256:${index.toString(16).padStart(64, "0")}` as const,
  );
  const manifestDigest = digest("f");
  const holds = [
    { kind: "manifest" as const, digest: manifestDigest },
    ...memberDigests.map((memberDigest) => ({ kind: "blob" as const, digest: memberDigest })),
  ];
  const replayKeys = [
    `${INTEGRATION_E2E_ORGANIZATION_ID}\u0000${owners[0]?.principalId}\u0000commit-a`,
    `${INTEGRATION_E2E_ORGANIZATION_ID}\u0000${owners[1]?.principalId}\u0000commit-b`,
  ].sort();
  return {
    kind: ARTIFACT_RECOVERY_REQUEST_FORMAT,
    tenantId: INTEGRATION_E2E_ORGANIZATION_ID,
    logicalTargetDigest: await canonicalDigest({
      kind: "takoserver.exact-artifact-logical-target@v1",
      tenantId: INTEGRATION_E2E_ORGANIZATION_ID,
      manifestDigest,
      memberSetDigest: await canonicalDigest(memberDigests),
    }),
    owners,
    ownerSetDigest: await canonicalDigest(owners),
    uploads,
    uploadSetDigest: await canonicalDigest(uploads),
    manifestDigest,
    memberDigests,
    memberSetDigest: await canonicalDigest(memberDigests),
    expectedHolds: {
      entries: holds,
      count: holds.length,
      setDigest: await canonicalDigest(holds),
    },
    expectedReplays: {
      keys: replayKeys,
      count: replayKeys.length,
      setDigest: await canonicalDigest(replayKeys),
    },
    settlementEvidence: {
      kind: "takosumi.apply-run-failure@v1",
      digest: digest("e"),
    },
    lineage: {
      migration: ARTIFACT_RECOVERY_LINEAGE_MIGRATION,
      digest: ARTIFACT_RECOVERY_LINEAGE_DIGEST,
    },
    r2: {
      accountId: "a".repeat(32),
      bucketName: "takoserver-staging-artifacts",
      identityDigest: await canonicalDigest({
        kind: "takoserver.r2-artifact-target@v1",
        accountId: "a".repeat(32),
        bucketName: "takoserver-staging-artifacts",
      }),
    },
    source: {
      repository: "takoserver",
      commit: "b".repeat(40),
      version: "exact-recovery-test-v1",
    },
    retentionPolicy: {
      kind: ARTIFACT_RECOVERY_RETENTION_FORMAT,
      evidenceDigest: digest("d"),
      detailRetentionMilliseconds: 7 * 24 * 60 * 60_000,
    },
  };
}
