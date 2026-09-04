import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { DeployError } from "../scripts/deploy/errors.ts";
import {
  type FormAuthorityDeployState,
  type FormAuthorityProcess,
  publicFormCapabilityManifest,
  runFormAuthority,
  takoformCoreVerifierArtifactDigest,
} from "../scripts/deploy/form-authority.ts";
import {
  type FormAuthorityIdentityProbeState,
  runFormAuthorityIdentityProbe,
} from "../scripts/deploy/form-authority-identity-probe.ts";
import { expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";
import { handleFormAuthorityIdentityProbe } from "../src/form-authority-identity-probe.ts";
import { canonicalJson } from "../src/json.ts";
import { derivePublicFormImplementationIdentity } from "../src/public-worker-implementation.ts";
import { YURUCOMMU_IDENTITY_CAPABILITY_KINDS } from "../src/takoform/implementation-catalog.ts";
import { cloudflareProviderExecutorTarget } from "./helpers/hosted-supply-fixtures.ts";

const COMMIT = "a".repeat(40);
const PUBLIC_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const PROBE_VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PROBE_SUCCESSOR_VERSION_ID = "55555555-5555-4555-8555-555555555555";
const DRIFTED_PROBE_VERSION_ID = "66666666-6666-4666-8666-666666666666";
const BOOTSTRAP_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const SUCCESSOR_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const PUBLIC_BUNDLE = "export default { async fetch() { return new Response('public'); } };\n";
const AUTHORITY_BUNDLE = "export default class FormAuthorityEntrypoint {}\n";
const PUBLIC_ARTIFACT_DIGEST = `sha256:${createHash("sha256")
  .update(PUBLIC_BUNDLE)
  .digest("hex")}` as const;
const AUTHORITY_ARTIFACT_DIGEST = `sha256:${createHash("sha256")
  .update(AUTHORITY_BUNDLE)
  .digest("hex")}` as const;
const PROBE_ARTIFACT_DIGEST = AUTHORITY_ARTIFACT_DIGEST;
const IMPLEMENTATION_PAYLOAD_DIGEST = `sha256:${"9".repeat(64)}` as const;
const CORE_VERIFIER_PATH = "/v1/core-verifier-identity";
const CORE_VERIFIER_ARTIFACT_DIGEST = takoformCoreVerifierArtifactDigest();

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
  edgeSupplies: {
    offerings: YURUCOMMU_IDENTITY_CAPABILITY_KINDS.filter(
      (formKind) => formKind !== "ObjectBucket",
    ).map((formKind) => ({ formKind })),
  } as unknown as NonNullable<DeployTarget["edgeSupplies"]>,
  objectBucketSupplies: {
    supplies: [{ provider: { kind: "cloudflare" } }],
  } as unknown as NonNullable<DeployTarget["objectBucketSupplies"]>,
  cloudflareProviderExecutor: cloudflareProviderExecutorTarget("cloudflare.primary"),
  formAuthority: {
    workerName: "takoserver-form-authority-integration",
    identityProbeWorkerName: "takoserver-form-identity-integration",
    identityProbeOrigin:
      "https://takoserver-form-identity-integration.integration.example.workers.dev",
    hostId: "https://api.integration.example.test",
  },
  signing: { currentKeyId: "key-current" },
} satisfies DeployTarget;

interface SharedFakeState extends FormAuthorityDeployState, FormAuthorityIdentityProbeState {
  authorityUploads: number;
  probeBound: boolean;
  probeDrift: "none" | "extra-binding" | "advanced";
}

