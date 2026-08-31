import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effectiveSigningKeyId,
  expectedWorkerSecrets,
  writeWorkerConfig,
} from "../scripts/deploy/realized-config.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { INTEGRATION_E2E_ORGANIZATION_ID } from "../src/integration-e2e-credential-authority.ts";
import { YURUCOMMU_IDENTITY_CAPABILITY_KINDS } from "../src/takoform/implementation-catalog.ts";

const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "production",
  accountId: "a".repeat(32),
  workerName: "takoserver-api",
  d1: { databaseName: "takoserver-runtime", databaseId: "00000000-0000-4000-8000-000000000000" },
  r2: { bucketName: "takoserver-objects" },
  publicOrigin: "https://api.takoserver.example",
  signing: { currentKeyId: "key-current", nextKeyId: "key-next" },
  sponsorship: true,
} satisfies DeployTarget;

describe("realized Worker configuration", () => {
  test("realizes the independent public Worker with no service binding", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-config-v2-"));
    try {
      const path = writeWorkerConfig(target, {
        path: join(root, "wrangler.jsonc"),
        main: join(root, "worker.js"),
        commit: "a".repeat(40),
      });
      const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(effectiveSigningKeyId(target)).toBe("key-current");
      expect(config.vars).toMatchObject({ TAKOSERVER_SIGNING_KEY_ID: "key-current" });
      expect(config).not.toHaveProperty("services");
      expect(config.secrets).toEqual({
        required: ["TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN", "TAKOSERVER_SIGNING_KEY"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not infer sponsorship or a service route for a standalone target", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-config-token-"));
    try {
      const { sponsorship: _sponsorship, ...standalone } = target;
      const path = writeWorkerConfig(standalone, {
        path: join(root, "wrangler.jsonc"),
        main: join(root, "worker.js"),
        commit: "a".repeat(40),
        signingKeyId: "key-current",
      });
      const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(config).not.toHaveProperty("services");
      expect(config.vars).toMatchObject({ TAKOSERVER_SIGNING_KEY_ID: "key-current" });
      expect(config.secrets).toEqual({ required: ["TAKOSERVER_SIGNING_KEY"] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not half-configure public Form identity without artifact provenance", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-config-form-identity-"));
    try {
      const path = writeWorkerConfig(
        {
          ...target,
          formAuthority: {
            workerName: "takoserver-form-authority-production",
            identityProbeWorkerName: "takoserver-form-identity-production",
            identityProbeOrigin:
              "https://takoserver-form-identity-production.production.example.workers.dev",
            hostId: target.publicOrigin,
          },
        },
        {
          path: join(root, "wrangler.jsonc"),
          main: join(root, "worker.js"),
          commit: "a".repeat(40),
        },
      );
      const config = JSON.parse(readFileSync(path, "utf8")) as {
        vars: Record<string, string>;
      };
      expect(config.vars.TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST).toBeUndefined();
      expect(config.vars.TAKOSERVER_WORKER_ARTIFACT_DIGEST).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("realizes complete build-derived public identity in rehearsal and production", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-config-form-identity-all-env-"));
    const semantic = {
      implementationPayloadDigest: `sha256:${"1".repeat(64)}` as const,
      capabilityDigest: `sha256:${"2".repeat(64)}` as const,
      implementationDigest: `sha256:${"3".repeat(64)}` as const,
    };
    const workerArtifactDigest = `sha256:${"4".repeat(64)}` as const;
    try {
      for (const environment of ["rehearsal", "production"] as const) {
        const selected = {
          ...target,
          environment,
          formAuthority: {
            workerName: `takoserver-form-authority-${environment}`,
            identityProbeWorkerName: `takoserver-form-identity-${environment}`,
            identityProbeOrigin: `https://takoserver-form-identity-${environment}.${environment}.example.workers.dev`,
            hostId: target.publicOrigin,
          },
        } satisfies DeployTarget;
        const path = writeWorkerConfig(selected, {
          path: join(root, `${environment}.json`),
          main: "worker.js",
          commit: "a".repeat(40),
          formImplementationIdentity: semantic,
          workerArtifactDigest,
        });
        const config = JSON.parse(readFileSync(path, "utf8")) as {
          vars: Record<string, string>;
          define: Record<string, string>;
        };
        expect(config.vars.TAKOSERVER_WORKER_ARTIFACT_DIGEST).toBe(workerArtifactDigest);
        expect(config.define).toEqual({
          TAKOSERVER_BUILD_FORM_IMPLEMENTATION_DIGEST: JSON.stringify(
            semantic.implementationDigest,
          ),
          TAKOSERVER_BUILD_FORM_CAPABILITY_DIGEST: JSON.stringify(semantic.capabilityDigest),
          TAKOSERVER_BUILD_FORM_IMPLEMENTATION_PAYLOAD_DIGEST: JSON.stringify(
            semantic.implementationPayloadDigest,
          ),
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("realizes a version-only config without topology controls", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-config-version-only-"));
    const semantic = {
      implementationPayloadDigest: `sha256:${"1".repeat(64)}` as const,
      capabilityDigest: `sha256:${"2".repeat(64)}` as const,
      implementationDigest: `sha256:${"3".repeat(64)}` as const,
    };
    const workerArtifactDigest = `sha256:${"4".repeat(64)}` as const;
    try {
      const formTarget = {
        ...target,
        formAuthority: {
          workerName: "takoserver-form-authority-production",
          identityProbeWorkerName: "takoserver-form-identity-production",
          identityProbeOrigin:
            "https://takoserver-form-identity-production.production.example.workers.dev",
          hostId: target.publicOrigin,
        },
      } satisfies DeployTarget;
      const path = writeWorkerConfig(formTarget, {
        path: join(root, "wrangler.jsonc"),
        main: join(root, "worker.js"),
        commit: "a".repeat(40),
        topology: "version-only",
        formImplementationIdentity: semantic,
        workerArtifactDigest,
      });
      const config = JSON.parse(readFileSync(path, "utf8")) as {
        name: string;
        d1_databases?: unknown;
        r2_buckets?: unknown;
        vars: Record<string, string>;
        define: Record<string, string>;
        [key: string]: unknown;
      };
      for (const key of [
        "routes",
        "route",
        "custom_domains",
        "domains",
        "workers_dev",
        "workers_dev_subdomain",
        "triggers",
      ]) {
        expect(config).not.toHaveProperty(key);
      }
      expect(config.name).toBe(formTarget.workerName);
      expect(config.d1_databases).toBeDefined();
      expect(config.r2_buckets).toBeDefined();
      expect(config.vars.TAKOSERVER_WORKER_ARTIFACT_DIGEST).toBe(workerArtifactDigest);
      expect(config.define).toEqual({
        TAKOSERVER_BUILD_FORM_IMPLEMENTATION_DIGEST: JSON.stringify(semantic.implementationDigest),
        TAKOSERVER_BUILD_FORM_CAPABILITY_DIGEST: JSON.stringify(semantic.capabilityDigest),
        TAKOSERVER_BUILD_FORM_IMPLEMENTATION_PAYLOAD_DIGEST: JSON.stringify(
          semantic.implementationPayloadDigest,
        ),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("derives an exact secret inventory from enabled product capabilities", () => {
    expect(expectedWorkerSecrets(target)).toEqual([
      "TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN",
      "TAKOSERVER_SIGNING_KEY",
    ]);
    const { sponsorship: _sponsorship, ...withoutSponsorship } = target;
    expect(
      expectedWorkerSecrets({
        ...withoutSponsorship,
        stripeCheckout: true,
        r2ParentAccessKeyId: "parent-key",
      }),
    ).toEqual(["STRIPE_SECRET_KEY", "TAKOSERVER_R2_PARENT_TOKEN", "TAKOSERVER_SIGNING_KEY"]);
  });

  test("adds the canonical operator public JWK only in desired identity state", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-config-identity-"));
    try {
      const identityTarget = {
        ...target,
        environment: "integration",
        operatorIdentity: {
          publicJwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: "A".repeat(43) },
        },
      } satisfies DeployTarget;
      const desiredPath = writeWorkerConfig(identityTarget, {
        path: join(root, "desired.json"),
        main: join(root, "worker.js"),
        commit: "a".repeat(40),
      });
      const { operatorIdentity: _operatorIdentity, ...withoutOperatorIdentity } = identityTarget;
      const absentPath = writeWorkerConfig(withoutOperatorIdentity, {
        path: join(root, "absent.json"),
        main: join(root, "worker.js"),
        commit: "a".repeat(40),
      });
      const desired = JSON.parse(readFileSync(desiredPath, "utf8")) as {
        vars: Record<string, string>;
      };
      const absent = JSON.parse(readFileSync(absentPath, "utf8")) as {
        vars: Record<string, string>;
      };
      expect(desired.vars.OPERATOR_IDENTITY_PUBLIC_JWK).toBe(
        JSON.stringify(identityTarget.operatorIdentity.publicJwk),
      );
      expect(desired.vars).not.toHaveProperty("OPERATOR_PUBLIC_JWK");
      expect(absent.vars).not.toHaveProperty("OPERATOR_IDENTITY_PUBLIC_JWK");
      const {
        OPERATOR_IDENTITY_PUBLIC_JWK: _operatorIdentityPublicJwk,
        ...desiredWithoutIdentity
      } = desired.vars;
      expect(desiredWithoutIdentity).toEqual(absent.vars);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("seals the complete integration JIT authority profile from target and artifact provenance", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-config-jit-authority-"));
    const sourceCommit = "b".repeat(40);
    const artifactDigest = `sha256:${"c".repeat(64)}` as const;
    const authorityTarget = {
      ...target,
      environment: "integration",
      edgeSupplies: {
        offerings: YURUCOMMU_IDENTITY_CAPABILITY_KINDS.map((formKind) => ({ formKind })),
      } as unknown as NonNullable<DeployTarget["edgeSupplies"]>,
      workerEndpointSuffix: "integration.example.workers.dev",
      formAuthority: {
        workerName: "takoserver-form-authority-integration",
        identityProbeWorkerName: "takoserver-form-identity-integration",
        identityProbeOrigin:
          "https://takoserver-form-identity-integration.integration.example.workers.dev",
        integrationWorkerName: "takoserver-form-fixture-integration",
        hostId: target.publicOrigin,
      },
      integrationE2eCredentialAuthority: {
        organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
        publicJwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: "E".repeat(43) },
      },
    } satisfies DeployTarget;
    try {
      expect(expectedWorkerSecrets(authorityTarget)).toContain(
        "TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING",
      );
      expect(() =>
        writeWorkerConfig(authorityTarget, {
          path: join(root, "missing.json"),
          main: join(root, "worker.js"),
          commit: sourceCommit,
        }),
      ).toThrow("explicit authority profile");
      expect(() =>
        writeWorkerConfig(
          { ...authorityTarget, environment: "production" },
          {
            path: join(root, "production.json"),
            main: join(root, "worker.js"),
            commit: sourceCommit,
            authorityProfile: {
              kind: "provenance-bound-jit",
              provenance: { sourceCommit, artifactDigest },
            },
          },
        ),
      ).toThrow("integration-only");

      const path = writeWorkerConfig(authorityTarget, {
        path: join(root, "complete.json"),
        main: join(root, "worker.js"),
        commit: sourceCommit,
        authorityProfile: {
          kind: "provenance-bound-jit",
          provenance: { sourceCommit, artifactDigest },
        },
      });
      const config = JSON.parse(readFileSync(path, "utf8")) as {
        vars: Record<string, string>;
      };
      expect(
        Object.fromEntries(
          Object.entries(config.vars).filter(([name]) =>
            [
              "TAKOSERVER_ENVIRONMENT",
              "TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK",
              "TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID",
              "TAKOSERVER_SOURCE_COMMIT",
              "TAKOSERVER_WORKER_ARTIFACT_DIGEST",
            ].includes(name),
          ),
        ),
      ).toEqual({
        TAKOSERVER_ENVIRONMENT: "integration",
        TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK: JSON.stringify(
          authorityTarget.integrationE2eCredentialAuthority.publicJwk,
        ),
        TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID: INTEGRATION_E2E_ORGANIZATION_ID,
        TAKOSERVER_SOURCE_COMMIT: sourceCommit,
        TAKOSERVER_WORKER_ARTIFACT_DIGEST: artifactDigest,
      });
      expect(JSON.stringify(config)).not.toContain('"d"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
