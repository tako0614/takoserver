import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertIdentityCapabilitySupplyPartition } from "../scripts/deploy/form-authority-capability.ts";
import { runCommand } from "../scripts/deploy/process.ts";
import { removeArtifactTree } from "../scripts/deploy/qualification.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import {
  canonicalizeWorkerBundleSource,
  prepareWorkerArtifact,
} from "../scripts/deploy/worker-artifact.ts";
import { YURUCOMMU_IDENTITY_CAPABILITY_KINDS } from "../src/takoform/implementation-catalog.ts";

const COMMIT = "a".repeat(40);
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
} satisfies DeployTarget;

async function build(root: string) {
  const prepared = await prepareWorkerArtifact({
    root,
    target,
    commit: COMMIT,
    run: runCommand,
  });
  const bytes = readFileSync(prepared.bundlePath);
  const source = bytes.toString("utf8");
  return {
    bytes,
    digest: createHash("sha256").update(bytes).digest("hex"),
    sourceLabels: source.split("\n").filter((line) => line.startsWith("// ")),
  };
}

describe("hermetic Worker bundle identity", () => {
  test("seals a separate Form runtime payload before embedding its semantic digest", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-form-payload-"));
    const formTarget = {
      ...target,
      edgeSupplies: {
        offerings: YURUCOMMU_IDENTITY_CAPABILITY_KINDS.filter(
          (formKind) => formKind !== "ObjectBucket",
        ).map((formKind) => ({ formKind })),
      } as unknown as NonNullable<DeployTarget["edgeSupplies"]>,
      objectBucketSupplies: {
        supplies: [{ provider: { kind: "cloudflare" } }],
      } as unknown as NonNullable<DeployTarget["objectBucketSupplies"]>,
      workerEndpointSuffix: "integration.example.workers.dev",
      formAuthority: {
        workerName: "takoserver-form-authority-integration",
        identityProbeWorkerName: "takoserver-form-identity-integration",
        identityProbeOrigin:
          "https://takoserver-form-identity-integration.integration.example.workers.dev",
        hostId: target.publicOrigin,
      },
    } satisfies DeployTarget;
    try {
      const buildFormWorker = async (name: string, payload: string, outer: string) =>
        await prepareWorkerArtifact({
          root: join(root, name),
          target: formTarget,
          commit: COMMIT,
          run: async (command) => {
            const outdir = command[command.indexOf("--outdir") + 1];
            if (!outdir) throw new Error("dry-run outdir missing");
            mkdirSync(outdir, { recursive: true });
            writeFileSync(
              join(outdir, "worker.js"),
              outdir.includes("form-implementation-payload") ? payload : outer,
            );
            return { exitCode: 0, stdout: "built\n", stderr: "" };
          },
        });
      const prepared = await buildFormWorker(
        "base",
        "export const runtimeHandler = 'provider-v1';\n",
        "export default { async fetch() { return new Response('outer'); } };\n",
      );
      const unrelatedOuterChange = await buildFormWorker(
        "outer-change",
        "export const runtimeHandler = 'provider-v1';\n",
        "export default { async fetch() { return new Response('unrelated route'); } };\n",
      );
      const changedRuntimePayload = await buildFormWorker(
        "payload-change",
        "export const runtimeHandler = 'provider-v2';\n",
        "export default { async fetch() { return new Response('outer'); } };\n",
      );

      const identity = prepared.formImplementationIdentity;
      if (!identity) throw new Error("Form implementation identity was not built");
      expect(unrelatedOuterChange.bundleDigestHex).not.toBe(prepared.bundleDigestHex);
      expect(unrelatedOuterChange.formImplementationIdentity).toEqual(identity);
      expect(
        changedRuntimePayload.formImplementationIdentity?.implementationPayloadDigest,
      ).not.toBe(identity.implementationPayloadDigest);
      expect(changedRuntimePayload.formImplementationIdentity?.implementationDigest).not.toBe(
        identity.implementationDigest,
      );
      expect(identity.implementationPayloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(identity.capabilityDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(identity.implementationDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      const releaseConfig = JSON.parse(readFileSync(prepared.configPath, "utf8")) as {
        define: Record<string, string>;
        vars: Record<string, string>;
      };
      expect(releaseConfig.define).toMatchObject({
        TAKOSERVER_BUILD_FORM_IMPLEMENTATION_DIGEST: JSON.stringify(identity.implementationDigest),
        TAKOSERVER_BUILD_FORM_IMPLEMENTATION_PAYLOAD_DIGEST: JSON.stringify(
          identity.implementationPayloadDigest,
        ),
      });
      expect(releaseConfig.vars).toMatchObject({
        TAKOSERVER_WORKER_ARTIFACT_DIGEST: `sha256:${prepared.bundleDigestHex}`,
      });
      expect(releaseConfig.vars).not.toHaveProperty(
        "TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST",
      );
    } finally {
      removeArtifactTree(root);
    }
  });

  test("uses an explicit historical build profile and preserves sealed upload provenance", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-artifact-authority-"));
    const jitTarget = {
      ...target,
      integrationE2eCredentialAuthority: {
        organizationId: "org_takosumi_hosted_staging",
        publicJwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: "E".repeat(43) },
      },
    } satisfies DeployTarget;
    try {
      const prepared = await prepareWorkerArtifact({
        root,
        target: jitTarget,
        commit: COMMIT,
        run: async (command) => {
          const outdir = command[command.indexOf("--outdir") + 1];
          if (!outdir) throw new Error("dry-run outdir missing");
          mkdirSync(outdir, { recursive: true });
          writeFileSync(join(outdir, "worker.js"), "export default {};\n");
          return { exitCode: 0, stdout: "built\n", stderr: "" };
        },
      });
      const buildConfig = JSON.parse(readFileSync(join(root, "build-wrangler.jsonc"), "utf8")) as {
        vars: Record<string, string>;
      };
      expect(buildConfig.vars).not.toHaveProperty("TAKOSERVER_ENVIRONMENT");
      expect(buildConfig.vars).not.toHaveProperty("TAKOSERVER_SOURCE_COMMIT");
      expect(buildConfig.vars).not.toHaveProperty("TAKOSERVER_WORKER_ARTIFACT_DIGEST");

      const releaseConfig = JSON.parse(readFileSync(prepared.configPath, "utf8")) as {
        vars: Record<string, string>;
      };
      expect(releaseConfig.vars).toMatchObject({
        TAKOSERVER_ENVIRONMENT: "integration",
        TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID: "org_takosumi_hosted_staging",
        TAKOSERVER_SOURCE_COMMIT: COMMIT,
        TAKOSERVER_WORKER_ARTIFACT_DIGEST: `sha256:${prepared.bundleDigestHex}`,
      });
      expect(releaseConfig.vars.TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK).toBe(
        JSON.stringify(jitTarget.integrationE2eCredentialAuthority.publicJwk),
      );
      const artifact = prepared.seal();
      artifact.assertUnchanged();
    } finally {
      removeArtifactTree(root);
    }
  });

  test("uses identical bytes and digest across shallow and nested real Wrangler builds", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-worker-artifact-"));
    try {
      const shallow = await build(join(root, "shallow"));
      const nested = await build(join(root, "nested", "public-worker-proof"));

      expect({
        shallowDigest: shallow.digest,
        nestedDigest: nested.digest,
        shallowSourceLabels: shallow.sourceLabels,
        nestedSourceLabels: nested.sourceLabels,
      }).toEqual({
        shallowDigest: nested.digest,
        nestedDigest: nested.digest,
        shallowSourceLabels: nested.sourceLabels,
        nestedSourceLabels: nested.sourceLabels,
      });
      expect(shallow.bytes).toEqual(nested.bytes);
      expect(shallow.sourceLabels[0]).toBe("// src/entry-cloudflare-worker.ts");
      expect(shallow.sourceLabels.every((label) => !label.includes(root))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves comments that are not repository source labels", () => {
    const source = ["// external explanatory comment", "export default {};", ""].join("\n");
    expect(canonicalizeWorkerBundleSource(source, "/tmp/build/index.js")).toBe(source);
  });
});

describe("deploy supply partition", () => {
  test("covers exactly the code-owned identity capabilities", () => {
    expect(() => assertIdentityCapabilitySupplyPartition()).not.toThrow();
  });

  test("refuses a capability the partition does not place, rather than guessing a supply", () => {
    expect(() =>
      assertIdentityCapabilitySupplyPartition([
        ...YURUCOMMU_IDENTITY_CAPABILITY_KINDS,
        "DurableWorkflow",
      ]),
    ).toThrow(/DurableWorkflow/u);
  });

  test("refuses a partition entry the code-owned set no longer names", () => {
    expect(() =>
      assertIdentityCapabilitySupplyPartition(
        YURUCOMMU_IDENTITY_CAPABILITY_KINDS.filter((kind) => kind !== "ObjectBucket"),
      ),
    ).toThrow(/ObjectBucket/u);
  });
});