describe("released-Core authority bootstrap sequence", () => {
  test("carries one fake account from absent authority through probe binding and steady apply", async () => {
    const state = createSharedState();
    const process = fakeProcess(state);
    const fetcher = createProbeFetcher(state);
    const invocation = {
      surface: "takoserver-form-authority-worker" as const,
      environment: "integration" as const,
      commit: COMMIT,
    };

    const bootstrap = await runFormAuthority(
      {
        ...invocation,
        action: "apply",
        bootstrapVerifierBridge: true,
        bootstrapProbePredecessorVersionId: PROBE_VERSION_ID,
      },
      target,
      {
        run: process.run,
        state,
        fetcher: fetcher.fetcher,
        review: "independent-reviewer",
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
      },
    );
    expect(bootstrap).toMatchObject({
      verifierBridgePending: true,
      bootstrapProbePredecessorVersionId: PROBE_VERSION_ID,
      bootstrapProbePredecessorCommit: COMMIT,
      bootstrapProbeArtifactDigest: PROBE_ARTIFACT_DIGEST,
      previousVersionId: null,
      versionId: BOOTSTRAP_VERSION_ID,
    });
    expect(String(bootstrap.verifierBridgeNextStep)).toContain(
      `--closure-predecessor-version=${PROBE_VERSION_ID}`,
    );
    expect(fetcher.paths).not.toContain(CORE_VERIFIER_PATH);

    const unboundBridge = await fetcher.fetcher(
      `${target.formAuthority.identityProbeOrigin}${CORE_VERIFIER_PATH}`,
    );
    expect(unboundBridge.status).toBe(503);

    const probe = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
        transition: {
          predecessorVersionId: PROBE_VERSION_ID,
          delta: {
            retiredVars: [],
            addedVars: [],
            refreshedVars: [],
            addedBindings: ["FORM_AUTHORITY"],
            addedSecrets: [],
            rotatedSecrets: [],
          },
        },
      },
      target,
      {
        run: process.run,
        state,
        fetcher: fetcher.fetcher,
        review: "independent-reviewer",
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
      },
    );
    expect(probe).toMatchObject({
      formAuthorityWorkerName: target.formAuthority.workerName,
      previousVersionId: PROBE_VERSION_ID,
      versionId: PROBE_SUCCESSOR_VERSION_ID,
      ready: true,
    });
    expect(state.probeBound).toBe(true);

    const boundBridge = await fetcher.fetcher(
      `${target.formAuthority.identityProbeOrigin}${CORE_VERIFIER_PATH}`,
    );
    expect(boundBridge.status).toBe(200);
    expect(await boundBridge.json()).toMatchObject({
      authorityWorkerVersionId: BOOTSTRAP_VERSION_ID,
    });

    const status = await runFormAuthority({ ...invocation, action: "status" }, target, {
      state,
      fetcher: fetcher.fetcher,
    });
    expect(status).toMatchObject({
      versionId: BOOTSTRAP_VERSION_ID,
      coreVerifierRpcReady: true,
      coreVerifierAuthorityWorkerVersionId: BOOTSTRAP_VERSION_ID,
      ready: true,
    });

    const readsBeforeApply = fetcher.paths.filter((path) => path === CORE_VERIFIER_PATH).length;
    const ordinaryApply = await runFormAuthority({ ...invocation, action: "apply" }, target, {
      run: process.run,
      state,
      fetcher: fetcher.fetcher,
      review: "independent-reviewer",
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
    });
    expect(ordinaryApply).toMatchObject({
      previousVersionId: BOOTSTRAP_VERSION_ID,
      versionId: SUCCESSOR_VERSION_ID,
      coreVerifierRpcReady: true,
      coreVerifierAuthorityWorkerVersionId: SUCCESSOR_VERSION_ID,
    });
    expect(fetcher.paths.filter((path) => path === CORE_VERIFIER_PATH).length).toBeGreaterThan(
      readsBeforeApply,
    );
    expect(state.authorityUploads).toBe(2);
  });

  test("refuses an untransitionable probe before publishing the first authority Version", async () => {
    const state = createSharedState({ probeDrift: "extra-binding" });
    const refusal = await runFormAuthority(
      {
        surface: "takoserver-form-authority-worker",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
        bootstrapVerifierBridge: true,
        bootstrapProbePredecessorVersionId: PROBE_VERSION_ID,
      },
      target,
      {
        run: fakeProcess(state).run,
        state,
        fetcher: createProbeFetcher(state).fetcher,
        review: "independent-reviewer",
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
      },
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(DeployError);
    expect((refusal as DeployError).phase).toBe("preflight");
    expect((refusal as DeployError).message).toContain("identity probe");
    expect(state.authorityUploads).toBe(0);
  });

  test("rechecks the exact probe predecessor at the final mutation fence", async () => {
    const state = createSharedState();
    let ownerGatePassed = false;
    const refusal = await runFormAuthority(
      {
        surface: "takoserver-form-authority-worker",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
        bootstrapVerifierBridge: true,
        bootstrapProbePredecessorVersionId: PROBE_VERSION_ID,
      },
      target,
      {
        run: fakeProcess(state, {
          onOwnerGate: () => {
            ownerGatePassed = true;
            state.probeDrift = "advanced";
          },
        }).run,
        state,
        fetcher: createProbeFetcher(state).fetcher,
        review: "independent-reviewer",
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
      },
    ).catch((error: unknown) => error);

    expect(ownerGatePassed).toBe(true);
    expect(refusal).toBeInstanceOf(DeployError);
    expect((refusal as DeployError).phase).toBe("preflight");
    expect((refusal as DeployError).message).toContain("identity probe");
    expect(state.authorityUploads).toBe(0);
  });
});

