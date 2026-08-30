import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { signedFormAuthorityRpcInvocation } from "../src/form-authority-operator-proof.ts";
import {
  createIntegrationFormAuthorityCompositionFromWorkerEnv,
  type IntegrationFormAuthorityRawWorkerEnv,
  invokeAuthenticatedIntegrationFormAuthorityFromWorkerEnv,
} from "../src/form-authority-worker-composition.ts";
import { canonicalDigest, canonicalJson } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";
import type { ObjectStore, Sql } from "../src/ports.ts";
import {
  TAKOFORM_REVOCATION_V1,
  TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
  TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
} from "../src/takoform/admission.ts";
import type { FormAuthorityVerificationEvidence } from "../src/takoform/form-authority-verification.ts";
import type { FormAuthorityPlanRequest } from "../src/takoform/host-admission-coordinator.ts";
import { createProductionFormAuthorityComposition } from "../src/takoform/host-admission-endpoint.ts";
import {
  YURUCOMMU_FORM_VERSIONS,
  YURUCOMMU_IDENTITY_CAPABILITY_KINDS,
  yurucommuLifecycleCapabilityManifest,
} from "../src/takoform/implementation-catalog.ts";
import { createIntegrationFormAuthorityComposition } from "../src/takoform/integration-operator-endpoint.ts";

const digest = (hex: string) => `sha256:${hex.repeat(64)}` as const;
const PUBLIC_VERSION_ID = "00000000-0000-4000-8000-000000000001";
const DRIFTED_PUBLIC_VERSION_ID = "00000000-0000-4000-8000-000000000002";
const CAPABILITIES = yurucommuLifecycleCapabilityManifest(YURUCOMMU_IDENTITY_CAPABILITY_KINDS);

function trustEvidence(): FormAuthorityVerificationEvidence {
  return {
    publisher: {
      publisherKey: "publisher-yurucommu-integration-fixture",
      policyDigest: digest("1"),
      policy: { apiVersion: "policy.forms.takoform.com/v1", mode: "integration-fixture" },
      oidcIssuer: "https://issuer.integration.invalid",
      sourceRepository: "https://github.com/tako0614/yurucommu",
      workflow: ".github/workflows/integration.yml",
      ref: "refs/heads/integration",
      identity: "yurucommu-integration-fixture",
      trustedRootDigest: digest("2"),
      sourceCommit: "a".repeat(40),
      workflowCommit: "b".repeat(40),
      buildConfigCommit: "c".repeat(40),
      repositoryIdentifier: "repo:tako0614/yurucommu",
      ownerIdentifier: "owner:tako0614",
      group: "edge.forms.takoform.com",
      namespaceGrantDigest: digest("3"),
    },
    checkpoint: {
      apiVersion: TAKOFORM_REVOCATION_V1,
      sequence: 0,
      digest: TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
      entriesDigest: TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
      previousDigest: null,
      revokedPackageDigests: [],
    },
    bundleDigest: digest("4"),
  };
}

async function integrationFixture(input?: { readonly sql?: Sql; readonly objects?: ObjectStore }) {
  const sql = input?.sql ?? createEphemeralSql();
  const objects = input?.objects ?? createMemoryObjectStore();
  const hostId = "takoserver-yurucommu-integration";
  const composition = await createIntegrationFormAuthorityComposition({
    configuration: {
      environment: "integration",
      hostId,
      workerArtifactDigest: digest("5"),
      publicWorkerVersionId: PUBLIC_VERSION_ID,
      capabilities: CAPABILITIES,
    },
    bindings: {
      sql,
      objects,
      publicHostIdentity: {
        async identity() {
          return {
            kind: "takoserver.public-host-identity@v1",
            hostId,
            workerVersionId: PUBLIC_VERSION_ID,
          };
        },
      },
    },
  });
  const request: FormAuthorityPlanRequest = {
    kind: "takoserver.form-authority-plan-request@v2",
    ...composition.identity,
    activation: {
      kind: "space",
      tenantId: "tenant-yurucommu",
      space: "space-yurucommu",
      desiredActive: true,
    },
    evidence: trustEvidence(),
    actor: "integration-operator",
    reason: "activate the exact Yurucommu integration fixture",
  };
  return { ...composition, request, sql, objects };
}

