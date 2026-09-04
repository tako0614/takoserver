import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sponsorshipAuthorityBindingClosure } from "../scripts/deploy/sponsorship-authority.ts";
import type {
  SponsorshipCutoverConsumptionDatabase,
  SponsorshipCutoverConsumptionRecord,
  SponsorshipCutoverOperationCompletion,
  SponsorshipCutoverOperationStart,
} from "../scripts/deploy/sponsorship-cutover-consumption.ts";
import {
  createSponsorshipCutoverProofGate,
  type SponsorshipCutoverProofState,
} from "../scripts/deploy/sponsorship-cutover-proof.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";

const AUTHORITY_VERSION = "11111111-1111-4111-8111-111111111111";
const HOSTED_VERSION = "22222222-2222-4222-8222-222222222222";
const PUBLIC_PREDECESSOR_VERSION = "33333333-3333-4333-8333-333333333333";
const ROUTE_SUCCESSOR_VERSION = "44444444-4444-4444-8444-444444444444";
const TOPOLOGY_SUCCESSOR_VERSION = "66666666-6666-4666-8666-666666666666";
const SECRET_SUCCESSOR_VERSION = "55555555-5555-4555-8555-555555555555";
const AUTHORITY_SOURCE = "a".repeat(40);
const HOSTED_SOURCE = "b".repeat(40);
const PUBLIC_SOURCE = "c".repeat(40);
const CANDIDATE_SOURCE = "d".repeat(40);
const AUTHORITY_ARTIFACT = `sha256:${"1".repeat(64)}` as const;
const HOSTED_ARTIFACT = `sha256:${"2".repeat(64)}` as const;
const PUBLIC_ARTIFACT = `sha256:${"3".repeat(64)}` as const;
const CANDIDATE_ARTIFACT = `sha256:${"4".repeat(64)}` as const;
const CANDIDATE_CONFIG = `sha256:${"5".repeat(64)}` as const;
const AUTHORITY_ETAG = "authority-script-etag";
const PUBLIC_ETAG = "public-predecessor-script-etag";
const ROUTE_ETAG = "route-successor-script-etag";
const AUTHORITY_WORKER = "takoserver-sponsorship-authority-integration";
const HOSTED_WORKER = "takosumi-hosted-staging";
const PUBLIC_WORKER = "takoserver-api-integration";
const CREDENTIAL_PUBLIC_JWK = {
  kty: "OKP",
  crv: "Ed25519",
  x: "B".repeat(42) + "A",
} as const;
const AUDIT = {
  deploymentTokenIdSha256: `sha256:${"6".repeat(64)}` as const,
  deploymentTokenPolicySha256: `sha256:${"7".repeat(64)}` as const,
  allZoneResourceSha256: `sha256:${"8".repeat(64)}` as const,
};

