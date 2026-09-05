import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { signedFormAuthorityRpcInvocation } from "../src/form-authority-operator-proof.ts";
import {
  createIntegrationFormAuthorityCompositionFromWorkerEnv,
  type IntegrationFormAuthorityRawWorkerEnv,
  invokeAuthenticatedIntegrationFormAuthorityFromWorkerEnv,
} from "../src/form-authority-worker-composition.ts";
import { INTEGRATION_FORM_PACKAGES } from "../src/generated/takoform-integration-form-packages.ts";
import { canonicalDigest, canonicalJson } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";
import type { ObjectStore, Sql } from "../src/ports.ts";
import {
  derivePublicFormImplementationIdentity,
  deriveRuntimeImplementationCatalog,
} from "../src/public-worker-implementation.ts";
import {
  TAKOFORM_REVOCATION_V1,
  TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
  TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
} from "../src/takoform/admission.ts";
import type { FormAuthorityVerificationEvidence } from "../src/takoform/form-authority-verification.ts";
import type { FormAuthorityPlanRequest } from "../src/takoform/host-admission-coordinator.ts";
import {
  createProductionFormAuthorityComposition,
  deriveFormAuthorityIdentity,
  type FormAuthorityEndpointConfiguration,
} from "../src/takoform/host-admission-endpoint.ts";
import {
  YURUCOMMU_IDENTITY_CAPABILITY_KINDS,
  yurucommuLifecycleCapabilityManifest,
} from "../src/takoform/implementation-catalog.ts";
import { createIntegrationFormAuthorityComposition } from "../src/takoform/integration-operator-endpoint.ts";
import { loadPublisherSetClosure } from "../src/takoform/publisher-set-closure.ts";

const digest = (hex: string) => `sha256:${hex.repeat(64)}` as const;
/**
 * A distinct bundle digest per fixture package, for any corpus size. Cycling a
 * single hex character was unique only while the corpus stayed under sixteen
 * packages, and it also collided with the fixed digests above.
 */
const packageBundleDigest = (index: number): `sha256:${string}` =>
  `sha256:${index.toString(16).padStart(64, "b")}`;
const PUBLIC_VERSION_ID = "00000000-0000-4000-8000-000000000001";
const DRIFTED_PUBLIC_VERSION_ID = "00000000-0000-4000-8000-000000000002";
const CAPABILITIES = yurucommuLifecycleCapabilityManifest(YURUCOMMU_IDENTITY_CAPABILITY_KINDS);
const TEST_IMPLEMENTATION_DIGEST = digest("9");
const TEST_IMPLEMENTATION_PAYLOAD_DIGEST = digest("8");
const PACKAGE_COUNT = INTEGRATION_FORM_PACKAGES.length;
const EXPECTED_IMPLEMENTATION_CATALOG = await deriveRuntimeImplementationCatalog({
  implementationPayloadDigest: TEST_IMPLEMENTATION_PAYLOAD_DIGEST,
  capabilities: CAPABILITIES,
});
const IMPLEMENTED_KINDS = new Set<string>(
  EXPECTED_IMPLEMENTATION_CATALOG.entries.map((entry) => entry.formRef.kind),
);
const IMPLEMENTED_COUNT = IMPLEMENTED_KINDS.size;
const UNIMPLEMENTED_KINDS = new Set<string>(
  INTEGRATION_FORM_PACKAGES.map((pkg) => pkg.formRef.kind).filter(
    (kind) => !IMPLEMENTED_KINDS.has(kind),
  ),
);

async function buildConfiguration(
  input: Omit<
    FormAuthorityEndpointConfiguration,
    "implementationPayloadDigest" | "implementationDigest"
  >,
): Promise<FormAuthorityEndpointConfiguration> {
  const semantic = await derivePublicFormImplementationIdentity({
    implementationPayloadDigest: TEST_IMPLEMENTATION_PAYLOAD_DIGEST,
    capabilities: input.capabilities,
  });
  return {
    ...input,
    implementationPayloadDigest: semantic.implementationPayloadDigest,
    implementationDigest: semantic.implementationDigest,
  };
}

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
    packageBundleDigests: INTEGRATION_FORM_PACKAGES.map((pkg, index) => ({
      formRef: structuredClone(pkg.formRef),
      packageDigest: pkg.packageDigest,
      bundleDigest: packageBundleDigest(index),
    })),
  };
}

