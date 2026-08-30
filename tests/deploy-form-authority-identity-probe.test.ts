import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicFormCapabilityManifest } from "../scripts/deploy/form-authority.ts";
import {
  type FormAuthorityIdentityProbeState,
  runFormAuthorityIdentityProbe,
  writeProbeConfig,
} from "../scripts/deploy/form-authority-identity-probe.ts";
import { expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";
import { derivePublicFormImplementationIdentity } from "../src/public-worker-implementation.ts";
import { YURUCOMMU_IDENTITY_CAPABILITY_KINDS } from "../src/takoform/implementation-catalog.ts";

const COMMIT = "a".repeat(40);
const PUBLIC_VERSION = "11111111-1111-4111-8111-111111111111";
const PROBE_VERSION = "22222222-2222-4222-8222-222222222222";
const OUTER_DIGEST = `sha256:${"1".repeat(64)}` as const;
const PROBE_DIGEST = `sha256:${"2".repeat(64)}` as const;
const PAYLOAD_DIGEST = `sha256:${"3".repeat(64)}` as const;

const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "production",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-production",
  d1: {
    databaseName: "takoserver-runtime-production",
    databaseId: "00000000-0000-4000-8000-000000000000",
  },
  r2: { bucketName: "takoserver-objects-production" },
  publicOrigin: "https://api.example.test",
  edgeSupplies: {
    offerings: YURUCOMMU_IDENTITY_CAPABILITY_KINDS.map((formKind) => ({ formKind })),
  } as unknown as NonNullable<DeployTarget["edgeSupplies"]>,
  workerEndpointSuffix: "production.example.workers.dev",
  formAuthority: {
    workerName: "takoserver-form-authority-production",
    identityProbeWorkerName: "takoserver-form-identity-production",
    identityProbeOrigin:
      "https://takoserver-form-identity-production.production.example.workers.dev",
    hostId: "https://api.example.test",
  },
  signing: { currentKeyId: "key-current" },
} satisfies DeployTarget;

describe("Form authority identity probe deploy surface", () => {
  test("realizes only the public identity binding and Host id", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-form-identity-config-"));
    try {
      const path = writeProbeConfig({
        path: join(root, "wrangler.jsonc"),
        main: "worker.js",
        target,
      });
      const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(config).toMatchObject({
        name: target.formAuthority.identityProbeWorkerName,
        workers_dev: true,
        preview_urls: false,
        vars: { TAKOSERVER_FORM_AUTHORITY_HOST_ID: target.formAuthority.hostId },
        services: [
          {
            binding: "PUBLIC_HOST_IDENTITY",
            service: target.workerName,
            entrypoint: "PublicHostIdentityEntrypoint",
          },
        ],
      });
      expect(config).not.toHaveProperty("d1_databases");
      expect(config).not.toHaveProperty("r2_buckets");
      expect(config).not.toHaveProperty("routes");
      expect(config).not.toHaveProperty("secrets");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("status is not ready until the permanent probe actively returns the exact RPC identity", async () => {
    const semantic = await derivePublicFormImplementationIdentity({
      implementationPayloadDigest: PAYLOAD_DIGEST,
      capabilities: publicFormCapabilityManifest(),
    });
    let fetchCalls = 0;
    const unavailable = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "status",
        environment: "production",
        commit: COMMIT,
      },
      target,
      {
        state: probeState(true),
        async fetcher(): Promise<never> {
          fetchCalls += 1;
          throw new Error("rpc unavailable");
        },
      },
    );
    expect(unavailable).toMatchObject({
      commitMatches: true,
      publicIdentityRpcReady: false,
      ready: false,
    });
    expect(fetchCalls).toBe(1);

    const ready = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "status",
        environment: "production",
        commit: COMMIT,
      },
      target,
      {
        state: probeState(true),
        async fetcher() {
          return Response.json({
            kind: "takoserver.public-host-identity@v2",
            hostId: target.formAuthority.hostId,
            workerVersionId: PUBLIC_VERSION,
            workerArtifactDigest: OUTER_DIGEST,
            ...semantic,
          });
        },
      },
    );
    expect(ready).toMatchObject({
      commitMatches: true,
      publicIdentityRpcReady: true,
      implementationPayloadDigest: PAYLOAD_DIGEST,
      capabilityDigest: semantic.capabilityDigest,
      implementationDigest: semantic.implementationDigest,
      ready: true,
    });
  });
});

function probeState(present: boolean): FormAuthorityIdentityProbeState {
  return {
    async workerScripts() {
      return present
        ? [target.workerName, target.formAuthority.identityProbeWorkerName]
        : [target.workerName];
    },
    async workerDeployments(workerName) {
      return [
        {
          id: `${workerName}-deployment`,
          created_on: "2026-08-30T00:00:00Z",
          versions: [
            {
              version_id: workerName === target.workerName ? PUBLIC_VERSION : PROBE_VERSION,
              percentage: 100,
            },
          ],
        },
      ];
    },
    async workerVersion(workerName) {
      if (workerName === target.workerName) return publicVersion();
      return {
        annotations: {
          "workers/message": `form-authority-identity-probe:${COMMIT}:${PROBE_DIGEST}`,
        },
        resources: {
          bindings: [
            {
              name: "TAKOSERVER_FORM_AUTHORITY_HOST_ID",
              type: "plain_text",
              text: target.formAuthority.hostId,
            },
            {
              name: "PUBLIC_HOST_IDENTITY",
              type: "service",
              service: target.workerName,
              entrypoint: "PublicHostIdentityEntrypoint",
            },
          ],
        },
      };
    },
    async workerSecrets(workerName) {
      return workerName === target.workerName
        ? expectedWorkerSecrets(target).map((name) => ({ name, type: "secret_text" }))
        : [];
    },
    async workerDomains() {
      return [{ hostname: "api.example.test", service: target.workerName }];
    },
    async workerSubdomain() {
      return { enabled: true, previewsEnabled: false };
    },
    async workerRoutes() {
      return [];
    },
  };
}

function publicVersion() {
  const expected = expectedExactBindingClosure(target, { workerArtifactDigest: OUTER_DIGEST });
  return {
    annotations: {
      "workers/message": `takoserver-worker:${COMMIT}:${OUTER_DIGEST.slice("sha256:".length)}`,
      "workers/triggered_by": "version_upload",
    },
    resources: {
      bindings: Object.entries(expected).flatMap(([name, requirement]) =>
        requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
      ),
    },
  };
}
