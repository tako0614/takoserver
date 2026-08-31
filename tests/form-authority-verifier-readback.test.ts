import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FormAuthorityCoreVerifierReadbackExpectation,
  type FormAuthorityDeployState,
  type FormAuthorityProcess,
  publicFormCapabilityManifest,
  readFormAuthorityCoreVerifierIdentityProbe,
  runFormAuthority,
  takoformCoreVerifierArtifactDigest,
} from "../scripts/deploy/form-authority.ts";
import { expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";
import {
  FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_KIND,
  FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_PATH,
  type FormAuthorityCoreVerifierIdentity,
  handleFormAuthorityIdentityProbe,
} from "../src/form-authority-identity-probe.ts";
import { canonicalJson } from "../src/json.ts";
import { derivePublicFormImplementationIdentity } from "../src/public-worker-implementation.ts";
import {
  TAKOFORM_CORE_COMMIT,
  TAKOFORM_CORE_VERIFIER_PROTOCOL,
  TAKOFORM_CORE_VERSION,
} from "../src/takoform/form-authority-verification.ts";
import { YURUCOMMU_IDENTITY_CAPABILITY_KINDS } from "../src/takoform/implementation-catalog.ts";

const AUTHORITY_VERSION_ID = "55555555-5555-4555-8555-555555555555";
const STALE_AUTHORITY_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const ARTIFACT_DIGEST = `sha256:${"a".repeat(64)}` as const;
const STALE_ARTIFACT_DIGEST = `sha256:${"b".repeat(64)}` as const;
const PROBE_ORIGIN = "https://form-identity.example.workers.dev";
const COMMIT = "c".repeat(40);
const PREVIOUS_COMMIT = "b".repeat(40);
const PUBLIC_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const PREVIOUS_AUTHORITY_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const PUBLIC_BUNDLE = "export default { fetch() { return new Response('public'); } };\n";
const AUTHORITY_BUNDLE = "export class FormAuthorityEntrypoint {}\n";
const PUBLIC_ARTIFACT_DIGEST = `sha256:${createHash("sha256")
  .update(PUBLIC_BUNDLE)
  .digest("hex")}` as const;
const AUTHORITY_ARTIFACT_DIGEST = `sha256:${createHash("sha256")
  .update(AUTHORITY_BUNDLE)
  .digest("hex")}` as const;
const CAPABILITY_MANIFEST_JSON = canonicalJson(publicFormCapabilityManifest());

const productionTarget = {
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
    identityProbeOrigin: PROBE_ORIGIN,
    hostId: "https://api.example.test",
  },
  signing: { currentKeyId: "key-current" },
} satisfies DeployTarget;

mock.module("cloudflare:workers", () => ({
  DurableObject: class DurableObject {},
  WorkerEntrypoint: class WorkerEntrypoint {},
}));

const exactIdentity = {
  kind: FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_KIND,
  authorityWorkerVersionId: AUTHORITY_VERSION_ID,
  verifier: {
    protocol: TAKOFORM_CORE_VERIFIER_PROTOCOL,
    coreVersion: TAKOFORM_CORE_VERSION,
    coreCommit: TAKOFORM_CORE_COMMIT,
    artifactDigest: ARTIFACT_DIGEST,
  },
} satisfies FormAuthorityCoreVerifierIdentity;

const expectation = {
  probeOrigin: PROBE_ORIGIN,
  authorityWorkerVersionId: AUTHORITY_VERSION_ID,
  artifactDigest: ARTIFACT_DIGEST,
} satisfies FormAuthorityCoreVerifierReadbackExpectation;