describe("integration Form authority bridge", () => {
  test("independently rejects a gateway-forwarded proof signed by another key before D1/R2", async () => {
    const authorityPair = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const otherPair = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const authorityPublic = await crypto.subtle.exportKey("jwk", authorityPair.publicKey);
    const otherPrivate = await crypto.subtle.exportKey("jwk", otherPair.privateKey);
    const hostId = "takoserver-yurucommu-integration";
    const artifact = digest("5");
    const body = { kind: "takoserver.form-authority-plan-request@v2" };
    const now = Math.floor(Date.now() / 1_000);
    const assertion = await signOperatorAssertion({
      privateJwk: JSON.stringify(otherPrivate),
      claims: {
        purpose: "form-authority",
        action: "plan",
        method: "POST",
        path: "/v1/plan",
        bodyDigest: await canonicalDigest(body),
        environment: "integration",
        hostId,
        workerArtifactDigest: artifact,
        publicWorkerVersionId: PUBLIC_VERSION_ID,
      },
      nowSeconds: now,
      lifetimeSeconds: 60,
    });
    const reads: string[] = [];
    const env = {
      TAKOSERVER_ENVIRONMENT: "integration",
      TAKOSERVER_FORM_AUTHORITY_HOST_ID: hostId,
      TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST: artifact,
      TAKOSERVER_PUBLIC_WORKER_VERSION_ID: PUBLIC_VERSION_ID,
      TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: canonicalJson({
        kty: authorityPublic.kty,
        crv: authorityPublic.crv,
        x: authorityPublic.x,
      }),
      get TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST() {
        reads.push("capabilities");
        throw new Error("must not derive composition for an invalid proof");
      },
      get STATE_DB() {
        reads.push("d1");
        throw new Error("must not read D1 for an invalid proof");
      },
      get OBJECTS() {
        reads.push("r2");
        throw new Error("must not read R2 for an invalid proof");
      },
      get PUBLIC_HOST_IDENTITY() {
        reads.push("public-host");
        throw new Error("must not read the public service for an invalid proof");
      },
    } as unknown as IntegrationFormAuthorityRawWorkerEnv;

    await expect(
      invokeAuthenticatedIntegrationFormAuthorityFromWorkerEnv(
        env,
        "plan",
        signedFormAuthorityRpcInvocation({ action: "plan", assertion, body }),
      ),
    ).rejects.toMatchObject({ code: "invalid_operator_assertion" });
    expect(reads).toEqual([]);
  });

  test("independently rejects a valid proof outside its sealed tenant and Space before D1/R2", async () => {
    const pair = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const hostId = "takoserver-yurucommu-integration";
    const artifact = digest("5");
    const body = {
      kind: "takoserver.form-authority-plan-request@v2",
      activation: {
        kind: "space",
        tenantId: "tenant-yurucommu",
        space: "space-outside-sealed-scope",
        desiredActive: true,
      },
    };
    const now = Math.floor(Date.now() / 1_000);
    const assertion = await signOperatorAssertion({
      privateJwk: JSON.stringify(privateJwk),
      claims: {
        purpose: "form-authority",
        action: "plan",
        method: "POST",
        path: "/v1/plan",
        bodyDigest: await canonicalDigest(body),
        environment: "integration",
        hostId,
        workerArtifactDigest: artifact,
        publicWorkerVersionId: PUBLIC_VERSION_ID,
      },
      nowSeconds: now,
      lifetimeSeconds: 60,
    });
    const reads: string[] = [];
    const env = {
      TAKOSERVER_ENVIRONMENT: "integration",
      TAKOSERVER_FORM_AUTHORITY_HOST_ID: hostId,
      TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST: artifact,
      TAKOSERVER_PUBLIC_WORKER_VERSION_ID: PUBLIC_VERSION_ID,
      TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: canonicalJson({
        kty: publicJwk.kty,
        crv: publicJwk.crv,
        x: publicJwk.x,
      }),
      TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID: "tenant-yurucommu",
      TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE: "space-yurucommu",
      get TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST() {
        reads.push("capabilities");
        throw new Error("must not derive composition outside the sealed scope");
      },
      get STATE_DB() {
        reads.push("d1");
        throw new Error("must not read D1 outside the sealed scope");
      },
      get OBJECTS() {
        reads.push("r2");
        throw new Error("must not read R2 outside the sealed scope");
      },
      get PUBLIC_HOST_IDENTITY() {
        reads.push("public-host");
        throw new Error("must not read the public service outside the sealed scope");
      },
    } as unknown as IntegrationFormAuthorityRawWorkerEnv;

    await expect(
      invokeAuthenticatedIntegrationFormAuthorityFromWorkerEnv(
        env,
        "plan",
        signedFormAuthorityRpcInvocation({ action: "plan", assertion, body }),
      ),
    ).rejects.toMatchObject({ code: "operator_scope_mismatch" });
    expect(reads).toEqual([]);
  });

  test("refuses a non-integration environment before reading D1 or R2 bindings", () => {
    const reads: string[] = [];
    const env = {
      get TAKOSERVER_ENVIRONMENT() {
        reads.push("environment");
        return "production";
      },
      get TAKOSERVER_FORM_AUTHORITY_HOST_ID() {
        reads.push("host");
        return "must-not-read";
      },
      get TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST() {
        reads.push("artifact");
        return digest("6");
      },
      get TAKOSERVER_PUBLIC_WORKER_VERSION_ID() {
        reads.push("version");
        return PUBLIC_VERSION_ID;
      },
      get TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST() {
        reads.push("capabilities");
        return JSON.stringify(CAPABILITIES);
      },
      get STATE_DB(): never {
        reads.push("d1");
        throw new Error("D1 binding was read");
      },
      get OBJECTS(): never {
        reads.push("r2");
        throw new Error("R2 binding was read");
      },
      get PUBLIC_HOST_IDENTITY(): never {
        reads.push("public-host");
        throw new Error("public Host binding was read");
      },
    } as unknown as IntegrationFormAuthorityRawWorkerEnv;

    expect(() => createIntegrationFormAuthorityCompositionFromWorkerEnv(env)).toThrow(
      "refuses every non-integration environment",
    );
    expect(reads).toEqual(["environment"]);
  });

  test("installs and Space-activates only the exact 12 Yurucommu Forms", async () => {
    const fixture = await integrationFixture();
    const plan = await fixture.endpoint.plan(fixture.request);
    expect(plan.packages.map(({ formRef }) => [formRef.kind, formRef.definitionVersion])).toEqual(
      Object.entries(YURUCOMMU_FORM_VERSIONS),
    );
    expect(plan.commands).toHaveLength(2 + 12 * 3);
    expect(
      plan.commands
        .filter((command) => command.kind === "SetActivation")
        .every(
          (command) =>
            command.audience.kind === "space" &&
            command.audience.value ===
              JSON.stringify({ space: "space-yurucommu", tenantId: "tenant-yurucommu" }),
        ),
    ).toBe(true);

    const applied = await fixture.endpoint.apply(plan);
    expect(applied.status).toBe("converged");
    expect(applied.readback.forms).toHaveLength(12);
    expect(
      applied.readback.forms.every(
        (form) =>
          form.installed &&
          form.supported &&
          form.activationHead.present &&
          form.activationHead.active,
      ),
    ).toBe(true);
    expect(
      applied.receipts.every(
        (receipt) =>
          receipt.policyAuthority === "takoserver-host" &&
          receipt.verificationMode === "integration-fixture" &&
          receipt.productionEligible === false,
      ),
    ).toBe(true);
    expect(applied.nextPlan.commands).toEqual([]);
  });

  test("reseals support only when the public Worker Version advances", async () => {
    const sql = createEphemeralSql();
    const objects = createMemoryObjectStore();
    const original = await integrationFixture({ sql, objects });
    expect(
      (await original.endpoint.apply(await original.endpoint.plan(original.request))).status,
    ).toBe("converged");
    const advanced = await createIntegrationFormAuthorityComposition({
      configuration: {
        environment: "integration",
        hostId: original.identity.hostId,
        workerArtifactDigest: original.identity.workerArtifactDigest,
        publicWorkerVersionId: DRIFTED_PUBLIC_VERSION_ID,
        capabilities: CAPABILITIES,
      },
      bindings: {
        sql,
        objects,
        publicHostIdentity: {
          async identity() {
            return {
              kind: "takoserver.public-host-identity@v1",
              hostId: original.identity.hostId,
              workerVersionId: DRIFTED_PUBLIC_VERSION_ID,
            };
          },
        },
      },
    });
    const request: FormAuthorityPlanRequest = {
      ...original.request,
      ...advanced.identity,
    };

    const before = await advanced.endpoint.readback(request);
    expect(
      before.forms.every(
        (form) =>
          form.installed &&
          !form.supported &&
          form.activationHead.present &&
          form.activationHead.active,
      ),
    ).toBe(true);
    const plan = await advanced.endpoint.plan(request);
    expect(plan.commands).toHaveLength(12);
    expect(plan.commands.every((command) => command.kind === "SetSupport")).toBe(true);
    const applied = await advanced.endpoint.apply(plan);
    expect(applied.status).toBe("converged");
    expect(applied.nextPlan.commands).toEqual([]);
    expect(
      applied.readback.forms.every(
        (form) =>
          form.installed &&
          form.supported &&
          form.activationHead.present &&
          form.activationHead.active,
      ),
    ).toBe(true);
    expect(
      (await sql.query("SELECT COUNT(*) AS count FROM tf_form_install_events"))[0]?.count,
    ).toBe(12);
    expect(
      (await sql.query("SELECT COUNT(*) AS count FROM tf_form_activation_events"))[0]?.count,
    ).toBe(12);
    expect(
      (await sql.query("SELECT COUNT(*) AS count FROM tf_form_support_events"))[0]?.count,
    ).toBe(24);
  });

  test("moves all Forms to a stable publisher generation while resealing the public Version", async () => {
    const baseSql = createEphemeralSql();
    let failReplacementAt: number | undefined;
    let replacementWrites = 0;
    const sql: Sql = {
      query: (statement, params) => baseSql.query(statement, params),
      async run(statement, params) {
        if (
          failReplacementAt !== undefined &&
          statement.includes("INSERT INTO tf_form_install_events")
        ) {
          replacementWrites += 1;
          if (replacementWrites === failReplacementAt) {
            failReplacementAt = undefined;
            const error = new Error("synthetic replacement outage") as Error & { code: string };
            error.code = "guarded_write_unavailable";
            throw error;
          }
        }
        return await baseSql.run(statement, params);
      },
      batch: (statements) => baseSql.batch(statements),
    };
    const objects = createMemoryObjectStore();
    const original = await integrationFixture({ sql, objects });
    expect(
      (await original.endpoint.apply(await original.endpoint.plan(original.request))).status,
    ).toBe("converged");
    const advanced = await createIntegrationFormAuthorityComposition({
      configuration: {
        environment: "integration",
        hostId: original.identity.hostId,
        workerArtifactDigest: original.identity.workerArtifactDigest,
        publicWorkerVersionId: DRIFTED_PUBLIC_VERSION_ID,
        capabilities: CAPABILITIES,
      },
      bindings: {
        sql,
        objects,
        publicHostIdentity: {
          async identity() {
            return {
              kind: "takoserver.public-host-identity@v1",
              hostId: original.identity.hostId,
              workerVersionId: DRIFTED_PUBLIC_VERSION_ID,
            };
          },
        },
      },
    });
    const evidence = trustEvidence();
    const request: FormAuthorityPlanRequest = {
      ...original.request,
      ...advanced.identity,
      evidence: {
        ...evidence,
        publisher: {
          ...evidence.publisher,
          publisherKey: "publisher-stable-corpus-generation",
          sourceRepository: "https://github.com/tako0614/takoform-forms.git",
          ref: `git:${"d".repeat(40)}`,
          sourceCommit: "d".repeat(40),
          workflowCommit: "d".repeat(40),
          buildConfigCommit: "d".repeat(40),
          repositoryIdentifier: "repo:tako0614/takoform-forms",
        },
      },
    };

    const plan = await advanced.endpoint.plan(request);
    expect(plan.commands).toHaveLength(2 + 12 * 2);
    expect(plan.commands.slice(0, 2).map((command) => command.kind)).toEqual([
      "AllowPublisher",
      "AppendCheckpoint",
    ]);
    expect(plan.commands.slice(2).map((command) => command.kind)).toEqual(
      Array.from({ length: 12 }, () => ["ReplacePackage", "SetSupport"] as const).flat(),
    );

    failReplacementAt = 3;
    const partial = await advanced.endpoint.apply(plan);
    expect(partial.status).toBe("partial");
    expect(partial.receipts.map((receipt) => receipt.kind)).toEqual([
      "AllowPublisher",
      "AppendCheckpoint",
      "ReplacePackage",
      "SetSupport",
      "ReplacePackage",
      "SetSupport",
    ]);
    expect(partial.nextPlan.commands).toHaveLength(10 * 2);
    expect(partial.nextPlan.commands.map((command) => command.kind)).toEqual(
      Array.from({ length: 10 }, () => ["ReplacePackage", "SetSupport"] as const).flat(),
    );

    const applied = await advanced.endpoint.apply(partial.nextPlan);
    expect(applied.status).toBe("converged");
    expect(applied.nextPlan.commands).toEqual([]);
    expect(
      applied.readback.forms.every(
        (form) =>
          form.installed &&
          form.supported &&
          form.activationHead.present &&
          form.activationHead.active,
      ),
    ).toBe(true);
    expect(
      (await sql.query("SELECT COUNT(*) AS count FROM tf_form_publisher_events"))[0]?.count,
    ).toBe(2);
    expect(
      (await sql.query("SELECT COUNT(*) AS count FROM tf_form_revocation_checkpoints"))[0]?.count,
    ).toBe(2);
    expect(
      (await sql.query("SELECT COUNT(*) AS count FROM tf_form_install_events"))[0]?.count,
    ).toBe(24);
    expect(
      (await sql.query("SELECT COUNT(*) AS count FROM tf_form_support_events"))[0]?.count,
    ).toBe(24);
    expect(
      (await sql.query("SELECT COUNT(*) AS count FROM tf_form_activation_events"))[0]?.count,
    ).toBe(12);
  });

  test("converges exact-existing R2 package bytes only after readback and replan", async () => {
    const baseSql = createEphemeralSql();
    let failFirstInstall = true;
    const sql: Sql = {
      query: (statement, params) => baseSql.query(statement, params),
      async run(statement, params) {
        if (failFirstInstall && statement.includes("INSERT INTO tf_form_install_events")) {
          failFirstInstall = false;
          const error = new Error("synthetic guarded D1 outage") as Error & { code: string };
          error.code = "guarded_write_unavailable";
          throw error;
        }
        return await baseSql.run(statement, params);
      },
      batch: (statements) => baseSql.batch(statements),
    };
    const objects = createMemoryObjectStore();
    const fixture = await integrationFixture({ sql, objects });
    const first = await fixture.endpoint.apply(await fixture.endpoint.plan(fixture.request));
    expect(first.status).toBe("partial");
    expect(first.receipts.map((receipt) => receipt.kind)).toEqual([
      "AllowPublisher",
      "AppendCheckpoint",
    ]);
    expect(first.nextPlan.commands[0]?.kind).toBe("InstallPackage");
    const afterFailure = await objects.list({ prefix: "formpkg/", limit: 1_000 });
    expect(afterFailure.objects.length).toBeGreaterThan(0);

    const second = await fixture.endpoint.apply(first.nextPlan);
    expect(second.status).toBe("converged");
    expect(second.nextPlan.commands).toEqual([]);
    expect(
      second.readback.forms.every(
        (form) =>
          form.installed &&
          form.supported &&
          form.activationHead.present &&
          form.activationHead.active,
      ),
    ).toBe(true);
  });

  test("treats an absent or changed R2 closure as non-converged authority", async () => {
    const objects = createMemoryObjectStore();
    const fixture = await integrationFixture({ objects });
    expect(
      (await fixture.endpoint.apply(await fixture.endpoint.plan(fixture.request))).status,
    ).toBe("converged");
    const listed = await objects.list({ prefix: "formpkg/", limit: 1_000 });
    const index = listed.objects.find((object) => object.key.endsWith("/package-index.json"));
    if (!index) throw new Error("stored package index missing");
    await objects.delete(index.key);

    const missing = await fixture.endpoint.readback(fixture.request);
    expect(
      missing.forms.some(
        (form) =>
          !form.installed &&
          !form.supported &&
          form.activationHead.present &&
          form.activationHead.active,
      ),
    ).toBe(true);
    const repair = await fixture.endpoint.plan(fixture.request);
    expect(repair.commands[0]?.kind).toBe("ReplacePackage");
    expect((await fixture.endpoint.apply(repair)).status).toBe("converged");

    const payloads = (
      await objects.list({ prefix: index.key.replace(/package-index\.json$/u, ""), limit: 1_000 })
    ).objects.filter((object) => !object.key.endsWith("/package-index.json"));
    const payload = payloads[0];
    if (!payload) throw new Error("stored package payload missing");
    await objects.put(payload.key, new TextEncoder().encode("tampered"));
    const installCount = (
      await fixture.sql.query("SELECT COUNT(*) AS count FROM tf_form_install_events")
    )[0]?.count;
    const supportCount = (
      await fixture.sql.query("SELECT COUNT(*) AS count FROM tf_form_support_events")
    )[0]?.count;
    const failed = await fixture.endpoint.apply(await fixture.endpoint.plan(fixture.request));
    expect(failed.status).toBe("partial");
    expect(failed.receipts).toEqual([]);
    expect(
      (await fixture.sql.query("SELECT COUNT(*) AS count FROM tf_form_install_events"))[0]?.count,
    ).toBe(installCount);
    expect(
      (await fixture.sql.query("SELECT COUNT(*) AS count FROM tf_form_support_events"))[0]?.count,
    ).toBe(supportCount);
  });

  test("rejects a public Worker identity drift before D1 or R2 mutation", async () => {
    const sql = createEphemeralSql();
    const objects = createMemoryObjectStore();
    const original = await integrationFixture({ sql, objects });
    const drifted = await createIntegrationFormAuthorityComposition({
      configuration: {
        environment: "integration",
        hostId: original.identity.hostId,
        workerArtifactDigest: digest("6"),
        publicWorkerVersionId: PUBLIC_VERSION_ID,
        capabilities: CAPABILITIES,
      },
      bindings: {
        sql,
        objects,
        publicHostIdentity: {
          async identity() {
            return {
              kind: "takoserver.public-host-identity@v1",
              hostId: original.identity.hostId,
              workerVersionId: PUBLIC_VERSION_ID,
            };
          },
        },
      },
    });
    await expect(
      drifted.endpoint.apply(await original.endpoint.plan(original.request)),
    ).rejects.toMatchObject({
      code: "identity_mismatch",
    });
    expect(await sql.query("SELECT * FROM tf_form_publisher_events")).toEqual([]);
    expect((await objects.list({ prefix: "formpkg/", limit: 1_000 })).objects).toEqual([]);
  });

  test("rejects a live public Worker Version drift before any authority read", async () => {
    const sql = createEphemeralSql();
    const objects = createMemoryObjectStore();
    const original = await integrationFixture({ sql, objects });
    const staleAuthority = await createIntegrationFormAuthorityComposition({
      configuration: {
        environment: "integration",
        hostId: original.identity.hostId,
        workerArtifactDigest: original.identity.workerArtifactDigest,
        publicWorkerVersionId: PUBLIC_VERSION_ID,
        capabilities: CAPABILITIES,
      },
      bindings: {
        sql,
        objects,
        publicHostIdentity: {
          async identity() {
            return {
              kind: "takoserver.public-host-identity@v1",
              hostId: original.identity.hostId,
              workerVersionId: DRIFTED_PUBLIC_VERSION_ID,
            };
          },
        },
      },
    });

    await expect(staleAuthority.endpoint.plan(original.request)).rejects.toMatchObject({
      code: "identity_mismatch",
    });
    expect(await sql.query("SELECT * FROM tf_form_publisher_events")).toEqual([]);
    expect((await objects.list({ prefix: "formpkg/", limit: 1_000 })).objects).toEqual([]);
  });
});