async function integrationFixture(input?: { readonly sql?: Sql; readonly objects?: ObjectStore }) {
  const sql = input?.sql ?? createEphemeralSql();
  const objects = input?.objects ?? createMemoryObjectStore();
  const hostId = "takoserver-yurucommu-integration";
  const configuration = await buildConfiguration({
    environment: "integration",
    hostId,
    workerArtifactDigest: digest("5"),
    publicWorkerVersionId: PUBLIC_VERSION_ID,
    capabilities: CAPABILITIES,
  });
  const live = await identityFor(configuration);
  const composition = await createIntegrationFormAuthorityComposition({
    configuration,
    bindings: {
      sql,
      objects,
      publicHostIdentity: {
        async identity() {
          return live;
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
    reason: "activate the exact publisher integration fixture",
  };
  return { ...composition, request, sql, objects };
}

async function identityFor(configuration: FormAuthorityEndpointConfiguration) {
  const identity = await deriveFormAuthorityIdentity(configuration);
  const semantic = await derivePublicFormImplementationIdentity({
    implementationPayloadDigest: configuration.implementationPayloadDigest,
    capabilities: configuration.capabilities,
  });
  return {
    kind: "takoserver.public-host-identity@v2" as const,
    hostId: identity.hostId,
    workerVersionId: identity.publicWorkerVersionId,
    workerArtifactDigest: identity.workerArtifactDigest,
    implementationPayloadDigest: semantic.implementationPayloadDigest,
    capabilityDigest: semantic.capabilityDigest,
    implementationDigest: identity.implementationDigest,
  };
}

interface ReadbackFormConvergence {
  readonly formRef: { readonly kind: string };
  readonly installed: boolean;
  readonly supported: boolean;
  readonly activationHead: {
    readonly present: boolean;
    readonly active: boolean;
    readonly implementationDigest: string | null;
  };
}

function isConvergedForm(form: ReadbackFormConvergence): boolean {
  return (
    form.installed &&
    (IMPLEMENTED_KINDS.has(form.formRef.kind)
      ? form.supported && form.activationHead.present && form.activationHead.active
      : UNIMPLEMENTED_KINDS.has(form.formRef.kind) &&
        !form.supported &&
        !form.activationHead.present &&
        !form.activationHead.active)
  );
}

function isConvergedFormWithDigest(
  form: ReadbackFormConvergence,
  implementationDigest: string,
): boolean {
  return (
    isConvergedForm(form) &&
    (!IMPLEMENTED_KINDS.has(form.formRef.kind) ||
      form.activationHead.implementationDigest === implementationDigest)
  );
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
        implementationDigest: TEST_IMPLEMENTATION_DIGEST,
      },
      nowSeconds: now,
      lifetimeSeconds: 60,
    });
    const reads: string[] = [];
    const env = {
      TAKOSERVER_ENVIRONMENT: "integration",
      TAKOSERVER_FORM_AUTHORITY_HOST_ID: hostId,
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
        return {
          async identity() {
            return {
              kind: "takoserver.public-host-identity@v2" as const,
              hostId,
              workerVersionId: PUBLIC_VERSION_ID,
              workerArtifactDigest: artifact,
              implementationPayloadDigest: TEST_IMPLEMENTATION_PAYLOAD_DIGEST,
              capabilityDigest: digest("7"),
              implementationDigest: TEST_IMPLEMENTATION_DIGEST,
            };
          },
        };
      },
    } as unknown as IntegrationFormAuthorityRawWorkerEnv;

    await expect(
      invokeAuthenticatedIntegrationFormAuthorityFromWorkerEnv(
        env,
        "plan",
        signedFormAuthorityRpcInvocation({ action: "plan", assertion, body }),
      ),
    ).rejects.toMatchObject({ code: "invalid_operator_assertion" });
    expect(reads).toEqual(["public-host"]);
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
        implementationDigest: TEST_IMPLEMENTATION_DIGEST,
      },
      nowSeconds: now,
      lifetimeSeconds: 60,
    });
    const reads: string[] = [];
    const env = {
      TAKOSERVER_ENVIRONMENT: "integration",
      TAKOSERVER_FORM_AUTHORITY_HOST_ID: hostId,
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
        return {
          async identity() {
            return {
              kind: "takoserver.public-host-identity@v2" as const,
              hostId,
              workerVersionId: PUBLIC_VERSION_ID,
              workerArtifactDigest: artifact,
              implementationPayloadDigest: TEST_IMPLEMENTATION_PAYLOAD_DIGEST,
              capabilityDigest: digest("7"),
              implementationDigest: TEST_IMPLEMENTATION_DIGEST,
            };
          },
        };
      },
    } as unknown as IntegrationFormAuthorityRawWorkerEnv;

    await expect(
      invokeAuthenticatedIntegrationFormAuthorityFromWorkerEnv(
        env,
        "plan",
        signedFormAuthorityRpcInvocation({ action: "plan", assertion, body }),
      ),
    ).rejects.toMatchObject({ code: "operator_scope_mismatch" });
    expect(reads).toEqual(["public-host"]);
  });

  test("refuses an identity change between proof verification and composition before D1/R2", async () => {
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
        space: "space-yurucommu",
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
        implementationDigest: TEST_IMPLEMENTATION_DIGEST,
      },
      nowSeconds: now,
      lifetimeSeconds: 60,
    });
    let identityReads = 0;
    const privilegedReads: string[] = [];
    const env = {
      TAKOSERVER_ENVIRONMENT: "integration",
      TAKOSERVER_FORM_AUTHORITY_HOST_ID: hostId,
      TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: canonicalJson({
        kty: publicJwk.kty,
        crv: publicJwk.crv,
        x: publicJwk.x,
      }),
      TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID: "tenant-yurucommu",
      TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE: "space-yurucommu",
      PUBLIC_HOST_IDENTITY: {
        async identity() {
          identityReads += 1;
          return {
            kind: "takoserver.public-host-identity@v2" as const,
            hostId,
            workerVersionId: identityReads === 1 ? PUBLIC_VERSION_ID : DRIFTED_PUBLIC_VERSION_ID,
            workerArtifactDigest: artifact,
            implementationPayloadDigest: TEST_IMPLEMENTATION_PAYLOAD_DIGEST,
            capabilityDigest: digest("7"),
            implementationDigest: TEST_IMPLEMENTATION_DIGEST,
          };
        },
      },
      get TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST() {
        privilegedReads.push("capabilities");
        throw new Error("identity race must fail before capabilities");
      },
      get STATE_DB() {
        privilegedReads.push("d1");
        throw new Error("identity race must fail before D1");
      },
      get OBJECTS() {
        privilegedReads.push("r2");
        throw new Error("identity race must fail before R2");
      },
    } as unknown as IntegrationFormAuthorityRawWorkerEnv;

    await expect(
      invokeAuthenticatedIntegrationFormAuthorityFromWorkerEnv(
        env,
        "plan",
        signedFormAuthorityRpcInvocation({ action: "plan", assertion, body }),
      ),
    ).rejects.toMatchObject({ code: "identity_unavailable" });
    expect(identityReads).toBe(2);
    expect(privilegedReads).toEqual([]);
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

  test("installs the exact publisher set and activates only Forms with handlers", async () => {
    const fixture = await integrationFixture();
    const plan = await fixture.endpoint.plan(fixture.request);
    expect(plan.packages).toHaveLength(PACKAGE_COUNT);
    expect(
      Object.fromEntries(
        plan.packages.map(({ formRef }) => [formRef.kind, formRef.definitionVersion]),
      ),
    ).toEqual(
      Object.fromEntries(
        INTEGRATION_FORM_PACKAGES.map(({ formRef }) => [formRef.kind, formRef.definitionVersion]),
      ),
    );
    expect(plan.commands).toHaveLength(2 + PACKAGE_COUNT + IMPLEMENTED_COUNT * 2);
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
    expect(applied.readback.forms).toHaveLength(PACKAGE_COUNT);
    expect(applied.readback.forms.every(isConvergedForm)).toBe(true);
    expect(
      applied.receipts.every(
        (receipt) =>
          receipt.policyAuthority === "takoserver-host" &&
          receipt.verificationMode === "integration-fixture" &&
          receipt.productionEligible === false,
      ),
    ).toBe(true);
    const installReports = await fixture.sql.query(
      "SELECT admission_report_json FROM tf_form_install_events ORDER BY event_at, id",
    );
    const bundleDigests = new Set(
      installReports.map((row) => {
        const report = JSON.parse(String(row.admission_report_json)) as {
          readonly signature?: { readonly bundleDigest?: string };
        };
        return report.signature?.bundleDigest;
      }),
    );
    expect(installReports).toHaveLength(PACKAGE_COUNT);
    expect(bundleDigests.size).toBe(PACKAGE_COUNT);
    // The generator itself stays distinct past the current corpus, so this
    // count keeps meaning what it says as packages are added.
    expect(new Set(Array.from({ length: 64 }, (_, index) => packageBundleDigest(index))).size).toBe(
      64,
    );
    expect(applied.nextPlan.commands).toEqual([]);
  });

  test("keeps support converged when only the public Worker Version advances", async () => {
    const sql = createEphemeralSql();
    const objects = createMemoryObjectStore();
    const original = await integrationFixture({ sql, objects });
    expect(
      (await original.endpoint.apply(await original.endpoint.plan(original.request))).status,
    ).toBe("converged");
    const configuration = await buildConfiguration({
      environment: "integration",
      hostId: original.identity.hostId,
      workerArtifactDigest: original.identity.workerArtifactDigest,
      publicWorkerVersionId: DRIFTED_PUBLIC_VERSION_ID,
      capabilities: CAPABILITIES,
    });
    const live = await identityFor(configuration);
    const advanced = await createIntegrationFormAuthorityComposition({
      configuration,
      bindings: {
        sql,
        objects,
        publicHostIdentity: {
          async identity() {
            return live;
          },
        },
      },
    });
    const request: FormAuthorityPlanRequest = {
      ...original.request,
      ...advanced.identity,
    };

    const before = await advanced.endpoint.readback(request);
    expect(before.forms.every(isConvergedForm)).toBe(true);
    const plan = await advanced.endpoint.plan(request);
    expect(plan.commands).toEqual([]);
    const applied = await advanced.endpoint.apply(plan);
    expect(applied.status).toBe("converged");
    expect(applied.nextPlan.commands).toEqual([]);
    expect(applied.readback.forms.every(isConvergedForm)).toBe(true);
    expect(
      (await sql.query("SELECT COUNT(*) AS count FROM tf_form_install_events"))[0]?.count,
    ).toBe(PACKAGE_COUNT);
    expect(
      (await sql.query("SELECT COUNT(*) AS count FROM tf_form_activation_events"))[0]?.count,
    ).toBe(IMPLEMENTED_COUNT);
    expect(
      (await sql.query("SELECT COUNT(*) AS count FROM tf_form_support_events"))[0]?.count,
    ).toBe(IMPLEMENTED_COUNT);
  });

  test("keeps semantic support across outer artifact changes but reconverges capabilities", async () => {
    const changedCapabilities = yurucommuLifecycleCapabilityManifest(
      YURUCOMMU_IDENTITY_CAPABILITY_KINDS,
      { ModuleWorker: ["read"] },
    );
    for (const change of [
      { workerArtifactDigest: digest("6"), capabilities: CAPABILITIES, semanticChange: false },
      {
        workerArtifactDigest: digest("5"),
        capabilities: changedCapabilities,
        semanticChange: true,
      },
    ] as const) {
      const sql = createEphemeralSql();
      const objects = createMemoryObjectStore();
      const original = await integrationFixture({ sql, objects });
      expect(
        (await original.endpoint.apply(await original.endpoint.plan(original.request))).status,
      ).toBe("converged");
      const configuration = await buildConfiguration({
        environment: "integration",
        hostId: original.identity.hostId,
        publicWorkerVersionId: DRIFTED_PUBLIC_VERSION_ID,
        workerArtifactDigest: change.workerArtifactDigest,
        capabilities: change.capabilities,
      });
      const live = await identityFor(configuration);
      const changed = await createIntegrationFormAuthorityComposition({
        configuration,
        bindings: {
          sql,
          objects,
          publicHostIdentity: {
            async identity() {
              return live;
            },
          },
        },
      });
      const request = { ...original.request, ...changed.identity };

      const before = await changed.endpoint.readback(request);
      const plan = await changed.endpoint.plan(request);
      if (change.semanticChange) {
        expect(
          before.forms.every(
            (form) =>
              !form.installed &&
              !form.supported &&
              (IMPLEMENTED_KINDS.has(form.formRef.kind)
                ? form.activationHead.active
                : !form.activationHead.active),
          ),
        ).toBe(true);
        expect(plan.commands).toHaveLength(PACKAGE_COUNT + IMPLEMENTED_COUNT * 2);
        expect(plan.commands.filter(({ kind }) => kind === "ReplacePackage")).toHaveLength(
          PACKAGE_COUNT,
        );
        expect(plan.commands.filter(({ kind }) => kind === "SetSupport")).toHaveLength(
          IMPLEMENTED_COUNT,
        );
        expect(plan.commands.filter(({ kind }) => kind === "SetActivation")).toHaveLength(
          IMPLEMENTED_COUNT,
        );
        const applied = await changed.endpoint.apply(plan);
        expect(applied.status).toBe("converged");
        expect(applied.nextPlan.commands).toEqual([]);
        expect(
          applied.readback.forms.every((form) =>
            isConvergedFormWithDigest(form, changed.identity.implementationDigest),
          ),
        ).toBe(true);
      } else {
        expect(changed.identity.implementationDigest).toBe(original.identity.implementationDigest);
        expect(before.forms.every(isConvergedForm)).toBe(true);
        expect(plan.commands).toEqual([]);
      }
    }
  });

  test("moves all Forms to a stable publisher generation without resealing a config-only public Version", async () => {
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
    const configuration = await buildConfiguration({
      environment: "integration",
      hostId: original.identity.hostId,
      workerArtifactDigest: original.identity.workerArtifactDigest,
      publicWorkerVersionId: DRIFTED_PUBLIC_VERSION_ID,
      capabilities: CAPABILITIES,
    });
    const live = await identityFor(configuration);
    const advanced = await createIntegrationFormAuthorityComposition({
      configuration,
      bindings: {
        sql,
        objects,
        publicHostIdentity: {
          async identity() {
            return live;
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
    expect(plan.commands).toHaveLength(2 + PACKAGE_COUNT);
    expect(plan.commands.slice(0, 2).map((command) => command.kind)).toEqual([
      "AllowPublisher",
      "AppendCheckpoint",
    ]);
    expect(plan.commands.slice(2).map((command) => command.kind)).toEqual(
      Array.from({ length: PACKAGE_COUNT }, () => "ReplacePackage"),
    );

    failReplacementAt = 3;
    const partial = await advanced.endpoint.apply(plan);
    expect(partial.status).toBe("partial");
    expect(partial.receipts.map((receipt) => receipt.kind)).toEqual([
      "AllowPublisher",
      "AppendCheckpoint",
      "ReplacePackage",
      "ReplacePackage",
    ]);
    expect(partial.nextPlan.commands).toHaveLength(PACKAGE_COUNT - 2);
    expect(partial.nextPlan.commands.map((command) => command.kind)).toEqual(
      Array.from({ length: PACKAGE_COUNT - 2 }, () => "ReplacePackage"),
    );

    const applied = await advanced.endpoint.apply(partial.nextPlan);
    expect(applied.status).toBe("converged");
    expect(applied.nextPlan.commands).toEqual([]);
    expect(applied.readback.forms.every(isConvergedForm)).toBe(true);
    expect(
      (await sql.query("SELECT COUNT(*) AS count FROM tf_form_publisher_events"))[0]?.count,
    ).toBe(2);
    expect(
      (await sql.query("SELECT COUNT(*) AS count FROM tf_form_revocation_checkpoints"))[0]?.count,
    ).toBe(2);
    expect(
      (await sql.query("SELECT COUNT(*) AS count FROM tf_form_install_events"))[0]?.count,
    ).toBe(PACKAGE_COUNT * 2);
    expect(
      (await sql.query("SELECT COUNT(*) AS count FROM tf_form_support_events"))[0]?.count,
    ).toBe(IMPLEMENTED_COUNT);
    expect(
      (await sql.query("SELECT COUNT(*) AS count FROM tf_form_activation_events"))[0]?.count,
    ).toBe(IMPLEMENTED_COUNT);
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
    expect(second.readback.forms.every(isConvergedForm)).toBe(true);
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
          !form.activationHead.present &&
          !form.activationHead.active,
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
    const configuration = await buildConfiguration({
      environment: "integration",
      hostId: original.identity.hostId,
      workerArtifactDigest: digest("6"),
      publicWorkerVersionId: PUBLIC_VERSION_ID,
      capabilities: CAPABILITIES,
    });
    const live = await identityFor(configuration);
    const drifted = await createIntegrationFormAuthorityComposition({
      configuration,
      bindings: {
        sql,
        objects,
        publicHostIdentity: {
          async identity() {
            return live;
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

  test("refuses an identity change between composition and endpoint before any authority read", async () => {
    const sql = createEphemeralSql();
    const objects = createMemoryObjectStore();
    const original = await integrationFixture({ sql, objects });
    const configuration = await buildConfiguration({
      environment: "integration",
      hostId: original.identity.hostId,
      workerArtifactDigest: original.identity.workerArtifactDigest,
      publicWorkerVersionId: PUBLIC_VERSION_ID,
      capabilities: CAPABILITIES,
    });
    const live = {
      ...(await identityFor(configuration)),
      workerVersionId: DRIFTED_PUBLIC_VERSION_ID,
    };
    const staleAuthority = await createIntegrationFormAuthorityComposition({
      configuration,
      bindings: {
        sql,
        objects,
        publicHostIdentity: {
          async identity() {
            return live;
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
  const configuration = await buildConfiguration({
    environment: "production",
    hostId: "takoserver-production",
    workerArtifactDigest: digest("7"),
    publicWorkerVersionId: PUBLIC_VERSION_ID,
    capabilities: CAPABILITIES,
  });
  const live = await identityFor(configuration);
  const composition = await createProductionFormAuthorityComposition({
    configuration,
    bindings: {
      sql,
      objects,
      publicHostIdentity: {
        async identity() {
          return live;
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
    evidence: (await loadPublisherSetClosure()).evidence,
    actor: "production-operator",
    reason: "prove the released-adapter refusal",
  };
  const plan = await composition.endpoint.plan(request);
  expect(plan.packages).toHaveLength(17);
  expect(plan.packages.some((entry) => entry.formRef.kind === "ObjectBucket")).toBe(true);
  await expect(composition.endpoint.apply(plan)).rejects.toMatchObject({
    code: "production_not_ready",
  });
  await expect(
    composition.endpoint.plan({ ...request, evidence: trustEvidence() }),
  ).rejects.toMatchObject({ code: "invalid_request" });
  expect(await sql.query("SELECT * FROM tf_form_publisher_events")).toEqual([]);
  expect((await objects.list({ prefix: "formpkg/", limit: 1_000 })).objects).toEqual([]);
});