describe("Form authority released-Core verifier identity readback", () => {
  test("the named RPC starts and interrogates the Container under its own Worker Version", async () => {
    const authorityEntrySpecifier = "../src/entry-form-authority-worker.ts";
    const { FormAuthorityEntrypoint } = (await import(authorityEntrySpecifier)) as {
      readonly FormAuthorityEntrypoint: {
        readonly prototype: { readonly verifierIdentity: unknown };
      };
    };
    const containerNames: string[] = [];
    const requests: Request[] = [];
    const id = { toString: () => "opaque", equals: () => true };
    const verifierIdentity = FormAuthorityEntrypoint.prototype
      .verifierIdentity as unknown as (this: {
      readonly env: Record<string, unknown>;
    }) => Promise<FormAuthorityCoreVerifierIdentity>;
    const identity = await verifierIdentity.call({
      env: {
        WORKER_VERSION: { id: AUTHORITY_VERSION_ID },
        TAKOSERVER_ENVIRONMENT: "production",
        TAKOSERVER_FORM_AUTHORITY_HOST_ID: "https://api.example.test",
        TAKOSERVER_TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST: ARTIFACT_DIGEST,
        CORE_VERIFIER: {
          idFromName(name: string) {
            containerNames.push(name);
            return id;
          },
          get() {
            return {
              async fetch(input: RequestInfo | URL, init?: RequestInit) {
                requests.push(new Request(input, init));
                return Response.json(exactIdentity.verifier);
              },
            };
          },
        },
      },
    });

    expect(identity).toEqual(exactIdentity);
    expect(containerNames).toEqual(["production:https://api.example.test"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://takoform-core-verifier/v1/identity");
  });

  test("the permanent probe exposes only the exact named-RPC identity", async () => {
    let calls = 0;
    const response = await handleFormAuthorityIdentityProbe(
      new Request(`${PROBE_ORIGIN}${FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_PATH}`),
      {
        TAKOSERVER_FORM_AUTHORITY_HOST_ID: "https://api.example.test",
        PUBLIC_HOST_IDENTITY: {
          async identity(): Promise<never> {
            throw new Error("unexpected public identity call");
          },
        },
        FORM_AUTHORITY: {
          async verifierIdentity() {
            calls += 1;
            return structuredClone(exactIdentity);
          },
        },
      },
    );

    expect(calls).toBe(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(exactIdentity);
  });

  test("the permanent probe fails closed without leaking RPC or Container failures", async () => {
    const response = await handleFormAuthorityIdentityProbe(
      new Request(`${PROBE_ORIGIN}${FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_PATH}`),
      {
        TAKOSERVER_FORM_AUTHORITY_HOST_ID: "https://api.example.test",
        PUBLIC_HOST_IDENTITY: {
          async identity(): Promise<never> {
            throw new Error("unexpected public identity call");
          },
        },
        FORM_AUTHORITY: {
          async verifierIdentity(): Promise<never> {
            throw new Error("container id and provider detail must not escape");
          },
        },
      },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "verifier_unavailable" } });
  });

  test("does not report ready when the live verifier identity is missing", async () => {
    const readback = await readFormAuthorityCoreVerifierIdentityProbe(
      expectation,
      async () => new Response(null, { status: 503 }),
    );

    expect(readback).toEqual({ ready: false, identity: null });
  });

  test("production status cannot report ready for missing, stale, or mismatched live identity", async () => {
    for (const verifierResponse of [
      null,
      { ...releasedIdentity(), authorityWorkerVersionId: STALE_AUTHORITY_VERSION_ID },
      {
        ...releasedIdentity(),
        verifier: { ...releasedIdentity().verifier, artifactDigest: STALE_ARTIFACT_DIGEST },
      },
    ]) {
      const status = await productionStatus(verifierResponse);
      expect(status).toMatchObject({
        commitMatches: true,
        coreVerifierRpcReady: false,
        coreVerifierAuthorityWorkerVersionId: null,
        coreVerifierObservedArtifactDigest: null,
        ready: false,
      });
    }
  });

  test("rejects stale Worker Versions and mismatched released image artifacts", async () => {
    for (const identity of [
      { ...exactIdentity, authorityWorkerVersionId: STALE_AUTHORITY_VERSION_ID },
      {
        ...exactIdentity,
        verifier: { ...exactIdentity.verifier, artifactDigest: STALE_ARTIFACT_DIGEST },
      },
    ]) {
      const readback = await readFormAuthorityCoreVerifierIdentityProbe(expectation, async () =>
        Response.json(identity),
      );
      expect(readback).toEqual({ ready: false, identity: null });
    }
  });

  test("accepts only the exact live Worker Version and released verifier identity", async () => {
    const requests: Request[] = [];
    const readback = await readFormAuthorityCoreVerifierIdentityProbe(
      expectation,
      async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(exactIdentity);
      },
    );

    expect(readback).toEqual({ ready: true, identity: exactIdentity });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${PROBE_ORIGIN}${FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_PATH}`);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.headers.get("cache-control")).toBe("no-store");
  });

  test("production status reports ready only for the exact live Container identity", async () => {
    const identity = releasedIdentity();
    const status = await productionStatus(identity);

    expect(status).toMatchObject({
      commitMatches: true,
      versionId: AUTHORITY_VERSION_ID,
      coreVerifierRpcReady: true,
      coreVerifierAuthorityWorkerVersionId: AUTHORITY_VERSION_ID,
      coreVerifierProtocol: TAKOFORM_CORE_VERIFIER_PROTOCOL,
      coreVerifierVersion: TAKOFORM_CORE_VERSION,
      coreVerifierCommit: TAKOFORM_CORE_COMMIT,
      coreVerifierArtifactDigest: takoformCoreVerifierArtifactDigest(),
      coreVerifierObservedArtifactDigest: takoformCoreVerifierArtifactDigest(),
      ready: true,
    });
  });

  test("production apply verifies the live successor after upload and fails closed if it cannot start", async () => {
    let uploaded = false;
    let verifierReadbacks = 0;
    const process = productionProcess(() => {
      uploaded = true;
    });
    const root = mkdtempSync(join(tmpdir(), "takoserver-verifier-readback-"));
    try {
      const failure = await runFormAuthority(
        {
          surface: "takoserver-form-authority-worker",
          action: "apply",
          environment: "production",
          commit: COMMIT,
        },
        productionTarget,
        {
          run: process.run,
          state: productionApplyState(() => uploaded),
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "not-a-live-token" },
          review: "independent-reviewer",
          fetcher: await productionProbeFetcher(null, () => {
            verifierReadbacks += 1;
          }),
        },
      ).catch((error) => error);

      expect(uploaded).toBe(true);
      expect(verifierReadbacks).toBe(1);
      expect(process.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
      expect(failure).toMatchObject({ phase: "verification" });
      expect(String(failure.message)).toContain("released Core verifier live identity");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function releasedIdentity(): FormAuthorityCoreVerifierIdentity {
  return {
    ...exactIdentity,
    verifier: { ...exactIdentity.verifier, artifactDigest: takoformCoreVerifierArtifactDigest() },
  };
}

async function productionStatus(
  verifierIdentity: FormAuthorityCoreVerifierIdentity | null,
): Promise<Record<string, unknown>> {
  const fetcher = await productionProbeFetcher(verifierIdentity);
  return await runFormAuthority(
    {
      surface: "takoserver-form-authority-worker",
      action: "status",
      environment: "production",
      commit: COMMIT,
    },
    productionTarget,
    { state: productionState(), fetcher },
  );
}

async function productionProbeFetcher(
  verifierIdentity: FormAuthorityCoreVerifierIdentity | null,
  onVerifierReadback: () => void = () => undefined,
): Promise<(input: string, init?: RequestInit) => Promise<Response>> {
  const implementationPayloadDigest = `sha256:${"e".repeat(64)}` as const;
  const semantic = await derivePublicFormImplementationIdentity({
    implementationPayloadDigest,
    capabilities: publicFormCapabilityManifest(),
  });
  return async (input) => {
    const pathname = new URL(input).pathname;
    if (pathname === "/v1/public-host-identity") {
      return Response.json({
        kind: "takoserver.public-host-identity@v2",
        hostId: productionTarget.formAuthority.hostId,
        workerVersionId: PUBLIC_VERSION_ID,
        workerArtifactDigest: PUBLIC_ARTIFACT_DIGEST,
        ...semantic,
      });
    }
    if (pathname === FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_PATH) {
      onVerifierReadback();
      return verifierIdentity === null
        ? new Response(null, { status: 503 })
        : Response.json(verifierIdentity);
    }
    throw new Error(`unexpected probe path: ${pathname}`);
  };
}

function productionState(): FormAuthorityDeployState {
  return {
    async workerScripts() {
      return [productionTarget.workerName, productionTarget.formAuthority.workerName];
    },
    async workerDeployments(workerName) {
      const versionId =
        workerName === productionTarget.workerName ? PUBLIC_VERSION_ID : AUTHORITY_VERSION_ID;
      return [
        {
          id: `${workerName}-deployment`,
          created_on: "2026-08-31T00:00:00Z",
          versions: [{ version_id: versionId, percentage: 100 }],
        },
      ];
    },
    async workerVersion(workerName) {
      if (workerName === productionTarget.workerName) {
        const expected = expectedExactBindingClosure(productionTarget, {
          workerArtifactDigest: PUBLIC_ARTIFACT_DIGEST,
        });
        return {
          annotations: {
            "workers/message": `takoserver-worker:${COMMIT}:${PUBLIC_ARTIFACT_DIGEST.slice("sha256:".length)}`,
            "workers/triggered_by": "version_upload",
          },
          resources: {
            bindings: Object.entries(expected).flatMap(([name, requirement]) =>
              requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
            ),
          },
        };
      }
      return {
        annotations: {
          "workers/message": `form-authority:takoserver-form-authority-worker:${COMMIT}:sha256:${"f".repeat(64)}`,
        },
        resources: {
          bindings: [
            { type: "d1", name: "STATE_DB", id: productionTarget.d1.databaseId },
            {
              type: "r2_bucket",
              name: "OBJECTS",
              bucket_name: productionTarget.r2.bucketName,
            },
            { type: "version_metadata", name: "WORKER_VERSION" },
            {
              type: "durable_object_namespace",
              name: "CORE_VERIFIER",
              class_name: "TakoformCoreVerifierContainer",
            },
            {
              type: "service",
              name: "PUBLIC_HOST_IDENTITY",
              service: productionTarget.workerName,
              entrypoint: "PublicHostIdentityEntrypoint",
            },
            { type: "plain_text", name: "TAKOSERVER_ENVIRONMENT", text: "production" },
            {
              type: "plain_text",
              name: "TAKOSERVER_FORM_AUTHORITY_HOST_ID",
              text: productionTarget.formAuthority.hostId,
            },
            {
              type: "plain_text",
              name: "TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST",
              text: CAPABILITY_MANIFEST_JSON,
            },
            {
              type: "plain_text",
              name: "TAKOSERVER_TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST",
              text: takoformCoreVerifierArtifactDigest(),
            },
          ],
        },
      };
    },
    async workerSecrets(workerName) {
      return workerName === productionTarget.workerName
        ? expectedWorkerSecrets(productionTarget).map((name) => ({ name, type: "secret_text" }))
        : [];
    },
    async workerDomains() {
      return [{ hostname: "api.example.test", service: productionTarget.workerName }];
    },
    async workerSubdomain() {
      return { enabled: false, previewsEnabled: false };
    },
    async workerRoutes() {
      return [];
    },
  };
}

function productionApplyState(isUploaded: () => boolean): FormAuthorityDeployState {
  const current = productionState();
  return {
    ...current,
    async workerDeployments(workerName) {
      if (workerName === productionTarget.workerName) {
        return await current.workerDeployments(workerName);
      }
      return isUploaded()
        ? [
            {
              id: "authority-current-deployment",
              created_on: "2026-08-31T02:00:00Z",
              versions: [{ version_id: AUTHORITY_VERSION_ID, percentage: 100 }],
            },
            {
              id: "authority-previous-deployment",
              created_on: "2026-08-31T01:00:00Z",
              versions: [{ version_id: PREVIOUS_AUTHORITY_VERSION_ID, percentage: 100 }],
            },
          ]
        : [
            {
              id: "authority-previous-deployment",
              created_on: "2026-08-31T01:00:00Z",
              versions: [{ version_id: PREVIOUS_AUTHORITY_VERSION_ID, percentage: 100 }],
            },
          ];
    },
    async workerVersion(workerName, versionId) {
      if (workerName === productionTarget.workerName) {
        return await current.workerVersion(workerName, versionId);
      }
      const value = (await current.workerVersion(workerName, versionId)) as {
        annotations: Record<string, string>;
        resources: unknown;
      };
      value.annotations["workers/message"] = `form-authority:takoserver-form-authority-worker:${
        versionId === AUTHORITY_VERSION_ID ? COMMIT : PREVIOUS_COMMIT
      }:${versionId === AUTHORITY_VERSION_ID ? AUTHORITY_ARTIFACT_DIGEST : `sha256:${"9".repeat(64)}`}`;
      return value;
    },
  };
}

function productionProcess(onUpload: () => void): {
  readonly run: FormAuthorityProcess;
  readonly calls: string[][];
} {
  const calls: string[][] = [];
  const run: FormAuthorityProcess = async (command) => {
    calls.push([...command]);
    const key = command.join(" ");
    if (key === "git rev-parse HEAD" || key === "git rev-parse origin/main") {
      return commandResult(`${COMMIT}\n`);
    }
    if (key === "git branch --show-current") return commandResult("main\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") {
      return commandResult("");
    }
    if (key === "git fetch --quiet origin main" || key === "bun run check") {
      return commandResult("");
    }
    if (command.includes("--dry-run")) {
      const out = command[command.indexOf("--outdir") + 1];
      if (!out) throw new Error("dry-run output directory missing");
      mkdirSync(out, { recursive: true });
      const bundle = out.includes("public-worker-proof") ? PUBLIC_BUNDLE : AUTHORITY_BUNDLE;
      writeFileSync(join(out, "worker.js"), bundle);
      writeFileSync(join(out, "worker.js.map"), "{}\n");
      writeFileSync(join(out, "README.md"), "generated by Wrangler\n");
      return commandResult("built\n");
    }
    if (command.includes("--no-bundle") && command.includes("--strict")) {
      onUpload();
      return commandResult("uploaded\n");
    }
    throw new Error(`unexpected command: ${key}`);
  };
  return { run, calls };
}

function commandResult(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" };
}
