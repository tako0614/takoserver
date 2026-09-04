import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTarget, parseDeployTarget, targetPath } from "../scripts/deploy/target.ts";
import { ARTIFACT_RECOVERY_RETENTION_FORMAT } from "../src/artifact-recovery.ts";
import { INTEGRATION_E2E_ORGANIZATION_ID } from "../src/integration-e2e-credential-authority.ts";
import {
  cloudflareProviderExecutorTarget,
  edgeSuppliesFixture,
  objectBucketSuppliesFixture,
} from "./helpers/hosted-supply-fixtures.ts";

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    kind: "takoserver.deploy-target@v2",
    environment: "rehearsal",
    accountId: "a".repeat(32),
    workerName: "takoserver-api-rehearsal",
    d1: {
      databaseName: "takoserver-runtime-rehearsal",
      databaseId: "00000000-0000-4000-8000-000000000000",
    },
    r2: { bucketName: "takoserver-objects-rehearsal" },
    publicOrigin: "https://takoserver-api-rehearsal.example.workers.dev",
    consoleOrigin: "https://console-rehearsal.example.test",
    signing: { currentKeyId: "takoserver-rehearsal-2026-08" },
    sponsorship: true,
    ...overrides,
  };
}

function withTarget(value: unknown, run: (path: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "takoserver-target-v2-"));
  try {
    const path = join(root, "target.json");
    writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    run(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("environment-exact deploy target", () => {
  test("loads the selected environment and product-owned sponsorship state", () => {
    withTarget(descriptor(), (path) => {
      expect(loadTarget(path, "rehearsal")).toMatchObject({
        environment: "rehearsal",
        signing: { currentKeyId: "takoserver-rehearsal-2026-08" },
        sponsorship: true,
      });
    });
  });

  test("accepts only the explicit pre-0043 artifact I/O compatibility mode", () => {
    withTarget(descriptor({ artifactBlobIoMode: "pre-0043-quiesced" }), (path) => {
      expect(loadTarget(path, "rehearsal").artifactBlobIoMode).toBe("pre-0043-quiesced");
    });
    withTarget(descriptor({ artifactBlobIoMode: "quiet-ish" }), (path) => {
      expect(() => loadTarget(path, "rehearsal")).toThrow("artifactBlobIoMode");
    });
  });

  test("refuses the retired cross-product runtime topology", () => {
    withTarget(
      descriptor({
        hostedTopology: {
          service: "retired-runtime-service",
          entrypoint: "RetiredRuntimeEntrypoint",
        },
      }),
      (path) => expect(() => loadTarget(path, "rehearsal")).toThrow("unexpected keys"),
    );
  });

  test("requires one exact route-less executor topology for every Cloudflare supply", () => {
    const edgeSupplies = edgeSuppliesFixture();
    const objectBucketSupplies = objectBucketSuppliesFixture();
    const cloudflareProviderExecutor = cloudflareProviderExecutorTarget();
    expect(
      parseDeployTarget(
        descriptor({ edgeSupplies, objectBucketSupplies, cloudflareProviderExecutor }),
        "Cloudflare target",
        "rehearsal",
      ).cloudflareProviderExecutor,
    ).toEqual(cloudflareProviderExecutor);

    for (const rejected of [
      descriptor({ edgeSupplies }),
      descriptor({ cloudflareProviderExecutor }),
      descriptor({
        edgeSupplies,
        cloudflareProviderExecutor: {
          ...cloudflareProviderExecutor,
          providerInstallationId: "cloudflare.other",
        },
      }),
      descriptor({
        edgeSupplies,
        cloudflareProviderExecutor: {
          ...cloudflareProviderExecutor,
          releaseReadbackQualification: {
            ...cloudflareProviderExecutor.releaseReadbackQualification,
            dispatchNamespace: "another-dispatch",
          },
        },
      }),
      descriptor({
        edgeSupplies,
        cloudflareProviderExecutor: {
          ...cloudflareProviderExecutor,
          workerName: "takoserver-api-rehearsal",
        },
      }),
      descriptor({
        edgeSupplies,
        cloudflareProviderExecutor,
        workerEndpointSuffix: "legacy.example.workers.dev",
      }),
    ]) {
      expect(() => parseDeployTarget(rejected, "Cloudflare target", "rehearsal")).toThrow();
    }
  });

  test("refuses a descriptor for another environment", () => {
    withTarget(descriptor(), (path) => {
      expect(() => loadTarget(path, "production")).toThrow("environment");
    });
  });

  test("requires explicit current and next key ids for a rotation", () => {
    withTarget(
      descriptor({
        signing: {
          currentKeyId: "takoserver-rehearsal-current",
          nextKeyId: "takoserver-rehearsal-next",
        },
      }),
      (path) => {
        expect(loadTarget(path, "rehearsal").signing).toEqual({
          currentKeyId: "takoserver-rehearsal-current",
          nextKeyId: "takoserver-rehearsal-next",
        });
      },
    );
    withTarget(
      descriptor({
        signing: {
          currentKeyId: "takoserver-rehearsal-same",
          nextKeyId: "takoserver-rehearsal-same",
        },
      }),
      (path) => expect(() => loadTarget(path, "rehearsal")).toThrow("must differ"),
    );
  });

  test("does not accept the legacy mixed-controller key selector", () => {
    const legacy = descriptor({ signing: undefined, grantKeyId: "legacy-key" });
    withTarget(legacy, (path) => expect(() => loadTarget(path, "rehearsal")).toThrow());
  });

  test("derives a non-overridable target path from the selected environment", () => {
    expect(targetPath("integration")).toEndWith("/.deploy/targets/integration.json");
    expect(targetPath("rehearsal")).toEndWith("/.deploy/targets/rehearsal.json");
    expect(targetPath("production")).toEndWith("/.deploy/targets/production.json");
  });

  test("missing integration target names the clean-checkout private realization path", () => {
    const missing = join(tmpdir(), "takoserver-target-v2-missing", "integration.json");
    expect(() => loadTarget(missing, "integration")).toThrow(
      expect.objectContaining({
        message: expect.stringContaining("TAKOSERVER_DEPLOY_TARGET_INTEGRATION"),
        detail: expect.stringMatching(
          /cloudflareProviderExecutor[\s\S]*receiptAuthorityWorkerName[\s\S]*takoserver\.hosted-edge-supplies@v2/u,
        ),
      }),
    );
  });

  test("accepts one exact public Ed25519 operator identity in every deploy environment", () => {
    const publicJwk = {
      kty: "OKP" as const,
      crv: "Ed25519" as const,
      x: "A".repeat(43),
    };
    for (const environment of ["integration", "rehearsal", "production"] as const) {
      const value = descriptor({ environment, operatorIdentity: { publicJwk } });
      expect(
        parseDeployTarget(value, `${environment} target`, environment).operatorIdentity,
      ).toEqual({ publicJwk });
      withTarget(value, (path) => {
        expect(loadTarget(path, environment).operatorIdentity).toEqual({ publicJwk });
      });
    }

    for (const rejected of [
      { ...publicJwk, d: "private-material" },
      { ...publicJwk, kid: "unexpected" },
      { kty: "OKP", crv: "Ed25519", x: `${"A".repeat(42)}=` },
    ]) {
      withTarget(
        descriptor({
          environment: "integration",
          operatorIdentity: { publicJwk: rejected },
        }),
        (path) => expect(() => loadTarget(path, "integration")).toThrow("operatorIdentity"),
      );
    }
  });

  test("validates distinct route-less Form authority targets", () => {
    const formAuthority = {
      workerName: "takoserver-form-authority-integration",
      identityProbeWorkerName: "takoserver-form-identity-integration",
      identityProbeOrigin: "https://takoserver-form-identity-integration.example.workers.dev",
      integrationWorkerName: "takoserver-form-fixture-integration",
      hostId: "https://takoserver-api-rehearsal.example.workers.dev",
    };
    withTarget(descriptor({ environment: "integration", formAuthority }), (path) =>
      expect(loadTarget(path, "integration").formAuthority).toEqual(formAuthority),
    );
    withTarget(descriptor({ formAuthority }), (path) =>
      expect(() => loadTarget(path, "rehearsal")).toThrow("integration-only"),
    );
    withTarget(
      descriptor({
        formAuthority: {
          workerName: "takoserver-api-rehearsal",
          identityProbeWorkerName: "takoserver-form-identity-rehearsal",
          identityProbeOrigin: "https://takoserver-form-identity-rehearsal.example.workers.dev",
          hostId: "https://takoserver-api-rehearsal.example.workers.dev",
        },
      }),
      (path) => expect(() => loadTarget(path, "rehearsal")).toThrow("must be distinct"),
    );
    withTarget(
      descriptor({
        formAuthority: {
          workerName: "takoserver-form-authority-rehearsal",
          identityProbeWorkerName: "takoserver-form-identity-rehearsal",
          identityProbeOrigin: "https://takoserver-form-identity-rehearsal.example.workers.dev",
          hostId: "https://another-host.example.test",
        },
      }),
      (path) => expect(() => loadTarget(path, "rehearsal")).toThrow("public Takoserver Host"),
    );
    withTarget(
      descriptor({
        formAuthority: {
          workerName: "takoserver-form-authority-rehearsal",
          identityProbeWorkerName: "takoserver-form-identity-rehearsal",
          identityProbeOrigin: "https://takoserver-form-identity-rehearsal.example.workers.dev",
          hostId: "https://takoserver-api-rehearsal.example.workers.dev",
          operatorOperations: { ModuleWorker: ["read"] },
        },
      }),
      (path) => expect(() => loadTarget(path, "rehearsal")).toThrow("unexpected keys"),
    );
  });

  test("accepts only a closed integration-only pre-executor public Worker snapshot", () => {
    const operatorPublicJwk = {
      kty: "OKP" as const,
      crv: "Ed25519" as const,
      x: "A".repeat(43),
    };
    const integrationE2eCredentialAuthority = {
      organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
      publicJwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: "E".repeat(43) },
    };
    const historicalPreExecutorPublicWorker = {
      workerEndpointSuffix: "integration.example.workers.dev",
    };
    const formAuthority = {
      workerName: "takoserver-form-authority-integration",
      identityProbeWorkerName: "takoserver-form-identity-integration",
      identityProbeOrigin: "https://takoserver-form-identity-integration.example.workers.dev",
      integrationWorkerName: "takoserver-form-fixture-integration",
      integrationOperatorWorkerName: "takoserver-form-operator-integration",
      integrationOperatorOrigin: "https://form-authority.integration.takoserver.com",
      integrationOperatorScope: { tenantId: "tenant-integration", space: "space-integration" },
      operatorPublicJwk,
      historicalPreExecutorPublicWorker,
      hostId: "https://takoserver-api-rehearsal.example.workers.dev",
    };
    const value = descriptor({
      environment: "integration",
      edgeSupplies: edgeSuppliesFixture(),
      objectBucketSupplies: objectBucketSuppliesFixture(),
      cloudflareProviderExecutor: cloudflareProviderExecutorTarget(),
      formAuthority,
      integrationE2eCredentialAuthority,
    });
    const parsed = parseDeployTarget(value, "historical bridge target", "integration");
    expect(parsed.formAuthority?.historicalPreExecutorPublicWorker).toEqual(
      historicalPreExecutorPublicWorker,
    );
    expect(parsed.formAuthority?.historicalPreExecutorPublicWorker?.workerEndpointSuffix).not.toBe(
      parsed.cloudflareProviderExecutor?.managedBaseDomain,
    );

    expect(() =>
      parseDeployTarget(
        {
          ...value,
          formAuthority: {
            ...formAuthority,
            historicalPreExecutorPublicWorker: {
              ...historicalPreExecutorPublicWorker,
              currentExecutorDomain: "must-not-be-here.example.test",
            },
          },
        },
        "historical bridge target",
        "integration",
      ),
    ).toThrow("must contain only `workerEndpointSuffix`");

    expect(() =>
      parseDeployTarget(
        descriptor({
          formAuthority: {
            workerName: "takoserver-form-authority-rehearsal",
            identityProbeWorkerName: "takoserver-form-identity-rehearsal",
            identityProbeOrigin: "https://takoserver-form-identity-rehearsal.example.workers.dev",
            historicalPreExecutorPublicWorker,
            hostId: "https://takoserver-api-rehearsal.example.workers.dev",
          },
        }),
        "historical bridge target",
        "rehearsal",
      ),
    ).toThrow("historicalPreExecutorPublicWorker` is integration-only");
  });

  test("accepts only the dedicated integration Form-authority gateway key and custom origin", () => {
    const operatorPublicJwk = {
      kty: "OKP" as const,
      crv: "Ed25519" as const,
      x: "A".repeat(43),
    };
    const formAuthority = {
      workerName: "takoserver-form-authority-integration",
      identityProbeWorkerName: "takoserver-form-identity-integration",
      identityProbeOrigin: "https://takoserver-form-identity-integration.example.workers.dev",
      integrationWorkerName: "takoserver-form-fixture-integration",
      integrationOperatorWorkerName: "takoserver-form-operator-integration",
      integrationOperatorOrigin: "https://form-authority.integration.takoserver.com",
      integrationOperatorScope: {
        tenantId: "tenant-yurucommu-integration",
        space: "space-yurucommu-integration",
      },
      operatorPublicJwk,
      hostId: "https://takoserver-api-rehearsal.example.workers.dev",
    };
    withTarget(descriptor({ environment: "integration", formAuthority }), (path) => {
      expect(loadTarget(path, "integration").formAuthority).toEqual(formAuthority);
    });

    for (const rejected of [
      { ...formAuthority, operatorPublicJwk: undefined },
      { ...formAuthority, integrationOperatorScope: undefined },
      { ...formAuthority, operatorPublicJwk: { ...operatorPublicJwk, d: "private-material" } },
      {
        ...formAuthority,
        integrationOperatorOrigin: "https://operator.example.workers.dev",
      },
    ]) {
      withTarget(descriptor({ environment: "integration", formAuthority: rejected }), (path) => {
        expect(() => loadTarget(path, "integration")).toThrow();
      });
    }

    withTarget(descriptor({ formAuthority }), (path) => {
      expect(() => loadTarget(path, "rehearsal")).toThrow("integration-only");
    });
  });

  test("accepts one integration-only exact recovery worker and current owner retention policy", () => {
    const operatorPublicJwk = {
      kty: "OKP" as const,
      crv: "Ed25519" as const,
      x: "A".repeat(43),
    };
    const formAuthority = {
      workerName: "takoserver-form-authority-integration",
      identityProbeWorkerName: "takoserver-form-identity-integration",
      identityProbeOrigin: "https://takoserver-form-identity-integration.example.workers.dev",
      integrationWorkerName: "takoserver-form-fixture-integration",
      integrationOperatorWorkerName: "takoserver-form-operator-integration",
      integrationOperatorOrigin: "https://form-authority.integration.takoserver.com",
      integrationOperatorScope: {
        tenantId: INTEGRATION_E2E_ORGANIZATION_ID,
        space: "space-yurucommu-integration",
      },
      operatorPublicJwk,
      hostId: "https://takoserver-api-rehearsal.example.workers.dev",
    };
    const exactArtifactRecovery = {
      workerName: "takoserver-exact-artifact-recovery-integration",
      retentionPolicy: {
        kind: ARTIFACT_RECOVERY_RETENTION_FORMAT,
        evidenceDigest: `sha256:${"d".repeat(64)}` as const,
        detailRetentionMilliseconds: 7 * 24 * 60 * 60_000,
      },
    } as const;
    const complete = descriptor({
      environment: "integration",
      edgeSupplies: edgeSuppliesFixture(),
      objectBucketSupplies: objectBucketSuppliesFixture(),
      cloudflareProviderExecutor: cloudflareProviderExecutorTarget(),
      formAuthority,
      integrationE2eCredentialAuthority: {
        organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "E".repeat(43) },
      },
      exactArtifactRecovery,
    });
    expect(
      parseDeployTarget(complete, "exact recovery target", "integration").exactArtifactRecovery,
    ).toEqual(exactArtifactRecovery);

    for (const rejected of [
      descriptor({ environment: "integration", exactArtifactRecovery }),
      { ...complete, environment: "rehearsal" },
      {
        ...complete,
        exactArtifactRecovery: {
          ...exactArtifactRecovery,
          workerName: formAuthority.integrationOperatorWorkerName,
        },
      },
      {
        ...complete,
        exactArtifactRecovery: {
          ...exactArtifactRecovery,
          retentionPolicy: {
            ...exactArtifactRecovery.retentionPolicy,
            evidenceDigest: "sha256:wrong",
          },
        },
      },
      {
        ...complete,
        exactArtifactRecovery: {
          ...exactArtifactRecovery,
          retentionPolicy: {
            ...exactArtifactRecovery.retentionPolicy,
            detailRetentionMilliseconds: 0,
          },
        },
      },
    ]) {
      expect(() =>
        parseDeployTarget(
          rejected,
          "invalid exact recovery target",
          rejected.environment as "integration" | "rehearsal",
        ),
      ).toThrow();
    }
  });

  test("keeps a transition predecessor outside the steady deploy target", () => {
    const formAuthority = {
      workerName: "takoserver-form-authority-integration",
      integrationWorkerName: "takoserver-form-fixture-integration",
      integrationOperatorWorkerName: "takoserver-form-operator-integration",
      integrationOperatorOrigin: "https://form-authority.integration.takoserver.com",
      integrationOperatorScope: {
        tenantId: "tenant-yurucommu-integration",
        space: "space-yurucommu-integration",
      },
      predecessorScope: {
        tenantId: "tenant-yurucommu-predecessor",
        space: "space-yurucommu-predecessor",
      },
      operatorPublicJwk: {
        kty: "OKP",
        crv: "Ed25519",
        x: "A".repeat(43),
      },
      hostId: "https://takoserver-api-rehearsal.example.workers.dev",
    };
    withTarget(descriptor({ environment: "integration", formAuthority }), (path) => {
      expect(() => loadTarget(path, "integration")).toThrow("unexpected keys");
    });
  });

  test("accepts only the fixed-organization dedicated integration E2E authority key", () => {
    const publicJwk = {
      kty: "OKP" as const,
      crv: "Ed25519" as const,
      x: "E".repeat(43),
    };
    const authority = {
      organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
      publicJwk,
    } as const;
    withTarget(
      descriptor({ environment: "integration", integrationE2eCredentialAuthority: authority }),
      (path) => {
        expect(loadTarget(path, "integration").integrationE2eCredentialAuthority).toEqual(
          authority,
        );
      },
    );
    for (const environment of ["rehearsal", "production"] as const) {
      withTarget(
        descriptor({ environment, integrationE2eCredentialAuthority: authority }),
        (path) => {
          expect(() => loadTarget(path, environment)).toThrow("integration-only");
        },
      );
    }
    withTarget(
      descriptor({
        environment: "integration",
        integrationE2eCredentialAuthority: { ...authority, organizationId: "org_wrong" },
      }),
      (path) =>
        expect(() => loadTarget(path, "integration")).toThrow(INTEGRATION_E2E_ORGANIZATION_ID),
    );
    withTarget(
      descriptor({
        environment: "integration",
        integrationE2eCredentialAuthority: {
          ...authority,
          publicJwk: { ...publicJwk, d: "private-material" },
        },
      }),
      (path) => expect(() => loadTarget(path, "integration")).toThrow("public-only"),
    );
    withTarget(
      descriptor({
        environment: "integration",
        operatorIdentity: { publicJwk },
        integrationE2eCredentialAuthority: authority,
      }),
      (path) => expect(() => loadTarget(path, "integration")).toThrow("dedicated"),
    );
    withTarget(
      descriptor({
        environment: "integration",
        formAuthority: {
          workerName: "takoserver-form-authority-integration",
          identityProbeWorkerName: "takoserver-form-identity-integration",
          identityProbeOrigin: "https://takoserver-form-identity-integration.example.workers.dev",
          integrationWorkerName: "takoserver-form-fixture-integration",
          integrationOperatorWorkerName: "takoserver-form-operator-integration",
          integrationOperatorOrigin: "https://form-authority.integration.takoserver.com",
          integrationOperatorScope: { tenantId: "tenant", space: "space" },
          operatorPublicJwk: publicJwk,
          hostId: "https://takoserver-api-rehearsal.example.workers.dev",
        },
        integrationE2eCredentialAuthority: authority,
      }),
      (path) => expect(() => loadTarget(path, "integration")).toThrow("dedicated"),
    );
  });
});