describe("sponsorship cutover proof consumption", () => {
  test("revalidates all three Workers and consumes the two ordered phases remotely", async () => {
    const fixture = await proofFixture();
    try {
      const gate = fixture.gate();
      const route = await gate.authorize("public-route-removal");
      const routeStart = await gate.begin(route, candidate());
      fixture.state.promoteRoute(routeStart.operationId);
      await gate.complete(route, ROUTE_SUCCESSOR_VERSION);
      await expect(gate.authorize("public-route-removal")).rejects.toThrow("already consumed");

      fixture.state.promoteTopology();
      const secret = await gate.authorize("legacy-secret-retirement");
      await gate.begin(secret, candidate());
      fixture.state.promoteSecret();
      await gate.complete(secret, SECRET_SUCCESSOR_VERSION);
      await expect(gate.authorize("legacy-secret-retirement")).rejects.toThrow("already consumed");
    } finally {
      fixture.cleanup();
    }
  });

  test("settles only the exact direct successor carrying the started operation identity", async () => {
    const fixture = await proofFixture();
    try {
      const gate = fixture.gate();
      await expect(gate.authorize("legacy-secret-retirement")).rejects.toThrow(
        "exact topology-only successor",
      );
      const route = await gate.authorize("public-route-removal");
      const started = await gate.begin(route, candidate());
      await expect(gate.authorize("public-route-removal")).resolves.toMatchObject({
        stage: "public-route-removal",
      });

      fixture.state.promoteRoute(`sha256:${"9".repeat(64)}`);
      await expect(gate.settle("public-route-removal", ROUTE_SUCCESSOR_VERSION)).rejects.toThrow(
        "exact operation identity",
      );
      fixture.state.promoteRoute(started.operationId, `sha256:${"a".repeat(64)}`);
      await expect(gate.settle("public-route-removal", ROUTE_SUCCESSOR_VERSION)).rejects.toThrow(
        "exact started operation",
      );
      fixture.state.promoteRoute(started.operationId);
      await expect(gate.settle("public-route-removal", ROUTE_SUCCESSOR_VERSION)).resolves.toBe(
        fixture.proofSha256,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test("settles an exact lost acknowledgement from the durable start after proof expiry", async () => {
    const fixture = await proofFixture();
    try {
      const gate = fixture.gate();
      const handle = await gate.authorize("public-route-removal");
      const started = await gate.begin(handle, candidate());
      fixture.state.promoteRoute(started.operationId);

      await expect(
        fixture
          .gate(new Date("2026-09-04T03:00:00.000Z"))
          .settle("public-route-removal", ROUTE_SUCCESSOR_VERSION),
      ).resolves.toBe(fixture.proofSha256);
    } finally {
      fixture.cleanup();
    }
  });

  test("an exact existing start is reconciliation-only while the observed predecessor is unchanged", async () => {
    const fixture = await proofFixture();
    try {
      const gate = fixture.gate();
      const firstHandle = await gate.authorize("public-route-removal");
      const firstStart = await gate.begin(firstHandle, candidate());
      expect(firstStart.fresh).toBe(true);

      const resumedHandle = await gate.authorize("public-route-removal");
      const resumed = await gate.begin(resumedHandle, candidate());
      expect(resumed).toEqual({
        operationId: firstStart.operationId,
        candidateIdentitySha256: firstStart.candidateIdentitySha256,
        fresh: false,
      });
      expect(fixture.database.records).toHaveLength(1);

      await expect(
        gate.begin(resumedHandle, {
          ...candidate(),
          bundleSha256: `sha256:${"f".repeat(64)}`,
        }),
      ).rejects.toThrow("different candidate");
      expect(fixture.database.records).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  test("a lost durable-start acknowledgement never grants provider mutation authority", async () => {
    const fixture = await proofFixture();
    try {
      const gate = fixture.gate();
      const handle = await gate.authorize("public-route-removal");
      fixture.database.loseNextBeginAcknowledgement();
      await expect(gate.begin(handle, candidate())).rejects.toThrow(
        "simulated lost start acknowledgement",
      );

      const reconciled = await gate.begin(handle, candidate());
      expect(reconciled.fresh).toBe(false);
      expect("executionClaim" in reconciled).toBe(false);
      expect(fixture.state.expectedPublicTopology().customDomainCount).toBe(1);
      expect(fixture.database.records).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  test("two concurrent callers admit one provider mutation and the loser cannot invalidate completion", async () => {
    const fixture = await proofFixture();
    try {
      const firstGate = fixture.gate();
      const secondGate = fixture.gate();
      const [firstHandle, secondHandle] = await Promise.all([
        firstGate.authorize("public-route-removal"),
        secondGate.authorize("public-route-removal"),
      ]);
      const starts = await Promise.all([
        firstGate.begin(firstHandle, candidate()),
        secondGate.begin(secondHandle, candidate()),
      ]);
      expect(starts.filter(({ fresh }) => fresh)).toHaveLength(1);
      expect(starts.filter(({ fresh }) => !fresh)).toHaveLength(1);

      let providerCalls = 0;
      const winner = starts.find((start) => start.fresh);
      if (!winner?.fresh) throw new Error("fresh cutover winner missing");
      await winner.executionClaim.execute(async () => {
        providerCalls += 1;
        fixture.state.promoteRoute(winner.operationId);
      });
      await expect(
        winner.executionClaim.execute(async () => {
          providerCalls += 1;
        }),
      ).rejects.toThrow("already consumed");
      expect(providerCalls).toBe(1);

      await firstGate.complete(firstHandle, ROUTE_SUCCESSOR_VERSION);
      await expect(
        secondGate.settle("public-route-removal", ROUTE_SUCCESSOR_VERSION),
      ).resolves.toBe(fixture.proofSha256);
    } finally {
      fixture.cleanup();
    }
  });

  test("cannot replay the same proof from a new checkout after reversal", async () => {
    const fixture = await proofFixture();
    const second = fixture.copyProofToNewDirectory();
    try {
      const firstGate = fixture.gate();
      const route = await firstGate.authorize("public-route-removal");
      const started = await firstGate.begin(route, candidate());
      fixture.state.promoteRoute(started.operationId);
      await firstGate.complete(route, ROUTE_SUCCESSOR_VERSION);

      fixture.state.reverseToPredecessor();
      const secondGate = second.gate();
      await expect(secondGate.authorize("public-route-removal")).rejects.toThrow(
        "already consumed",
      );
      await expect(
        secondGate.settle("public-route-removal", PUBLIC_PREDECESSOR_VERSION),
      ).rejects.toThrow("exact completed successor");
    } finally {
      second.cleanup();
      fixture.cleanup();
    }
  });

  test("uses the completed route operation as the order witness for a fresh proof", async () => {
    const fixture = await proofFixture();
    try {
      const routeGate = fixture.gate();
      const route = await routeGate.authorize("public-route-removal");
      const started = await routeGate.begin(route, candidate());
      fixture.state.promoteRoute(started.operationId);
      await routeGate.complete(route, ROUTE_SUCCESSOR_VERSION);
      fixture.state.promoteTopology();

      const freshGate = fixture.freshGateForTopology();
      expect(await freshGate.authorize("legacy-secret-retirement")).toMatchObject({
        stage: "legacy-secret-retirement",
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("an old proof cannot retire the secret behind a post-reversal route operation", async () => {
    const fixture = await proofFixture();
    try {
      const oldGate = fixture.gate();
      const oldRoute = await oldGate.authorize("public-route-removal");
      const oldStart = await oldGate.begin(oldRoute, candidate());
      fixture.state.promoteRoute(oldStart.operationId);
      await oldGate.complete(oldRoute, ROUTE_SUCCESSOR_VERSION);

      fixture.state.reverseToPredecessor();
      const newGate = fixture.freshGateForPredecessor();
      const newRoute = await newGate.authorize("public-route-removal");
      const newStart = await newGate.begin(newRoute, candidate());
      fixture.state.promoteRoute(newStart.operationId);
      await newGate.complete(newRoute, ROUTE_SUCCESSOR_VERSION);
      fixture.state.promoteTopology();

      await expect(oldGate.authorize("legacy-secret-retirement")).rejects.toThrow(
        "public Worker predecessor no longer matches",
      );
      await expect(newGate.authorize("legacy-secret-retirement")).resolves.toMatchObject({
        stage: "legacy-secret-retirement",
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects stale proof and authority, Hosted, service binding, public predecessor, or topology drift", async () => {
    const variants: readonly [string, ProofStateOptions, Date][] = [
      ["Hosted Version", { hostedVersion: "66666666-6666-4666-8666-666666666666" }, now()],
      ["binding", { hostedService: "other-authority" }, now()],
      ["Hosted topology", { hostedRoute: true }, now()],
      ["authority", { authorityEtag: "changed" }, now()],
      ["public predecessor", { publicEtag: "changed" }, now()],
      ["public topology", { publicRoute: true }, now()],
      ["audit policy", { auditPolicySha256: `sha256:${"f".repeat(64)}` }, now()],
      ["stale", {}, new Date("2026-09-04T02:02:00.000Z")],
    ];
    for (const [name, options, clock] of variants) {
      const fixture = await proofFixture(options);
      try {
        await expect(
          fixture.gate(clock).authorize("public-route-removal"),
          name,
        ).rejects.toBeInstanceOf(Error);
      } finally {
        fixture.cleanup();
      }
    }
  });

  test("rejects a legacy-route proof forged with the ordinary run-token key", async () => {
    const receiptPair = await keyPair();
    const legacyRunPair = await keyPair();
    const fixture = await proofFixture({}, receiptPair, legacyRunPair.privateKey);
    try {
      await expect(fixture.gate().authorize("public-route-removal")).rejects.toThrow(
        "receipt signature is invalid",
      );
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects a valid receipt signature when the receipt and run-token keys are shared", async () => {
    const sharedPair = await keyPair();
    const fixture = await proofFixture(
      { receiptKeyReusedByCredential: true },
      sharedPair,
      sharedPair.privateKey,
    );
    try {
      await expect(fixture.gate().authorize("public-route-removal")).rejects.toThrow(
        "target credential public key",
      );
    } finally {
      fixture.cleanup();
    }
  });

  test("requires exact digest and owned 0600 input", async () => {
    const fixture = await proofFixture();
    try {
      expect(() =>
        createSponsorshipCutoverProofGate({
          target: fixture.target,
          environment: "integration",
          state: fixture.state,
          database: fixture.database,
          variables: {
            ...fixture.variables,
            TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_SHA256: `sha256:${"0".repeat(64)}`,
          },
        }),
      ).toThrow("digest does not match");
      chmodSync(fixture.proofPath, 0o644);
      expect(() => fixture.gate()).toThrow("owned 0600");
    } finally {
      fixture.cleanup();
    }
  });
});

function candidate() {
  return {
    sourceCommit: CANDIDATE_SOURCE,
    bundleSha256: CANDIDATE_ARTIFACT,
    configSha256: CANDIDATE_CONFIG,
  } as const;
}

function now(): Date {
  return new Date("2026-09-04T00:03:00.000Z");
}

interface ProofStateOptions {
  readonly hostedVersion?: string;
  readonly hostedService?: string;
  readonly hostedRoute?: boolean;
  readonly authorityEtag?: string;
  readonly publicEtag?: string;
  readonly publicRoute?: boolean;
  readonly auditPolicySha256?: `sha256:${string}`;
  readonly receiptKeyReusedByCredential?: boolean;
}

async function proofFixture(
  stateOptions: ProofStateOptions = {},
  suppliedReceiptPair?: CryptoKeyPair,
  suppliedReceiptSigner?: CryptoKey,
) {
  const receiptPair = suppliedReceiptPair ?? (await keyPair());
  const receiptSigner = suppliedReceiptSigner ?? receiptPair.privateKey;
  const receiptPublicJwk = publicJwk(await crypto.subtle.exportKey("jwk", receiptPair.publicKey));
  const target = targetWithReceipt(receiptPublicJwk);
  const state = new ProofState(target, stateOptions);
  const receiptJws = await issuanceReceipt(
    receiptSigner,
    stateOptions.receiptKeyReusedByCredential ? receiptPublicJwk : undefined,
  );
  const proof = validProof(target, state, receiptJws);
  const root = mkdtempSync(join(tmpdir(), "sponsorship-cutover-proof-"));
  chmodSync(root, 0o700);
  const proofPath = join(root, "proof.json");
  const proofBytes = new TextEncoder().encode(`${JSON.stringify(proof, null, 2)}\n`);
  writeFileSync(proofPath, proofBytes, { mode: 0o600 });
  const proofSha256 = digest(proofBytes) as `sha256:${string}`;
  const database = new MemoryConsumptionDatabase();
  const variables = {
    TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_PATH: proofPath,
    TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_SHA256: proofSha256,
  };
  const gate = (clock = now()) =>
    createSponsorshipCutoverProofGate({
      target,
      environment: "integration",
      state,
      database,
      variables,
      clock: () => clock,
    });
  return {
    target,
    state,
    database,
    variables,
    gate,
    proofPath,
    proofSha256,
    freshGateForPredecessor() {
      const { confirmation: _confirmation, ...oldSubject } = proof;
      const freshSubject = {
        ...oldSubject,
        completedAt: "2026-09-04T00:03:00.000Z",
        expiresAt: "2026-09-04T02:03:00.000Z",
        issuance: {
          ...oldSubject.issuance,
          readback: {
            ...oldSubject.issuance.readback,
            verifiedAt: "2026-09-04T00:03:00.000Z",
            responseSha256: `sha256:${"d".repeat(64)}`,
          },
        },
      };
      const freshProof = {
        ...freshSubject,
        confirmation: digestText(canonicalJson(freshSubject)),
      };
      const freshPath = join(root, "fresh-predecessor-proof.json");
      const freshBytes = new TextEncoder().encode(`${JSON.stringify(freshProof, null, 2)}\n`);
      writeFileSync(freshPath, freshBytes, { mode: 0o600 });
      return createSponsorshipCutoverProofGate({
        target,
        environment: "integration",
        state,
        database,
        variables: {
          TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_PATH: freshPath,
          TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_SHA256: digest(freshBytes),
        },
        clock: () => new Date("2026-09-04T00:03:05.000Z"),
      });
    },
    freshGateForTopology() {
      const { confirmation: _confirmation, ...oldSubject } = proof;
      const freshSubject = {
        ...oldSubject,
        completedAt: "2026-09-04T00:04:45.000Z",
        expiresAt: "2026-09-04T02:04:45.000Z",
        publicWorkerPredecessor: {
          ...oldSubject.publicWorkerPredecessor,
          deploymentId: "deployment-topology-successor",
          versionId: TOPOLOGY_SUCCESSOR_VERSION,
          previousVersionId: ROUTE_SUCCESSOR_VERSION,
          sourceCommit: CANDIDATE_SOURCE,
          artifactSha256: CANDIDATE_ARTIFACT,
          scriptEtagSha256: digestText(ROUTE_ETAG),
          evidenceSha256: `sha256:${"d".repeat(64)}`,
        },
        issuance: {
          ...oldSubject.issuance,
          readback: {
            ...oldSubject.issuance.readback,
            verifiedAt: "2026-09-04T00:04:45.000Z",
            responseSha256: `sha256:${"e".repeat(64)}`,
          },
        },
      };
      const freshProof = {
        ...freshSubject,
        confirmation: digestText(canonicalJson(freshSubject)),
      };
      const freshPath = join(root, "fresh-proof.json");
      const freshBytes = new TextEncoder().encode(`${JSON.stringify(freshProof, null, 2)}\n`);
      writeFileSync(freshPath, freshBytes, { mode: 0o600 });
      return createSponsorshipCutoverProofGate({
        target,
        environment: "integration",
        state,
        database,
        variables: {
          TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_PATH: freshPath,
          TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_SHA256: digest(freshBytes),
        },
        clock: () => new Date("2026-09-04T00:04:50.000Z"),
      });
    },
    copyProofToNewDirectory() {
      const otherRoot = mkdtempSync(join(tmpdir(), "sponsorship-cutover-proof-copy-"));
      chmodSync(otherRoot, 0o700);
      const otherPath = join(otherRoot, "proof.json");
      writeFileSync(otherPath, proofBytes, { mode: 0o600 });
      return {
        gate: () =>
          createSponsorshipCutoverProofGate({
            target,
            environment: "integration",
            state,
            database,
            variables: {
              TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_PATH: otherPath,
              TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_SHA256: proofSha256,
            },
            clock: now,
          }),
        cleanup: () => rmSync(otherRoot, { recursive: true, force: true }),
      };
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function targetWithReceipt(receiptPublicJwk: { kty: "OKP"; crv: "Ed25519"; x: string }) {
  return {
    kind: "takoserver.deploy-target@v2",
    environment: "integration",
    accountId: "a".repeat(32),
    workerName: PUBLIC_WORKER,
    d1: {
      databaseName: "takoserver-runtime-integration",
      databaseId: "00000000-0000-4000-8000-000000000000",
    },
    r2: { bucketName: "takoserver-objects-integration" },
    publicOrigin: "https://api.integration.example.test",
    signing: { currentKeyId: "key-current" },
    sponsorshipAuthority: {
      workerName: AUTHORITY_WORKER,
      organizationId: "org_hosted",
      credentialKeyId: "sponsorship-credential-key",
      credentialPublicJwk: CREDENTIAL_PUBLIC_JWK,
      receiptKeyId: "receipt-key",
      receiptPublicJwk,
    },
  } satisfies DeployTarget;
}

function validProof(target: DeployTarget, state: ProofState, receiptJws: string) {
  const selected = target.sponsorshipAuthority;
  if (!selected) throw new Error("fixture sponsorship authority is unavailable");
  const bindings = hostedBindings(selected.workerName);
  const publicTopology = state.expectedPublicTopology();
  const subject = {
    kind: "takosumi-hosted.sponsorship-authority-cutover-proof@v1",
    environment: "staging",
    completedAt: "2026-09-04T00:02:00.000Z",
    expiresAt: "2026-09-04T02:02:00.000Z",
    authority: {
      environment: "integration",
      workerName: selected.workerName,
      sourceCommit: AUTHORITY_SOURCE,
      versionId: AUTHORITY_VERSION,
      artifactSha256: AUTHORITY_ARTIFACT,
      scriptEtagSha256: digestText(AUTHORITY_ETAG),
      evidenceSha256: `sha256:${"9".repeat(64)}`,
      credentialKeyIdSha256: digestText(selected.credentialKeyId),
      credentialPublicJwkSha256: digestText(canonicalJson(selected.credentialPublicJwk)),
      receiptKeyIdSha256: digestText(selected.receiptKeyId),
      receiptPublicJwkSha256: digestText(canonicalJson(selected.receiptPublicJwk)),
    },
    hosted: {
      workerName: HOSTED_WORKER,
      sourceCommit: HOSTED_SOURCE,
      versionId: HOSTED_VERSION,
      artifactSha256: HOSTED_ARTIFACT,
      configSha256: `sha256:${"a".repeat(64)}`,
      providerBindingSetSha256: digestText(canonicalJson(bindingProjection(bindings))),
      authorityServiceBinding: {
        name: "TAKOSERVER_SPONSORSHIP_AUTHORITY",
        serviceSha256: digestText(selected.workerName),
        entrypoint: "default",
      },
      publicTopology: {
        workersDevEnabled: false,
        previewsEnabled: false,
        routeCount: 0,
        customDomainCount: 0,
        ...AUDIT,
      },
      evidenceSha256: `sha256:${"b".repeat(64)}`,
    },
    publicWorkerPredecessor: {
      workerName: PUBLIC_WORKER,
      deploymentId: "deployment-public-predecessor",
      versionId: PUBLIC_PREDECESSOR_VERSION,
      previousVersionId: null,
      sourceCommit: PUBLIC_SOURCE,
      artifactSha256: PUBLIC_ARTIFACT,
      scriptEtagSha256: digestText(PUBLIC_ETAG),
      cutoverOperationId: null,
      topologySha256: digestText(canonicalJson(publicTopology)),
      publicTopology,
      evidenceSha256: `sha256:${"c".repeat(64)}`,
    },
    issuance: {
      authorityReceipt: {
        jws: receiptJws,
        sha256: digestText(receiptJws),
        issuanceOperationId: `sha256:${"f".repeat(64)}`,
        requestSha256: `sha256:${"d".repeat(64)}`,
        requestNonceSha256: `sha256:${"e".repeat(64)}`,
        recordedAt: "2026-09-04T00:00:30.000Z",
      },
      exchange: {
        authKind: "run-credential",
        audience: "takosumi-hosted.takoform.v1",
        scopes: ["takoform.run"],
        phase: "apply",
        lifecycleIntent: "provision",
        subjectSha256: `sha256:${"1".repeat(64)}`,
        workspaceIdSha256: `sha256:${"2".repeat(64)}`,
        capsuleIdSha256: `sha256:${"3".repeat(64)}`,
        installingPrincipalIdSha256: `sha256:${"4".repeat(64)}`,
        runRefSha256: `sha256:${"5".repeat(64)}`,
        providerSource: "registry.terraform.io/tako0614/takoform",
        requiredAvailableMinor: 2_300,
        status: 200,
        capturedAt: "2026-09-04T00:01:00.000Z",
        transcriptSha256: `sha256:${"6".repeat(64)}`,
      },
      credential: {
        alg: "EdDSA",
        typ: "takoserver-token+jwt",
        keyIdSha256: digestText(selected.credentialKeyId),
        issuerSha256: digestText(target.publicOrigin),
        audience: "takoform.run",
        mode: "tenant-run",
        organizationIdSha256: digestText(selected.organizationId),
        tenantRefSha256: `sha256:${"8".repeat(64)}`,
        spaceRefSha256: `sha256:${"8".repeat(64)}`,
        runRefSha256: `sha256:${"5".repeat(64)}`,
        reservationRefSha256: null,
        tokenSha256: `sha256:${"9".repeat(64)}`,
        issuedAt: "2026-09-04T00:00:00.000Z",
        expiresAt: "2026-09-04T00:05:00.000Z",
        lifetimeSeconds: 300,
      },
      readback: {
        method: "GET",
        routeTemplate: "/apis/forms.takoform.com/v1/forms?space={spaceRef}",
        status: 200,
        mediaType: "application/json",
        semantic: "takoform-form-list",
        verifiedAt: "2026-09-04T00:02:00.000Z",
        responseSha256: `sha256:${"a".repeat(64)}`,
      },
    },
  };
  return { ...subject, confirmation: digestText(canonicalJson(subject)) };
}

async function issuanceReceipt(
  privateKey: CryptoKey,
  credentialPublicJwk: { kty: "OKP"; crv: "Ed25519"; x: string } = {
    ...CREDENTIAL_PUBLIC_JWK,
  },
): Promise<string> {
  return await signJws(
    {
      alg: "EdDSA",
      kid: "receipt-key",
      typ: "takoserver-sponsorship-issuance-receipt+jwt",
    },
    {
      aud: "takosumi-hosted.sponsorship-cutover-proof.v1",
      authority: {
        artifactSha256: AUTHORITY_ARTIFACT,
        sourceCommit: AUTHORITY_SOURCE,
        versionId: AUTHORITY_VERSION,
        workerNameSha256: digestText(AUTHORITY_WORKER),
      },
      credential: {
        expiresAtEpochSeconds: Date.parse("2026-09-04T00:05:00.000Z") / 1_000,
        issuedAtEpochSeconds: Date.parse("2026-09-04T00:00:00.000Z") / 1_000,
        organizationIdSha256: digestText("org_hosted"),
        publicJwk: credentialPublicJwk,
        reservationRefSha256: null,
        runRefSha256: `sha256:${"5".repeat(64)}`,
        spaceRefSha256: `sha256:${"8".repeat(64)}`,
        tenantRefSha256: `sha256:${"8".repeat(64)}`,
        tokenSha256: `sha256:${"9".repeat(64)}`,
      },
      exp: Date.parse("2026-09-04T00:05:00.000Z") / 1_000,
      hostedVersionId: HOSTED_VERSION,
      iat: Date.parse("2026-09-04T00:00:00.000Z") / 1_000,
      issuanceOperationId: `sha256:${"f".repeat(64)}`,
      requestNonceSha256: `sha256:${"e".repeat(64)}`,
      requestSha256: `sha256:${"d".repeat(64)}`,
      requiredAvailableMinor: 2_300,
    },
    privateKey,
  );
}

class ProofState implements SponsorshipCutoverProofState {
  #mode: "predecessor" | "route" | "topology" | "secret" = "predecessor";
  #routeOperationId: `sha256:${string}` | null = null;
  #routeBundle: `sha256:${string}` = CANDIDATE_ARTIFACT;

  constructor(
    readonly target: DeployTarget,
    readonly options: ProofStateOptions,
  ) {}

  promoteRoute(
    operationId: `sha256:${string}`,
    bundleSha256: `sha256:${string}` = CANDIDATE_ARTIFACT,
  ): void {
    this.#mode = "route";
    this.#routeOperationId = operationId;
    this.#routeBundle = bundleSha256;
  }

  promoteSecret(): void {
    this.#mode = "secret";
  }

  promoteTopology(): void {
    this.#mode = "topology";
  }

  reverseToPredecessor(): void {
    this.#mode = "predecessor";
    this.#routeOperationId = null;
    this.#routeBundle = CANDIDATE_ARTIFACT;
  }

  expectedPublicTopology() {
    const domains = [{ hostname: "api.integration.example.test" }];
    const routes: readonly { id: string; pattern: string; zoneId: string }[] = [];
    return {
      workersDevEnabled: false,
      previewsEnabled: false,
      customDomainCount: domains.length,
      customDomainSetSha256: digestText(canonicalJson(domains)),
      routeCount: routes.length,
      routeSetSha256: digestText(canonicalJson(routes)),
      ...AUDIT,
    };
  }

  async workerScripts() {
    return [AUTHORITY_WORKER, HOSTED_WORKER, PUBLIC_WORKER];
  }

  async workerDeployments(workerName: string) {
    if (workerName === AUTHORITY_WORKER) {
      return [deployment("deployment-authority", AUTHORITY_VERSION, "2026-09-04T00:00:00.000Z")];
    }
    if (workerName === HOSTED_WORKER) {
      return [
        deployment(
          "deployment-hosted",
          this.options.hostedVersion ?? HOSTED_VERSION,
          "2026-09-04T00:00:00.000Z",
        ),
      ];
    }
    const predecessor = deployment(
      "deployment-public-predecessor",
      PUBLIC_PREDECESSOR_VERSION,
      "2026-09-03T23:58:00.000Z",
    );
    if (this.#mode === "predecessor") return [predecessor];
    const route = deployment(
      "deployment-route-successor",
      ROUTE_SUCCESSOR_VERSION,
      "2026-09-04T00:04:00.000Z",
    );
    if (this.#mode === "route") return [route, predecessor];
    const topology = deployment(
      "deployment-topology-successor",
      TOPOLOGY_SUCCESSOR_VERSION,
      "2026-09-04T00:04:30.000Z",
    );
    if (this.#mode === "topology") return [topology, route, predecessor];
    return [
      deployment(
        "deployment-secret-successor",
        SECRET_SUCCESSOR_VERSION,
        "2026-09-04T00:05:00.000Z",
      ),
      topology,
      route,
      predecessor,
    ];
  }

  async workerVersion(workerName: string, versionId: string) {
    if (workerName === HOSTED_WORKER) {
      const selected = this.target.sponsorshipAuthority;
      if (!selected) throw new Error("fixture sponsorship authority is unavailable");
      return {
        annotations: {
          "workers/message": `takosumi-hosted-worker:${HOSTED_SOURCE}:${HOSTED_ARTIFACT.slice(7)}:${"1".repeat(64)}:${"2".repeat(64)}`,
          "workers/tag": `source-${HOSTED_SOURCE.slice(0, 16)}`,
          "workers/triggered_by": "version_upload",
        },
        resources: {
          script: { etag: "hosted-script-etag" },
          bindings: hostedBindings(this.options.hostedService ?? selected.workerName),
        },
      };
    }
    if (workerName === AUTHORITY_WORKER) {
      return {
        annotations: {
          "workers/message": `sponsorship-authority:${AUTHORITY_SOURCE}:${AUTHORITY_ARTIFACT}`,
          "workers/triggered_by": "version_upload",
        },
        resources: {
          script: { etag: this.options.authorityEtag ?? AUTHORITY_ETAG },
          bindings: authorityBindings(this.target),
        },
      };
    }
    if (versionId === PUBLIC_PREDECESSOR_VERSION) {
      return canonicalPublicVersion(
        PUBLIC_SOURCE,
        PUBLIC_ARTIFACT,
        this.options.publicEtag ?? PUBLIC_ETAG,
      );
    }
    if (versionId === ROUTE_SUCCESSOR_VERSION) {
      return canonicalPublicVersion(
        CANDIDATE_SOURCE,
        this.#routeBundle,
        ROUTE_ETAG,
        this.#routeOperationId,
      );
    }
    if (versionId === TOPOLOGY_SUCCESSOR_VERSION) {
      return canonicalPublicVersion(CANDIDATE_SOURCE, this.#routeBundle, ROUTE_ETAG);
    }
    return {
      annotations: { "workers/triggered_by": "secret" },
      resources: { script: { etag: ROUTE_ETAG }, bindings: [] },
    };
  }

  async workerSecrets(workerName: string) {
    return workerName === AUTHORITY_WORKER
      ? [
          { name: "TAKOSERVER_SPONSORSHIP_CREDENTIAL_SIGNING_KEY", type: "secret_text" },
          { name: "TAKOSERVER_SPONSORSHIP_RECEIPT_SIGNING_KEY", type: "secret_text" },
        ]
      : [];
  }

  async workerDomains() {
    return [
      { hostname: "api.integration.example.test", service: PUBLIC_WORKER },
      ...(this.options.hostedRoute
        ? [{ hostname: "hosted.example.test", service: HOSTED_WORKER }]
        : []),
    ];
  }

  async workerRoutes() {
    return [
      ...(this.options.hostedRoute
        ? [
            {
              zoneId: "zone-hosted",
              id: "route-hosted",
              pattern: "hosted/*",
              script: HOSTED_WORKER,
            },
          ]
        : []),
      ...(this.options.publicRoute
        ? [
            {
              zoneId: "zone-public",
              id: "route-public",
              pattern: "api/*",
              script: PUBLIC_WORKER,
            },
          ]
        : []),
    ];
  }

  async workerSubdomain() {
    return { enabled: false, previewsEnabled: false };
  }

  async workerTopologyAudit() {
    return {
      ...AUDIT,
      ...(this.options.auditPolicySha256 === undefined
        ? {}
        : { deploymentTokenPolicySha256: this.options.auditPolicySha256 }),
    };
  }
}

class MemoryConsumptionDatabase implements SponsorshipCutoverConsumptionDatabase {
  readonly records: SponsorshipCutoverConsumptionRecord[] = [];
  #loseNextBeginAcknowledgement = false;

  loseNextBeginAcknowledgement(): void {
    this.#loseNextBeginAcknowledgement = true;
  }

  async read(input: {
    readonly targetSha256: string;
    readonly environment: string;
    readonly stage: string;
    readonly proofSha256: string;
  }) {
    return (
      this.records.find(
        ({ start }) =>
          start.targetSha256 === input.targetSha256 &&
          start.environment === input.environment &&
          start.stage === input.stage &&
          start.proofSha256 === input.proofSha256,
      ) ?? null
    );
  }

  async readByOperationId(operationId: string) {
    return this.records.find(({ start }) => start.operationId === operationId) ?? null;
  }

  async begin(start: SponsorshipCutoverOperationStart) {
    const existing = this.records.find(
      ({ start: found }) =>
        found.targetSha256 === start.targetSha256 &&
        found.environment === start.environment &&
        found.stage === start.stage &&
        found.proofSha256 === start.proofSha256,
    );
    if (existing) return "existing" as const;
    this.records.push({ start: structuredClone(start), completion: null });
    if (this.#loseNextBeginAcknowledgement) {
      this.#loseNextBeginAcknowledgement = false;
      throw new Error("simulated lost start acknowledgement");
    }
    return "inserted" as const;
  }

  async complete(completion: SponsorshipCutoverOperationCompletion) {
    const index = this.records.findIndex(
      ({ start }) => start.operationId === completion.operationId,
    );
    const record = this.records[index];
    if (!record || record.completion !== null) throw new Error("invalid completion");
    this.records[index] = {
      start: record.start,
      completion: structuredClone(completion),
    };
  }
}

function deployment(id: string, versionId: string, createdOn: string) {
  return { id, created_on: createdOn, versions: [{ version_id: versionId, percentage: 100 }] };
}

function canonicalPublicVersion(
  source: string,
  artifact: `sha256:${string}`,
  etag: string,
  operationId: `sha256:${string}` | null = null,
) {
  return {
    annotations: {
      "workers/message": `takoserver-worker:${source}:${artifact.slice(7)}${operationId === null ? "" : `:${operationId.slice(7)}`}`,
      "workers/triggered_by": "version_upload",
    },
    resources: { script: { etag }, bindings: [] },
  };
}

function authorityBindings(target: DeployTarget) {
  return Object.entries(
    sponsorshipAuthorityBindingClosure(target, {
      commit: AUTHORITY_SOURCE,
      artifactDigest: AUTHORITY_ARTIFACT,
    }),
  ).flatMap(([name, requirement]) =>
    requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
  );
}

function hostedBindings(service: string) {
  return [{ name: "TAKOSERVER_SPONSORSHIP_AUTHORITY", type: "service", service }];
}

function bindingProjection(bindings: ReturnType<typeof hostedBindings>) {
  return bindings.map((binding) => ({
    name: binding.name,
    type: binding.type,
    resourceSha256: digestText(binding.service),
  }));
}

async function keyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

function publicJwk(value: JsonWebKey) {
  if (!value.x) throw new Error("fixture key missing public half");
  return { kty: "OKP" as const, crv: "Ed25519" as const, x: value.x };
}

async function signJws(header: unknown, payload: unknown, privateKey: CryptoKey): Promise<string> {
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
}

function encode(value: unknown): string {
  return Buffer.from(canonicalJson(value)).toString("base64url");
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestText(value: string): `sha256:${string}` {
  return digest(new TextEncoder().encode(value)) as `sha256:${string}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const item = value as Record<string, unknown>;
  return `{${Object.keys(item)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`)
    .join(",")}}`;
}