test("production composition plans exact Forms but apply remains adapter-fail-closed", async () => {
  const sql = createEphemeralSql();
  const objects = createMemoryObjectStore();
  const composition = await createProductionFormAuthorityComposition({
    configuration: {
      environment: "production",
      hostId: "takoserver-production",
      workerArtifactDigest: digest("7"),
      publicWorkerVersionId: PUBLIC_VERSION_ID,
      capabilities: CAPABILITIES,
    },
    bindings: {
      sql,
      objects,
      publicHostIdentity: {
        async identity() {
          return {
            kind: "takoserver.public-host-identity@v1",
            hostId: "takoserver-production",
            workerVersionId: PUBLIC_VERSION_ID,
          };
        },
      },
    },
  });
  const request: FormAuthorityPlanRequest = {
    kind: "takoserver.form-authority-plan-request@v2",
    ...composition.identity,
    activation: {
      kind: "space",
      tenantId: "tenant-yurucommu",
      space: "space-yurucommu",
      desiredActive: true,
    },
    evidence: trustEvidence(),
    actor: "production-operator",
    reason: "prove the released-adapter refusal",
  };
  const plan = await composition.endpoint.plan(request);
  expect(plan.packages).toHaveLength(12);
  await expect(composition.endpoint.apply(plan)).rejects.toMatchObject({
    code: "production_not_ready",
  });
  expect(await sql.query("SELECT * FROM tf_form_publisher_events")).toEqual([]);
  expect((await objects.list({ prefix: "formpkg/", limit: 1_000 })).objects).toEqual([]);
});
