import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFormAuthority } from "../scripts/deploy/form-authority.ts";
import { runOperatorIdentity } from "../scripts/deploy/identity.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import {
  type RetirementState,
  runAuthorityTransition,
  runRetirement,
} from "../scripts/deploy/retirement.ts";
import { runSigning } from "../scripts/deploy/signing.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { acquireWranglerVersionPublicationLease } from "../scripts/deploy/wrangler-state.ts";

const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-integration",
  d1: {
    databaseName: "takoserver-runtime-integration",
    databaseId: "00000000-0000-4000-8000-000000000000",
  },
  r2: { bucketName: "takoserver-objects-integration" },
  publicOrigin: "https://api.integration.example.test",
  signing: { currentKeyId: "key-current" },
  operatorIdentity: { publicJwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) } },
  formAuthority: {
    workerName: "takoserver-form-authority",
    identityProbeWorkerName: "takoserver-form-identity-probe",
    identityProbeOrigin: "https://takoserver-form-identity-probe.integration.example.test",
    integrationWorkerName: "takoserver-form-authority-integration",
    integrationOperatorWorkerName: "takoserver-form-operator-integration",
    integrationOperatorOrigin: "https://form-authority.integration.example.test",
    integrationOperatorScope: { tenantId: "tenant-integration", space: "space-integration" },
    operatorPublicJwk: { kty: "OKP", crv: "Ed25519", x: "B".repeat(43) },
    hostId: "https://api.integration.example.test",
  },
} satisfies DeployTarget;

const PROCESS_RESULT: CommandResult = { exitCode: 0, stdout: "", stderr: "" };

describe("authority publication lease", () => {
  test("all four writers refuse a held shared lease before any state or process effect", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-authority-publication-lease-"));
    const publicationLeaseRoot = join(root, "leases");
    const commit = "a".repeat(40);
    let effects = 0;
    const run = async (): Promise<CommandResult> => {
      effects += 1;
      return PROCESS_RESULT;
    };
    const invocation = {
      action: "apply" as const,
      environment: "integration" as const,
      commit,
    };

    try {
      const surfaces = [
        {
          workerName: target.workerName,
          invoke: () =>
            runOperatorIdentity(
              {
                ...invocation,
                surface: "takoserver-operator-identity",
                organizationId: "org_test",
              },
              target,
              {
                run,
                state: {
                  async workerDeployments() {
                    effects += 1;
                    return [];
                  },
                  async workerVersion() {
                    effects += 1;
                    return {};
                  },
                  async workerSecrets() {
                    effects += 1;
                    return [];
                  },
                  async workerDomains() {
                    effects += 1;
                    return [];
                  },
                },
                migrations: {
                  async read() {
                    effects += 1;
                    return { local: [], applied: [] };
                  },
                },
                publicationLeaseRoot,
              },
            ),
        },
        {
          workerName: target.workerName,
          invoke: () =>
            runSigning({ ...invocation, surface: "takoserver-signing-key-register" }, target, {
              run,
              database: {
                async readKey() {
                  effects += 1;
                  return null;
                },
                async insertPublicKey() {
                  effects += 1;
                },
              },
              publicationLeaseRoot,
            }),
        },
        {
          workerName: target.formAuthority?.integrationWorkerName ?? "",
          invoke: () =>
            runFormAuthority(
              { ...invocation, surface: "takoserver-integration-form-authority-worker" },
              target,
              {
                run,
                state: {
                  async workerScripts() {
                    effects += 1;
                    return [];
                  },
                  async workerDeployments() {
                    effects += 1;
                    return [];
                  },
                  async workerVersion() {
                    effects += 1;
                    return {};
                  },
                  async workerSecrets() {
                    effects += 1;
                    return [];
                  },
                  async workerDomains() {
                    effects += 1;
                    return [];
                  },
                  async workerSubdomain() {
                    effects += 1;
                    return { enabled: false, previewsEnabled: false };
                  },
                  async workerRoutes() {
                    effects += 1;
                    return [];
                  },
                },
                publicationLeaseRoot,
              },
            ),
        },
        {
          workerName: target.workerName,
          invoke: () =>
            runAuthorityTransition(
              {
                ...invocation,
                surface: "takoserver-sponsorship-public-route-retirement",
                legacyHostRuntimePredecessorVersionId: "11111111-1111-4111-8111-111111111111",
              },
              target,
              {} as RetirementState,
              run,
              {
                publicationLeaseRoot,
              },
            ),
        },
        {
          workerName: target.workerName,
          invoke: () =>
            runRetirement(
              {
                ...invocation,
                surface: "takoserver-host-runtime-topology-retirement",
                legacyHostRuntimePredecessorVersionId: "11111111-1111-4111-8111-111111111111",
              },
              target,
              {
                run,
                state: {} as RetirementState,
                publicationLeaseRoot,
              },
            ),
        },
      ];

      for (const surface of surfaces) {
        const holder = await acquireWranglerVersionPublicationLease({
          accountId: target.accountId,
          workerName: surface.workerName,
          root: publicationLeaseRoot,
        });
        try {
          await expect(surface.invoke()).rejects.toThrow("holds the active kernel lease");
          expect(effects).toBe(0);
        } finally {
          await holder.release();
        }
        const afterRelease = await acquireWranglerVersionPublicationLease({
          accountId: target.accountId,
          workerName: surface.workerName,
          root: publicationLeaseRoot,
        });
        await afterRelease.release();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