function createSharedState(
  input: { readonly probeDrift?: SharedFakeState["probeDrift"] } = {},
): SharedFakeState {
  const state: SharedFakeState = {
    authorityUploads: 0,
    probeBound: false,
    probeDrift: input.probeDrift ?? "none",
    async workerScripts() {
      return [
        target.workerName,
        target.formAuthority.identityProbeWorkerName,
        ...(state.authorityUploads > 0 ? [target.formAuthority.workerName] : []),
      ];
    },
    async workerDeployments(workerName) {
      if (workerName === target.workerName) {
        return [deployment("public", PUBLIC_VERSION_ID, "2026-09-03T00:00:00Z")];
      }
      if (workerName === target.formAuthority.identityProbeWorkerName) {
        if (state.probeDrift === "advanced") {
          return [
            deployment("probe-drifted", DRIFTED_PROBE_VERSION_ID, "2026-09-03T01:30:00Z"),
            deployment("probe-predecessor", PROBE_VERSION_ID, "2026-09-03T01:00:00Z"),
          ];
        }
        return state.probeBound
          ? [
              deployment("probe-current", PROBE_SUCCESSOR_VERSION_ID, "2026-09-03T02:00:00Z"),
              deployment("probe-predecessor", PROBE_VERSION_ID, "2026-09-03T01:00:00Z"),
            ]
          : [deployment("probe-current", PROBE_VERSION_ID, "2026-09-03T01:00:00Z")];
      }
      if (state.authorityUploads === 0) return [];
      return state.authorityUploads === 1
        ? [deployment("authority-bootstrap", BOOTSTRAP_VERSION_ID, "2026-09-03T03:00:00Z")]
        : [
            deployment("authority-successor", SUCCESSOR_VERSION_ID, "2026-09-03T05:00:00Z"),
            deployment("authority-bootstrap", BOOTSTRAP_VERSION_ID, "2026-09-03T03:00:00Z"),
          ];
    },
    async workerVersion(workerName, versionId) {
      if (workerName === target.workerName) return publicVersion();
      if (workerName === target.formAuthority.identityProbeWorkerName) {
        if (versionId === DRIFTED_PROBE_VERSION_ID) {
          return probeVersion(false, { commit: "b".repeat(40), extraBinding: true });
        }
        return probeVersion(state.probeBound, {
          extraBinding: state.probeDrift === "extra-binding",
        });
      }
      return authorityVersion();
    },
    async workerSecrets(workerName) {
      return workerName === target.workerName
        ? expectedWorkerSecrets(target).map((name) => ({ name, type: "secret_text" }))
        : [];
    },
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: target.workerName }];
    },
    async workerSubdomain(workerName) {
      return {
        enabled: workerName === target.formAuthority.identityProbeWorkerName,
        previewsEnabled: false,
      };
    },
    async workerRoutes() {
      return [];
    },
  };
  return state;
}

function fakeProcess(
  state: SharedFakeState,
  input: { readonly onOwnerGate?: () => void } = {},
): {
  readonly run: FormAuthorityProcess;
} {
  const run: FormAuthorityProcess = async (command) => {
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (key === "git branch --show-current") return ok("feature/bootstrap-sequence\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (key === "bun run check") {
      input.onOwnerGate?.();
      return ok("green\n");
    }
    if (command.includes("--dry-run")) {
      const out = command[command.indexOf("--outdir") + 1];
      if (!out) throw new Error("dry-run outdir missing");
      mkdirSync(out, { recursive: true });
      writeFileSync(
        `${out}/worker.js`,
        out.includes("public-worker-proof") ? PUBLIC_BUNDLE : AUTHORITY_BUNDLE,
      );
      writeFileSync(`${out}/worker.js.map`, "{}\n");
      writeFileSync(`${out}/README.md`, "generated by Wrangler\n");
      return ok("built\n");
    }
    if (command.includes("--no-bundle")) {
      const message = command[command.indexOf("--message") + 1] ?? "";
      if (message.startsWith("form-authority-identity-probe:")) state.probeBound = true;
      if (message.startsWith("form-authority:takoserver-form-authority-worker:")) {
        state.authorityUploads += 1;
      }
      return ok("uploaded\n");
    }
    throw new Error(`unexpected command: ${key}`);
  };
  return { run };
}

function createProbeFetcher(state: SharedFakeState): {
  readonly paths: string[];
  readonly fetcher: (input: string, init?: RequestInit) => Promise<Response>;
} {
  const paths: string[] = [];
  const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(input).pathname;
    paths.push(path);
    const publicIdentity = {
      kind: "takoserver.public-host-identity@v2" as const,
      hostId: target.formAuthority.hostId,
      workerVersionId: PUBLIC_VERSION_ID,
      workerArtifactDigest: PUBLIC_ARTIFACT_DIGEST,
      ...(await derivePublicFormImplementationIdentity({
        implementationPayloadDigest: IMPLEMENTATION_PAYLOAD_DIGEST,
        capabilities: publicFormCapabilityManifest(),
      })),
    };
    const response = await handleFormAuthorityIdentityProbe(request, {
      TAKOSERVER_FORM_AUTHORITY_HOST_ID: target.formAuthority.hostId,
      PUBLIC_HOST_IDENTITY: {
        async identity() {
          return publicIdentity;
        },
      },
      FORM_AUTHORITY: {
        async verifierIdentity() {
          if (!state.probeBound || state.authorityUploads === 0) {
            throw new Error("FORM_AUTHORITY binding is not live");
          }
          return {
            kind: "takoserver.form-authority-core-verifier-identity@v1" as const,
            authorityWorkerVersionId:
              state.authorityUploads > 1 ? SUCCESSOR_VERSION_ID : BOOTSTRAP_VERSION_ID,
            verifier: {
              protocol: "takoserver.takoform-core-verifier@v1" as const,
              coreVersion: "v1.1.0" as const,
              coreCommit: "e0e48b864de2a127a255cb0574d37bbb0f1cac29" as const,
              artifactDigest: CORE_VERIFIER_ARTIFACT_DIGEST,
            },
          };
        },
      },
    });
    return response;
  };
  return { paths, fetcher };
}

function publicVersion() {
  const expected = expectedExactBindingClosure(target, {
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

function probeVersion(
  bound: boolean,
  input: { readonly commit?: string; readonly extraBinding?: boolean } = {},
) {
  return {
    annotations: {
      "workers/message": `form-authority-identity-probe:${input.commit ?? COMMIT}:${PROBE_ARTIFACT_DIGEST}`,
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
        ...(bound
          ? [
              {
                name: "FORM_AUTHORITY",
                type: "service",
                service: target.formAuthority.workerName,
                entrypoint: "FormAuthorityEntrypoint",
              },
            ]
          : []),
        ...(input.extraBinding
          ? [{ name: "UNRELATED", type: "plain_text", text: "unexpected" }]
          : []),
      ],
    },
  };
}

function authorityVersion() {
  const capabilityManifestJson = canonicalJson(publicFormCapabilityManifest());
  return {
    annotations: {
      "workers/message": `form-authority:takoserver-form-authority-worker:${COMMIT}:${AUTHORITY_ARTIFACT_DIGEST}`,
    },
    resources: {
      bindings: [
        { name: "STATE_DB", type: "d1", id: target.d1.databaseId },
        { name: "OBJECTS", type: "r2_bucket", bucket_name: target.r2.bucketName },
        {
          name: "PUBLIC_HOST_IDENTITY",
          type: "service",
          service: target.workerName,
          entrypoint: "PublicHostIdentityEntrypoint",
        },
        { name: "TAKOSERVER_ENVIRONMENT", type: "plain_text", text: "integration" },
        {
          name: "TAKOSERVER_FORM_AUTHORITY_HOST_ID",
          type: "plain_text",
          text: target.formAuthority.hostId,
        },
        {
          name: "TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST",
          type: "plain_text",
          text: capabilityManifestJson,
        },
        { name: "WORKER_VERSION", type: "version_metadata" },
        {
          name: "CORE_VERIFIER",
          type: "durable_object_namespace",
          class_name: "TakoformCoreVerifierContainer",
        },
        {
          name: "TAKOSERVER_TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST",
          type: "plain_text",
          text: CORE_VERIFIER_ARTIFACT_DIGEST,
        },
      ],
    },
  };
}

function deployment(id: string, versionId: string, createdOn: string) {
  return {
    id,
    created_on: createdOn,
    versions: [{ version_id: versionId, percentage: 100 }],
  };
}

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" };
}
