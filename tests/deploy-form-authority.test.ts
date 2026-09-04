import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import {
  type FormAuthorityDeployState,
  type FormAuthorityProcess,
  publicFormCapabilityManifest,
  runFormAuthority as runFormAuthorityImpl,
  takoformCoreVerifierArtifactDigest,
  writeFormAuthorityConfig,
} from "../scripts/deploy/form-authority.ts";
import { expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";
import { canonicalJson } from "../src/json.ts";
import { derivePublicFormImplementationIdentity } from "../src/public-worker-implementation.ts";
import {
  YURUCOMMU_IDENTITY_CAPABILITY_KINDS,
  yurucommuLifecycleCapabilityManifest,
} from "../src/takoform/implementation-catalog.ts";
import {
  cloudflareProviderExecutorTarget,
  edgeSuppliesFixture,
  objectBucketSuppliesFixture,
} from "./helpers/hosted-supply-fixtures.ts";

const COMMIT = "a".repeat(40);
const PREVIOUS_COMMIT = "b".repeat(40);
const PUBLIC_WORKER_COMMIT = COMMIT;
const PUBLIC_WORKER_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const PREVIOUS_PUBLIC_WORKER_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const DRIFTED_PUBLIC_WORKER_VERSION_ID = "22222222-2222-4222-8222-222222222222";
const PREVIOUS_AUTHORITY_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const CURRENT_AUTHORITY_VERSION_ID = "55555555-5555-4555-8555-555555555555";
const ARBITRARY_PUBLIC_WORKER_VERSION_ID = "66666666-6666-4666-8666-666666666666";
const TWO_HOP_PUBLIC_WORKER_VERSION_ID = "77777777-7777-4777-8777-777777777777";
const BUNDLE = "export default class FormAuthorityEntrypoint {}\n";
const PUBLIC_BUNDLE = "export default { async fetch() { return new Response('public'); } };\n";
const BUNDLE_DIGEST = `sha256:${createHash("sha256").update(BUNDLE).digest("hex")}` as const;
const PREVIOUS_DIGEST = `sha256:${"c".repeat(64)}` as const;
const PREVIOUS_PUBLIC_WORKER_DIGEST = `sha256:${"d".repeat(64)}` as const;
const HISTORICAL_SIGNING_KEY_ID = "key-historical";
const PUBLIC_WORKER_DIGEST = `sha256:${createHash("sha256")
  .update(PUBLIC_BUNDLE)
  .digest("hex")}` as const;
const CAPABILITY_MANIFEST_JSON = canonicalJson(publicFormCapabilityManifest());
const OPERATOR_ORIGIN = "https://form-authority.integration.takoserver.com";
const OPERATOR_PUBLIC_JWK = {
  kty: "OKP" as const,
  crv: "Ed25519" as const,
  x: "A".repeat(43),
};
const PREDECESSOR_SCOPE = {
  tenantId: "tenant-yurucommu-predecessor",
  space: "space-yurucommu-predecessor",
} as const;

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
    integrationWorkerName: "takoserver-form-fixture-integration",
    integrationOperatorWorkerName: "takoserver-form-operator-integration",
    integrationOperatorOrigin: OPERATOR_ORIGIN,
    integrationOperatorScope: {
      tenantId: "tenant-yurucommu-integration",
      space: "space-yurucommu-integration",
    },
    operatorPublicJwk: OPERATOR_PUBLIC_JWK,
    hostId: "https://api.integration.example.test",
  },
  signing: { currentKeyId: "key-current" },
} satisfies DeployTarget;

async function runFormAuthority(
  ...[invocation, selectedTarget, options = {}]: Parameters<typeof runFormAuthorityImpl>
): ReturnType<typeof runFormAuthorityImpl> {
  return await runFormAuthorityImpl(invocation, selectedTarget, {
    fetcher: async () => {
      const implementationPayloadDigest = `sha256:${"9".repeat(64)}` as const;
      const semantic = await derivePublicFormImplementationIdentity({
        implementationPayloadDigest,
        capabilities: publicFormCapabilityManifest(),
      });
      return Response.json({
        kind: "takoserver.public-host-identity@v2",
        hostId: selectedTarget.formAuthority?.hostId,
        workerVersionId: PUBLIC_WORKER_VERSION_ID,
        workerArtifactDigest: PUBLIC_WORKER_DIGEST,
        ...semantic,
      });
    },
    ...options,
  });
}
const SCOPE_TRANSITION_VALUE = {
  kind: "takoserver.integration-form-authority-scope-transition@v1",
  environment: "integration",
  hostId: target.formAuthority.hostId,
  predecessorScope: PREDECESSOR_SCOPE,
  targetScope: target.formAuthority.integrationOperatorScope,
} as const;
const SCOPE_TRANSITION = {
  value: SCOPE_TRANSITION_VALUE,
  digest: `sha256:${createHash("sha256")
    .update(canonicalJson(SCOPE_TRANSITION_VALUE))
    .digest("hex")}` as const,
};

function fakeProcess(input?: { readonly onUpload?: () => void; readonly failUpload?: boolean }): {
  readonly run: FormAuthorityProcess;
  readonly calls: string[][];
} {
  const calls: string[][] = [];
  const run: FormAuthorityProcess = async (command) => {
    calls.push([...command]);
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (key === "git branch --show-current") return ok("feature/form-authority\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (key === "bun run check") return ok("");
    if (command.includes("--dry-run")) {
      const out = command[command.indexOf("--outdir") + 1];
      if (!out) throw new Error("dry-run outdir missing");
      mkdirSync(out, { recursive: true });
      writeFileSync(
        join(out, "worker.js"),
        command.some((value) => value.includes("public-worker-proof")) ? PUBLIC_BUNDLE : BUNDLE,
      );
      writeFileSync(join(out, "worker.js.map"), "{}\n");
      writeFileSync(join(out, "README.md"), "generated by Wrangler\n");
      return ok("built\n");
    }
    if (command.includes("--no-bundle") && command.includes("--strict")) {
      input?.onUpload?.();
      if (input?.failUpload) return { exitCode: 1, stdout: "", stderr: "lost acknowledgement" };
      return ok("uploaded\n");
    }
    throw new Error(`unexpected command: ${key}`);
  };
  return { run, calls };
}

function stateSequence(
  input?: {
    readonly publicDrift?: boolean;
    readonly subdomain?: boolean;
    readonly route?: boolean;
    readonly isUploaded?: () => boolean;
    readonly legacyBoundVersionId?: string;
    readonly legacyBoundArtifactDigest?: `sha256:${string}`;
    readonly legacyCommit?: string;
  },
  inspectedTarget: DeployTarget = target,
): FormAuthorityDeployState {
  let historyRead = 0;
  let publicHistoryRead = 0;
  return {
    async workerScripts() {
      return [target.formAuthority.integrationWorkerName];
    },
    async workerDeployments(workerName) {
      if (workerName === target.workerName) {
        publicHistoryRead += 1;
        const drifted = input?.publicDrift === true && publicHistoryRead > 1;
        return [
          deployment(
            drifted ? "public-deployment-drifted" : "public-deployment",
            drifted ? DRIFTED_PUBLIC_WORKER_VERSION_ID : PUBLIC_WORKER_VERSION_ID,
            drifted ? "2026-08-28T03:00:00Z" : "2026-08-28T00:00:00Z",
          ),
          deployment(
            "public-deployment-previous",
            PREVIOUS_PUBLIC_WORKER_VERSION_ID,
            "2026-08-27T23:00:00Z",
          ),
        ];
      }
      historyRead += 1;
      const uploaded = input?.isUploaded?.() ?? historyRead >= 3;
      return !uploaded
        ? [deployment("deployment-previous", PREVIOUS_AUTHORITY_VERSION_ID, "2026-08-28T01:00:00Z")]
        : [
            deployment("deployment-current", CURRENT_AUTHORITY_VERSION_ID, "2026-08-28T02:00:00Z"),
            deployment(
              "deployment-previous",
              PREVIOUS_AUTHORITY_VERSION_ID,
              "2026-08-28T01:00:00Z",
            ),
          ];
    },
    async workerVersion(workerName, versionId) {
      if (workerName === target.workerName) {
        const previous = versionId === PREVIOUS_PUBLIC_WORKER_VERSION_ID;
        const digest = previous
          ? PREVIOUS_PUBLIC_WORKER_DIGEST.slice("sha256:".length)
          : versionId === DRIFTED_PUBLIC_WORKER_VERSION_ID
            ? "f".repeat(64)
            : PUBLIC_WORKER_DIGEST.slice("sha256:".length);
        return publicVersion(
          `takoserver-worker:${previous ? PREVIOUS_COMMIT : PUBLIC_WORKER_COMMIT}:${digest}`,
          inspectedTarget,
        );
      }
      const current = versionId === CURRENT_AUTHORITY_VERSION_ID;
      const commit = current ? COMMIT : (input?.legacyCommit ?? PREVIOUS_COMMIT);
      const artifactDigest = current ? BUNDLE_DIGEST : PREVIOUS_DIGEST;
      return current
        ? dynamicVersion(commit, artifactDigest)
        : version(
            commit,
            artifactDigest,
            input?.legacyBoundVersionId ?? PREVIOUS_PUBLIC_WORKER_VERSION_ID,
            input?.legacyBoundArtifactDigest ?? PREVIOUS_PUBLIC_WORKER_DIGEST,
          );
    },
    async workerSecrets(workerName) {
      return workerName === target.workerName
        ? expectedWorkerSecrets(target).map((name) => ({ name, type: "secret_text" }))
        : [];
    },
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: target.workerName }];
    },
    async workerSubdomain() {
      return { enabled: input?.subdomain === true, previewsEnabled: false };
    },
    async workerRoutes() {
      return input?.route
        ? [
            {
              zoneId: "zone-1",
              id: "route-1",
              pattern: "authority.example.test/*",
              script: target.formAuthority.integrationWorkerName,
            },
          ]
        : [];
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

function version(
  commit: string,
  artifactDigest: `sha256:${string}`,
  publicWorkerVersionId = PUBLIC_WORKER_VERSION_ID,
  publicWorkerArtifactDigest: `sha256:${string}` = PUBLIC_WORKER_DIGEST,
  scope: { readonly tenantId: string; readonly space: string } = target.formAuthority
    .integrationOperatorScope,
) {
  return {
    annotations: {
      "workers/message": `form-authority:takoserver-integration-form-authority-worker:${commit}:${artifactDigest}`,
    },
    resources: {
      bindings: [
        { type: "d1", name: "STATE_DB", id: target.d1.databaseId },
        { type: "r2_bucket", name: "OBJECTS", bucket_name: target.r2.bucketName },
        { type: "plain_text", name: "TAKOSERVER_ENVIRONMENT", text: "integration" },
        {
          type: "plain_text",
          name: "TAKOSERVER_FORM_AUTHORITY_HOST_ID",
          text: target.formAuthority.hostId,
        },
        {
          type: "plain_text",
          name: "TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST",
          text: publicWorkerArtifactDigest,
        },
        {
          type: "plain_text",
          name: "TAKOSERVER_PUBLIC_WORKER_VERSION_ID",
          text: publicWorkerVersionId,
        },
        {
          type: "plain_text",
          name: "TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST",
          text: CAPABILITY_MANIFEST_JSON,
        },
        {
          type: "plain_text",
          name: "TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK",
          text: canonicalJson(OPERATOR_PUBLIC_JWK),
        },
        {
          type: "plain_text",
          name: "TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID",
          text: scope.tenantId,
        },
        {
          type: "plain_text",
          name: "TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE",
          text: scope.space,
        },
        {
          type: "service",
          name: "PUBLIC_HOST_IDENTITY",
          service: target.workerName,
          entrypoint: "PublicHostIdentityEntrypoint",
        },
      ],
    },
  };
}

function dynamicVersion(
  commit: string,
  artifactDigest: `sha256:${string}`,
  scope: { readonly tenantId: string; readonly space: string } = target.formAuthority
    .integrationOperatorScope,
) {
  const value = version(
    commit,
    artifactDigest,
    PUBLIC_WORKER_VERSION_ID,
    PUBLIC_WORKER_DIGEST,
    scope,
  );
  value.resources.bindings = value.resources.bindings.filter(
    ({ name }) =>
      name !== "TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST" &&
      name !== "TAKOSERVER_PUBLIC_WORKER_VERSION_ID",
  );
  return value;
}

function invalidPredecessorState(input: {
  readonly boundVersionId?: string;
  readonly boundArtifactDigest?: `sha256:${string}`;
  readonly authorityCommit?: string;
  readonly twoHop?: boolean;
  readonly malformedHistory?: boolean;
}): FormAuthorityDeployState {
  const current = stateSequence({ isUploaded: () => false });
  return {
    ...current,
    async workerDeployments(workerName) {
      if (workerName !== target.workerName) return await current.workerDeployments(workerName);
      if (input.malformedHistory) {
        return [{ id: "public-deployment", created_on: "not-a-timestamp", versions: [] }];
      }
      return [
        deployment("public-deployment", PUBLIC_WORKER_VERSION_ID, "2026-08-28T03:00:00Z"),
        deployment(
          "public-deployment-previous",
          PREVIOUS_PUBLIC_WORKER_VERSION_ID,
          "2026-08-28T02:00:00Z",
        ),
        ...(input.twoHop
          ? [
              deployment(
                "public-deployment-two-hop",
                TWO_HOP_PUBLIC_WORKER_VERSION_ID,
                "2026-08-28T01:00:00Z",
              ),
            ]
          : []),
      ];
    },
    async workerVersion(workerName, versionId) {
      if (workerName === target.formAuthority.integrationWorkerName) {
        return version(
          input.authorityCommit ?? PREVIOUS_COMMIT,
          PREVIOUS_DIGEST,
          input.boundVersionId ?? PREVIOUS_PUBLIC_WORKER_VERSION_ID,
          input.boundArtifactDigest ?? PREVIOUS_PUBLIC_WORKER_DIGEST,
        );
      }
      return await current.workerVersion(workerName, versionId);
    },
  };
}

function qualificationDriftState(
  kind: "public-predecessor" | "authority-history",
  isUploaded: () => boolean,
): FormAuthorityDeployState {
  const current = stateSequence({ isUploaded });
  let publicReads = 0;
  let authorityReads = 0;
  return {
    ...current,
    async workerDeployments(workerName) {
      const history = await current.workerDeployments(workerName);
      if (workerName === target.workerName) {
        publicReads += 1;
        if (kind === "public-predecessor" && publicReads > 1) {
          return [
            history[0],
            deployment(
              "public-deployment-drifted-predecessor",
              ARBITRARY_PUBLIC_WORKER_VERSION_ID,
              "2026-08-28T01:00:00Z",
            ),
          ];
        }
      }
      if (workerName === target.formAuthority.integrationWorkerName && !isUploaded()) {
        authorityReads += 1;
        if (kind === "authority-history" && authorityReads > 1) {
          return [
            history[0],
            deployment(
              "authority-unrelated-predecessor",
              "88888888-8888-4888-8888-888888888888",
              "2026-08-28T01:00:00Z",
            ),
          ];
        }
      }
      return history;
    },
  };
}

function publicVersion(message: string, inspectedTarget: DeployTarget = target) {
  const identity = /^takoserver-worker:([0-9a-f]{40}):([0-9a-f]{64})$/u.exec(message);
  if (!identity?.[1] || !identity[2]) throw new Error("invalid public Worker fixture identity");
  const expected = expectedExactBindingClosure(
    inspectedTarget,
    inspectedTarget.integrationE2eCredentialAuthority === undefined
      ? { workerArtifactDigest: `sha256:${identity[2]}` }
      : {
          workerArtifactDigest: `sha256:${identity[2]}`,
          authorityProfile: {
            kind: "provenance-bound-jit",
            provenance: {
              sourceCommit: identity[1],
              artifactDigest: `sha256:${identity[2]}`,
            },
          },
        },
  );
  return {
    annotations: { "workers/message": message, "workers/triggered_by": "version_upload" },
    resources: {
      bindings: Object.entries(expected).flatMap(([name, requirement]) =>
        requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
      ),
    },
  };
}

function evolvedIntegrationTarget(): DeployTarget {
  return {
    ...target,
    zones: [{ zoneId: "zone-integration", suffix: "apps.integration.example.test" }],
    aiModels: [{ id: "model-integration", provider: "openai" }],
    sponsorship: true,
    operatorIdentity: { publicJwk: OPERATOR_PUBLIC_JWK },
    integrationE2eCredentialAuthority: {
      organizationId: "org_takosumi_hosted_staging",
      publicJwk: { kty: "OKP", crv: "Ed25519", x: "E".repeat(43) },
    },
    signing: { currentKeyId: "key-current" },
  };
}

interface HistoricalPublicVersion {
  readonly annotations: Record<string, string>;
  readonly resources: { bindings: Record<string, unknown>[] };
}

function historicalPinnedPublicState(
  currentTarget: DeployTarget,
  options: {
    readonly authorityCommit?: string;
    readonly boundArtifactDigest?: `sha256:${string}`;
    readonly isUploaded?: () => boolean;
    readonly mutateHistoricalVersion?: (version: HistoricalPublicVersion) => void;
  } = {},
): FormAuthorityDeployState {
  const current = stateSequence({ isUploaded: options.isUploaded ?? (() => false) }, currentTarget);
  const {
    sponsorship: _currentSponsorship,
    integrationE2eCredentialAuthority: _currentCredentialAuthority,
    ...historicalBase
  } = currentTarget;
  const historicalTarget = {
    ...historicalBase,
    signing: { currentKeyId: HISTORICAL_SIGNING_KEY_ID },
  } satisfies DeployTarget;
  return {
    ...current,
    async workerVersion(workerName, versionId) {
      if (workerName === currentTarget.workerName) {
        if (versionId === ARBITRARY_PUBLIC_WORKER_VERSION_ID) {
          const historical = historicalPublicVersion(
            `takoserver-worker:${PREVIOUS_COMMIT}:${PREVIOUS_PUBLIC_WORKER_DIGEST.slice("sha256:".length)}`,
            historicalTarget,
          );
          options.mutateHistoricalVersion?.(historical);
          return historical;
        }
        return publicVersion(
          `takoserver-worker:${PUBLIC_WORKER_COMMIT}:${PUBLIC_WORKER_DIGEST.slice("sha256:".length)}`,
          currentTarget,
        );
      }
      if (versionId === CURRENT_AUTHORITY_VERSION_ID) {
        return await current.workerVersion(workerName, versionId);
      }
      return version(
        options.authorityCommit ?? PREVIOUS_COMMIT,
        PREVIOUS_DIGEST,
        ARBITRARY_PUBLIC_WORKER_VERSION_ID,
        options.boundArtifactDigest ?? PREVIOUS_PUBLIC_WORKER_DIGEST,
      );
    },
    async workerSecrets(workerName) {
      return workerName === currentTarget.workerName
        ? expectedWorkerSecrets(currentTarget).map((name) => ({ name, type: "secret_text" }))
        : [];
    },
  };
}

function historicalPublicVersion(
  message: string,
  historicalTarget: DeployTarget,
): HistoricalPublicVersion {
  const expected = expectedExactBindingClosure(historicalTarget);
  return {
    annotations: { "workers/message": message, "workers/triggered_by": "version_upload" },
    resources: {
      bindings: Object.entries(expected).flatMap(([name, requirement]) =>
        requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
      ),
    },
  };
}

function historicalAuthorityMigrationState(
  currentTarget: DeployTarget,
  state: { readonly routeLessUploaded: () => boolean; readonly gatewayUploaded: () => boolean },
): FormAuthorityDeployState {
  const formAuthority = currentTarget.formAuthority;
  if (!formAuthority?.integrationWorkerName || !formAuthority.integrationOperatorWorkerName) {
    throw new Error("historical authority migration fixture requires both integration Workers");
  }
  const authorityWorkerName = formAuthority.integrationWorkerName;
  const gatewayWorkerName = formAuthority.integrationOperatorWorkerName;
  const {
    sponsorship: _currentSponsorship,
    integrationE2eCredentialAuthority: _currentCredentialAuthority,
    ...historicalBase
  } = currentTarget;
  const historicalTarget = {
    ...historicalBase,
    signing: { currentKeyId: HISTORICAL_SIGNING_KEY_ID },
  } satisfies DeployTarget;
  const historicalGatewayVersion = gatewayVersion(undefined, true);
  historicalGatewayVersion.annotations["workers/message"] =
    `form-authority:takoserver-integration-form-authority-operator-worker:${PREVIOUS_COMMIT}:${PREVIOUS_DIGEST}`;
  for (const binding of historicalGatewayVersion.resources.bindings) {
    if (binding.name === "TAKOSERVER_PUBLIC_WORKER_VERSION_ID") {
      binding.text = ARBITRARY_PUBLIC_WORKER_VERSION_ID;
    }
    if (binding.name === "TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST") {
      binding.text = PREVIOUS_PUBLIC_WORKER_DIGEST;
    }
  }
  const historicalGatewayVersionId = "88888888-8888-4888-8888-888888888888";
  const dynamicGatewayVersionId = "99999999-9999-4999-8999-999999999999";
  return {
    async workerScripts() {
      return [authorityWorkerName, gatewayWorkerName];
    },
    async workerDeployments(workerName) {
      if (workerName === currentTarget.workerName) {
        return [deployment("public-current", PUBLIC_WORKER_VERSION_ID, "2026-08-28T00:00:00Z")];
      }
      if (workerName === authorityWorkerName) {
        return state.routeLessUploaded()
          ? [
              deployment("authority-current", CURRENT_AUTHORITY_VERSION_ID, "2026-08-28T02:00:00Z"),
              deployment(
                "authority-historical",
                PREVIOUS_AUTHORITY_VERSION_ID,
                "2026-08-28T01:00:00Z",
              ),
            ]
          : [
              deployment(
                "authority-historical",
                PREVIOUS_AUTHORITY_VERSION_ID,
                "2026-08-28T01:00:00Z",
              ),
            ];
      }
      return state.gatewayUploaded()
        ? [
            deployment("gateway-current", dynamicGatewayVersionId, "2026-08-28T04:00:00Z"),
            deployment("gateway-historical", historicalGatewayVersionId, "2026-08-28T03:00:00Z"),
          ]
        : [deployment("gateway-historical", historicalGatewayVersionId, "2026-08-28T03:00:00Z")];
    },
    async workerVersion(workerName, versionId) {
      if (workerName === currentTarget.workerName) {
        return versionId === ARBITRARY_PUBLIC_WORKER_VERSION_ID
          ? historicalPublicVersion(
              `takoserver-worker:${PREVIOUS_COMMIT}:${PREVIOUS_PUBLIC_WORKER_DIGEST.slice("sha256:".length)}`,
              historicalTarget,
            )
          : publicVersion(
              `takoserver-worker:${PUBLIC_WORKER_COMMIT}:${PUBLIC_WORKER_DIGEST.slice("sha256:".length)}`,
              currentTarget,
            );
      }
      if (workerName === authorityWorkerName) {
        return versionId === CURRENT_AUTHORITY_VERSION_ID
          ? dynamicVersion(COMMIT, BUNDLE_DIGEST)
          : version(
              PREVIOUS_COMMIT,
              PREVIOUS_DIGEST,
              ARBITRARY_PUBLIC_WORKER_VERSION_ID,
              PREVIOUS_PUBLIC_WORKER_DIGEST,
            );
      }
      return versionId === dynamicGatewayVersionId ? gatewayVersion() : historicalGatewayVersion;
    },
    async workerSecrets(workerName) {
      return workerName === currentTarget.workerName
        ? expectedWorkerSecrets(currentTarget).map((name) => ({ name, type: "secret_text" }))
        : [];
    },
    async workerDomains() {
      return [
        { hostname: "api.integration.example.test", service: currentTarget.workerName },
        {
          hostname: "form-authority.integration.takoserver.com",
          service: gatewayWorkerName,
        },
      ];
    },
    async workerSubdomain() {
      return { enabled: false, previewsEnabled: false };
    },
    async workerRoutes() {
      return [];
    },
  };
}

function mutateHistoricalBinding(
  bindingName: string,
  field: string,
  value: unknown,
): (version: HistoricalPublicVersion) => void {
  return (version) => {
    const binding = version.resources.bindings.find((entry) => entry.name === bindingName);
    if (!binding) throw new Error(`missing historical fixture binding: ${bindingName}`);
    (binding as Record<string, unknown>)[field] = value;
  };
}

function removeHistoricalBinding(bindingName: string): (version: HistoricalPublicVersion) => void {
  return (version) => {
    version.resources.bindings = version.resources.bindings.filter(
      ({ name }) => name !== bindingName,
    );
  };
}

function gatewayVersion(
  scope: { readonly tenantId: string; readonly space: string } = target.formAuthority
    .integrationOperatorScope,
  legacyPins = false,
) {
  return {
    annotations: {
      "workers/message": `form-authority:takoserver-integration-form-authority-operator-worker:${COMMIT}:${BUNDLE_DIGEST}`,
    },
    resources: {
      bindings: [
        {
          type: "service",
          name: "FORM_AUTHORITY",
          service: target.formAuthority.integrationWorkerName,
          entrypoint: "IntegrationFormAuthorityEntrypoint",
        },
        {
          type: "service",
          name: "PUBLIC_HOST_IDENTITY",
          service: target.workerName,
          entrypoint: "PublicHostIdentityEntrypoint",
        },
        { type: "plain_text", name: "TAKOSERVER_ENVIRONMENT", text: "integration" },
        {
          type: "plain_text",
          name: "TAKOSERVER_FORM_AUTHORITY_HOST_ID",
          text: target.formAuthority.hostId,
        },
        {
          type: "plain_text",
          name: "TAKOSERVER_FORM_AUTHORITY_OPERATOR_ORIGIN",
          text: OPERATOR_ORIGIN,
        },
        ...(legacyPins
          ? [
              {
                type: "plain_text",
                name: "TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST",
                text: PUBLIC_WORKER_DIGEST,
              },
              {
                type: "plain_text",
                name: "TAKOSERVER_PUBLIC_WORKER_VERSION_ID",
                text: PUBLIC_WORKER_VERSION_ID,
              },
            ]
          : []),
        {
          type: "plain_text",
          name: "TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK",
          text: canonicalJson(OPERATOR_PUBLIC_JWK),
        },
        {
          type: "plain_text",
          name: "TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID",
          text: scope.tenantId,
        },
        {
          type: "plain_text",
          name: "TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE",
          text: scope.space,
        },
      ],
    },
  };
}

function gatewayState(): FormAuthorityDeployState {
  return {
    async workerScripts() {
      return [
        target.formAuthority.integrationWorkerName,
        target.formAuthority.integrationOperatorWorkerName,
      ];
    },
    async workerDeployments(workerName) {
      if (workerName === target.workerName) {
        return [deployment("public-deployment", PUBLIC_WORKER_VERSION_ID, "2026-08-28T00:00:00Z")];
      }
      if (workerName === target.formAuthority.integrationWorkerName) {
        return [deployment("authority-deployment", "authority-version", "2026-08-28T01:00:00Z")];
      }
      return [deployment("gateway-deployment", "gateway-version", "2026-08-28T02:00:00Z")];
    },
    async workerVersion(workerName) {
      if (workerName === target.workerName) {
        return publicVersion(
          `takoserver-worker:${PUBLIC_WORKER_COMMIT}:${PUBLIC_WORKER_DIGEST.slice("sha256:".length)}`,
        );
      }
      if (workerName === target.formAuthority.integrationWorkerName) {
        return dynamicVersion(COMMIT, BUNDLE_DIGEST);
      }
      return gatewayVersion();
    },
    async workerSecrets(workerName) {
      return workerName === target.workerName
        ? expectedWorkerSecrets(target).map((name) => ({ name, type: "secret_text" }))
        : [];
    },
    async workerDomains() {
      return [
        { hostname: "api.integration.example.test", service: target.workerName },
        {
          hostname: "form-authority.integration.takoserver.com",
          service: target.formAuthority.integrationOperatorWorkerName,
        },
      ];
    },
    async workerSubdomain() {
      return { enabled: false, previewsEnabled: false };
    },
    async workerRoutes() {
      return [];
    },
  };
}

function gatewayBootstrapState(isUploaded: () => boolean): FormAuthorityDeployState {
  const current = gatewayState();
  return {
    ...current,
    async workerScripts() {
      return isUploaded()
        ? [
            target.formAuthority.integrationWorkerName,
            target.formAuthority.integrationOperatorWorkerName,
          ]
        : [target.formAuthority.integrationWorkerName];
    },
    async workerDomains() {
      return [
        { hostname: "api.integration.example.test", service: target.workerName },
        ...(isUploaded()
          ? [
              {
                hostname: "form-authority.integration.takoserver.com",
                service: target.formAuthority.integrationOperatorWorkerName,
              },
            ]
          : []),
      ];
    },
  };
}

function gatewayPartialTopologyState(input: {
  readonly scriptPresent: boolean;
  readonly domainService?: string;
}): FormAuthorityDeployState {
  const current = gatewayState();
  return {
    ...current,
    async workerScripts() {
      return [
        target.formAuthority.integrationWorkerName,
        ...(input.scriptPresent ? [target.formAuthority.integrationOperatorWorkerName] : []),
      ];
    },
    async workerDomains() {
      return [
        { hostname: "api.integration.example.test", service: target.workerName },
        ...(input.domainService
          ? [
              {
                hostname: "form-authority.integration.takoserver.com",
                service: input.domainService,
              },
            ]
          : []),
      ];
    },
  };
}

function routeLessTransitionState(input: {
  readonly beforeScope: { readonly tenantId: string; readonly space: string };
  readonly afterScope?: { readonly tenantId: string; readonly space: string };
  readonly publicProfile?: "current" | "predecessor";
  readonly absent?: boolean;
  readonly isUploaded?: () => boolean;
}): FormAuthorityDeployState {
  const isUploaded = input.isUploaded ?? (() => false);
  const current = stateSequence({ isUploaded });
  return {
    ...current,
    async workerScripts() {
      return input.absent ? [] : [target.formAuthority.integrationWorkerName];
    },
    async workerVersion(workerName, versionId) {
      if (workerName !== target.formAuthority.integrationWorkerName) {
        return await current.workerVersion(workerName, versionId);
      }
      const uploaded = isUploaded();
      const scope = uploaded
        ? (input.afterScope ?? target.formAuthority.integrationOperatorScope)
        : input.beforeScope;
      const publicVersionId =
        input.publicProfile === "predecessor"
          ? PREVIOUS_PUBLIC_WORKER_VERSION_ID
          : PUBLIC_WORKER_VERSION_ID;
      const publicDigest =
        input.publicProfile === "predecessor"
          ? PREVIOUS_PUBLIC_WORKER_DIGEST
          : PUBLIC_WORKER_DIGEST;
      return uploaded
        ? dynamicVersion(COMMIT, BUNDLE_DIGEST, scope)
        : version(COMMIT, PREVIOUS_DIGEST, publicVersionId, publicDigest, scope);
    },
  };
}

function gatewayTransitionState(input: {
  readonly authorityScope: { readonly tenantId: string; readonly space: string };
  readonly gatewayBeforeScope: { readonly tenantId: string; readonly space: string };
  readonly gatewayAfterScope?: { readonly tenantId: string; readonly space: string };
  readonly isUploaded?: () => boolean;
}): FormAuthorityDeployState {
  const isUploaded = input.isUploaded ?? (() => false);
  const current = gatewayState();
  return {
    ...current,
    async workerDeployments(workerName) {
      if (workerName === target.workerName) {
        return [deployment("public-deployment", PUBLIC_WORKER_VERSION_ID, "2026-08-28T00:00:00Z")];
      }
      if (workerName === target.formAuthority.integrationWorkerName) {
        return [
          deployment(
            "authority-deployment",
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "2026-08-28T01:00:00Z",
          ),
        ];
      }
      return isUploaded()
        ? [
            deployment(
              "gateway-current",
              "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              "2026-08-28T03:00:00Z",
            ),
            deployment(
              "gateway-predecessor",
              "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              "2026-08-28T02:00:00Z",
            ),
          ]
        : [
            deployment(
              "gateway-predecessor",
              "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              "2026-08-28T02:00:00Z",
            ),
          ];
    },
    async workerVersion(workerName) {
      if (workerName === target.workerName) {
        return publicVersion(
          `takoserver-worker:${PUBLIC_WORKER_COMMIT}:${PUBLIC_WORKER_DIGEST.slice("sha256:".length)}`,
        );
      }
      if (workerName === target.formAuthority.integrationWorkerName) {
        return dynamicVersion(COMMIT, BUNDLE_DIGEST, input.authorityScope);
      }
      return gatewayVersion(
        isUploaded()
          ? (input.gatewayAfterScope ?? target.formAuthority.integrationOperatorScope)
          : input.gatewayBeforeScope,
        !isUploaded(),
      );
    },
  };
}

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" };
}

describe("route-less Form authority deploy surfaces", () => {
  test("writes one route-less released-Core Container with exact build identity", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-form-authority-core-config-"));
    try {
      const path = writeFormAuthorityConfig({
        path: join(root, "wrangler.jsonc"),
        main: "worker.js",
        invocation: {
          surface: "takoserver-form-authority-worker",
          action: "apply",
          environment: "production",
          commit: COMMIT,
        },
        target,
        selected: {
          kind: "authority",
          workerName: target.formAuthority.workerName,
          hostId: target.formAuthority.hostId,
          main: "src/entry-form-authority-worker.ts",
          policyAuthority: "takoserver-host",
          verificationMode: "released-core",
          verificationAvailable: true,
          productionEligible: false,
        },
        capabilityManifestJson: CAPABILITY_MANIFEST_JSON,
      });
      const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const artifactDigest = takoformCoreVerifierArtifactDigest();
      expect(config).toMatchObject({
        workers_dev: false,
        preview_urls: false,
        version_metadata: { binding: "WORKER_VERSION" },
        vars: {
          TAKOSERVER_TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST: artifactDigest,
        },
        durable_objects: {
          bindings: [{ name: "CORE_VERIFIER", class_name: "TakoformCoreVerifierContainer" }],
        },
        migrations: [
          {
            tag: "takoform-core-verifier-v1",
            new_sqlite_classes: ["TakoformCoreVerifierContainer"],
          },
        ],
        containers: [
          {
            class_name: "TakoformCoreVerifierContainer",
            image_vars: { TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST: artifactDigest },
            max_instances: 1,
            instance_type: "lite",
          },
        ],
      });
      expect(config).not.toHaveProperty("routes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes exact D1/R2/identity bindings and no public route", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-form-authority-config-"));
    try {
      const path = writeFormAuthorityConfig({
        path: join(root, "wrangler.jsonc"),
        main: "worker.js",
        invocation: {
          surface: "takoserver-integration-form-authority-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        selected: {
          kind: "authority",
          workerName: target.formAuthority.integrationWorkerName,
          hostId: target.formAuthority.hostId,
          main: "src/entry-integration-form-authority-worker.ts",
          operatorPublicJwk: OPERATOR_PUBLIC_JWK,
          operatorScope: target.formAuthority.integrationOperatorScope,
          policyAuthority: "takoserver-host",
          verificationMode: "integration-fixture",
          verificationAvailable: true,
          productionEligible: false,
        },
        capabilityManifestJson: CAPABILITY_MANIFEST_JSON,
      });
      const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(config).toMatchObject({
        name: target.formAuthority.integrationWorkerName,
        workers_dev: false,
        preview_urls: false,
        vars: {
          TAKOSERVER_ENVIRONMENT: "integration",
          TAKOSERVER_FORM_AUTHORITY_HOST_ID: target.formAuthority.hostId,
          TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST: CAPABILITY_MANIFEST_JSON,
          TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: canonicalJson(OPERATOR_PUBLIC_JWK),
          TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID:
            target.formAuthority.integrationOperatorScope.tenantId,
          TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE:
            target.formAuthority.integrationOperatorScope.space,
        },
      });
      const vars = config.vars as Record<string, unknown>;
      expect(vars.TAKOSERVER_PUBLIC_WORKER_VERSION_ID).toBeUndefined();
      expect(vars.TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST).toBeUndefined();
      expect(config).not.toHaveProperty("route");
      expect(config).not.toHaveProperty("routes");
      expect(config).not.toHaveProperty("triggers");
      expect(config).toHaveProperty("services", [
        {
          binding: "PUBLIC_HOST_IDENTITY",
          service: target.workerName,
          entrypoint: "PublicHostIdentityEntrypoint",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses the integration fixture before credentials or state outside integration", async () => {
    let stateRead = false;
    const failure = await runFormAuthority(
      {
        surface: "takoserver-integration-form-authority-worker",
        action: "status",
        environment: "production",
        commit: COMMIT,
      },
      { ...target, environment: "production" },
      {
        state: {
          async workerScripts() {
            stateRead = true;
            return [];
          },
        } as unknown as FormAuthorityDeployState,
      },
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("integration-only");
    expect(stateRead).toBe(false);
  });

  test("reports an exact legacy public pin as a one-time migration profile", async () => {
    const status = await runFormAuthority(
      {
        surface: "takoserver-integration-form-authority-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      target,
      { state: stateSequence({ isUploaded: () => false }) },
    );
    expect(status).toMatchObject({
      deployedCommit: PREVIOUS_COMMIT,
      commitMatches: false,
      publicWorkerCommitMatches: true,
      publicWorkerBindingProfile: "legacy-exact-pinned",
      boundPublicWorkerVersionId: PREVIOUS_PUBLIC_WORKER_VERSION_ID,
      boundPublicWorkerArtifactDigest: PREVIOUS_PUBLIC_WORKER_DIGEST,
      ready: false,
    });
  });

  test("accepts an exact legacy pin without assuming it is the direct public predecessor", async () => {
    for (const [boundVersionId, state] of [
      [
        ARBITRARY_PUBLIC_WORKER_VERSION_ID,
        invalidPredecessorState({
          boundVersionId: ARBITRARY_PUBLIC_WORKER_VERSION_ID,
          boundArtifactDigest: PUBLIC_WORKER_DIGEST,
          authorityCommit: COMMIT,
        }),
      ],
      [
        TWO_HOP_PUBLIC_WORKER_VERSION_ID,
        invalidPredecessorState({
          boundVersionId: TWO_HOP_PUBLIC_WORKER_VERSION_ID,
          boundArtifactDigest: PUBLIC_WORKER_DIGEST,
          authorityCommit: COMMIT,
          twoHop: true,
        }),
      ],
    ] as const) {
      const status = await runFormAuthority(
        {
          surface: "takoserver-integration-form-authority-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        { state },
      );
      expect(status).toMatchObject({
        publicWorkerBindingProfile: "legacy-exact-pinned",
        boundPublicWorkerVersionId: boundVersionId,
        boundPublicWorkerArtifactDigest: PUBLIC_WORKER_DIGEST,
        ready: false,
      });
    }
  });

  test("accepts the exact legacy public closure from before capability injection", async () => {
    const migrationTarget = {
      ...target,
      integrationE2eCredentialAuthority: {
        organizationId: "org_takosumi_hosted_staging",
        publicJwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: "E".repeat(43) },
      },
    } satisfies DeployTarget;
    const base = invalidPredecessorState({
      boundVersionId: ARBITRARY_PUBLIC_WORKER_VERSION_ID,
      boundArtifactDigest: PUBLIC_WORKER_DIGEST,
      authorityCommit: COMMIT,
    });
    const state: FormAuthorityDeployState = {
      ...base,
      async workerVersion(workerName, versionId) {
        if (workerName === target.workerName) {
          const commit =
            versionId === ARBITRARY_PUBLIC_WORKER_VERSION_ID ? COMMIT : PUBLIC_WORKER_COMMIT;
          const legacy = publicVersion(
            `takoserver-worker:${commit}:${PUBLIC_WORKER_DIGEST.slice("sha256:".length)}`,
            migrationTarget,
          );
          return versionId === ARBITRARY_PUBLIC_WORKER_VERSION_ID
            ? {
                ...legacy,
                resources: {
                  ...legacy.resources,
                  bindings: legacy.resources.bindings.filter(
                    ({ name }) => name !== "TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST",
                  ),
                },
              }
            : legacy;
        }
        return await base.workerVersion(workerName, versionId);
      },
    };

    const status = await runFormAuthority(
      {
        surface: "takoserver-integration-form-authority-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      migrationTarget,
      { state },
    );
    expect(status).toMatchObject({
      publicWorkerBindingProfile: "legacy-exact-pinned",
      boundPublicWorkerVersionId: ARBITRARY_PUBLIC_WORKER_VERSION_ID,
      boundPublicWorkerArtifactDigest: PUBLIC_WORKER_DIGEST,
      ready: false,
    });
  });

  test("accepts the pinned pre-JIT and pre-sponsorship public closure after target evolution", async () => {
    const currentTarget = evolvedIntegrationTarget();
    const status = await runFormAuthority(
      {
        surface: "takoserver-integration-form-authority-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      currentTarget,
      { state: historicalPinnedPublicState(currentTarget) },
    );

    expect(status).toMatchObject({
      deployedCommit: PREVIOUS_COMMIT,
      publicWorkerCommitMatches: true,
      publicWorkerBindingProfile: "legacy-exact-pinned",
      boundPublicWorkerVersionId: ARBITRARY_PUBLIC_WORKER_VERSION_ID,
      boundPublicWorkerArtifactDigest: PREVIOUS_PUBLIC_WORKER_DIGEST,
      ready: false,
    });
  });

  test("migrates the exact historical public pin to one dynamic successor", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-form-authority-historical-"));
    const currentTarget = evolvedIntegrationTarget();
    let uploaded = false;
    try {
      const process = fakeProcess({
        onUpload() {
          uploaded = true;
        },
      });
      const result = await runFormAuthority(
        {
          surface: "takoserver-integration-form-authority-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        currentTarget,
        {
          run: process.run,
          state: historicalPinnedPublicState(currentTarget, { isUploaded: () => uploaded }),
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          review: "independent-reviewer",
        },
      );

      expect(result).toMatchObject({
        previousVersionId: PREVIOUS_AUTHORITY_VERSION_ID,
        versionId: CURRENT_AUTHORITY_VERSION_ID,
        publicWorkerVersionId: PUBLIC_WORKER_VERSION_ID,
      });
      expect(process.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const [label, binding, field, value] of [
    ["D1 id", "STATE_DB", "id", "99999999-9999-4999-8999-999999999999"],
    ["R2 bucket", "OBJECTS", "bucket_name", "foreign-bucket"],
    ["public origin", "PUBLIC_ORIGIN", "text", "https://foreign.example.test"],
    ["account id", "CLOUDFLARE_ACCOUNT_ID", "text", "f".repeat(32)],
    ["zones", "TAKOSERVER_ZONES", "text", "[]"],
    ["AI models", "TAKOSERVER_AI_MODELS", "text", "[]"],
    ["edge supplies", "TAKOSERVER_EDGE_SUPPLIES", "text", "{}"],
    ["Worker endpoint suffix", "TAKOSERVER_WORKER_ENDPOINT_SUFFIX", "text", "foreign.test"],
    ["operator public key", "OPERATOR_IDENTITY_PUBLIC_JWK", "text", "{}"],
  ] as const) {
    test(`rejects a historical public closure with mutated ${label}`, async () => {
      const currentTarget = evolvedIntegrationTarget();
      await expect(
        runFormAuthority(
          {
            surface: "takoserver-integration-form-authority-worker",
            action: "status",
            environment: "integration",
            commit: COMMIT,
          },
          currentTarget,
          {
            state: historicalPinnedPublicState(currentTarget, {
              mutateHistoricalVersion: mutateHistoricalBinding(binding, field, value),
            }),
          },
        ),
      ).rejects.toThrow(/legacy Form authority pin does not name an exact public Worker closure/u);
    });
  }

  for (const [label, mutateHistoricalVersion] of [
    [
      "unexpected JIT binding",
      (version: HistoricalPublicVersion) =>
        version.resources.bindings.push({
          name: "TAKOSERVER_SOURCE_COMMIT",
          type: "plain_text",
          text: PREVIOUS_COMMIT,
        }),
    ],
    [
      "unexpected outer artifact binding",
      (version: HistoricalPublicVersion) =>
        version.resources.bindings.push({
          name: "TAKOSERVER_WORKER_ARTIFACT_DIGEST",
          type: "plain_text",
          text: PREVIOUS_PUBLIC_WORKER_DIGEST,
        }),
    ],
    [
      "unexpected sponsorship secret",
      (version: HistoricalPublicVersion) =>
        version.resources.bindings.push({
          name: "TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN",
          type: "secret_text",
        }),
    ],
    ["missing provider secret", removeHistoricalBinding("CLOUDFLARE_API_TOKEN")],
    ["missing signing secret", removeHistoricalBinding("TAKOSERVER_SIGNING_KEY")],
    ["missing Worker Version metadata", removeHistoricalBinding("WORKER_VERSION")],
    ["missing historical signing key id", removeHistoricalBinding("TAKOSERVER_SIGNING_KEY_ID")],
    [
      "malformed historical signing key id",
      mutateHistoricalBinding("TAKOSERVER_SIGNING_KEY_ID", "text", "bad key id"),
    ],
    [
      "non-canonical annotation",
      (version: HistoricalPublicVersion) => {
        version.annotations["workers/message"] = "foreign";
      },
    ],
    [
      "wrong triggered-by annotation",
      (version: HistoricalPublicVersion) => {
        version.annotations["workers/triggered_by"] = "secret";
      },
    ],
    [
      "extra annotation",
      (version: HistoricalPublicVersion) => {
        version.annotations["workers/extra"] = "foreign";
      },
    ],
  ] as const) {
    test(`rejects a historical public closure with ${label}`, async () => {
      const currentTarget = evolvedIntegrationTarget();
      await expect(
        runFormAuthority(
          {
            surface: "takoserver-integration-form-authority-worker",
            action: "status",
            environment: "integration",
            commit: COMMIT,
          },
          currentTarget,
          {
            state: historicalPinnedPublicState(currentTarget, { mutateHistoricalVersion }),
          },
        ),
      ).rejects.toBeInstanceOf(Error);
    });
  }

  test("rejects the historical pre-JIT profile combined with a scope transition for status and apply", async () => {
    const currentTarget = evolvedIntegrationTarget();
    for (const action of ["status", "apply"] as const) {
      const process = fakeProcess();
      await expect(
        runFormAuthority(
          {
            surface: "takoserver-integration-form-authority-worker",
            action,
            environment: "integration",
            commit: COMMIT,
            scopeTransition: SCOPE_TRANSITION,
          },
          currentTarget,
          {
            run: process.run,
            state: historicalPinnedPublicState(currentTarget),
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
            review: "independent-reviewer",
          },
        ),
      ).rejects.toThrow(/does not name an exact public Worker closure/u);
      expect(process.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
    }
  });

  test("completes historical migration only after route-less authority then gateway are both dynamic", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-form-authority-historical-sequence-"));
    const currentTarget = evolvedIntegrationTarget();
    let routeLessUploaded = false;
    let gatewayUploaded = false;
    const state = historicalAuthorityMigrationState(currentTarget, {
      routeLessUploaded: () => routeLessUploaded,
      gatewayUploaded: () => gatewayUploaded,
    });
    try {
      const blockedGatewayProcess = fakeProcess();
      await expect(
        runFormAuthority(
          {
            surface: "takoserver-integration-form-authority-operator-worker",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
          },
          currentTarget,
          {
            run: blockedGatewayProcess.run,
            state,
            outputDirectory: join(root, "blocked-gateway"),
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
            review: "independent-reviewer",
          },
        ),
      ).rejects.toThrow(/integration Form authority Worker/u);
      expect(
        blockedGatewayProcess.calls.filter((call) => call.includes("--no-bundle")),
      ).toHaveLength(0);

      const routeLessProcess = fakeProcess({
        onUpload() {
          routeLessUploaded = true;
        },
      });
      await runFormAuthority(
        {
          surface: "takoserver-integration-form-authority-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        currentTarget,
        {
          run: routeLessProcess.run,
          state,
          outputDirectory: join(root, "route-less"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          review: "independent-reviewer",
        },
      );
      expect(routeLessProcess.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);

      const gatewayProcess = fakeProcess({
        onUpload() {
          gatewayUploaded = true;
        },
      });
      await runFormAuthority(
        {
          surface: "takoserver-integration-form-authority-operator-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        currentTarget,
        {
          run: gatewayProcess.run,
          state,
          outputDirectory: join(root, "gateway"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          review: "independent-reviewer",
        },
      );
      expect(gatewayProcess.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);

      const routeLessStatus = await runFormAuthority(
        {
          surface: "takoserver-integration-form-authority-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        currentTarget,
        { state },
      );
      const gatewayStatus = await runFormAuthority(
        {
          surface: "takoserver-integration-form-authority-operator-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        currentTarget,
        { state },
      );
      expect(routeLessStatus).toMatchObject({
        publicWorkerBindingProfile: "dynamic-public-rpc",
        ready: true,
      });
      expect(gatewayStatus).toMatchObject({
        publicWorkerBindingProfile: "dynamic-public-rpc",
        authorityPublicWorkerBindingProfile: "dynamic-public-rpc",
        ready: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const [label, options] of [
    ["artifact pin mismatch", { boundArtifactDigest: `sha256:${"e".repeat(64)}` as const }],
    ["authority commit mismatch", { authorityCommit: COMMIT }],
  ] as const) {
    test(`rejects a historical public closure with ${label}`, async () => {
      const currentTarget = evolvedIntegrationTarget();
      await expect(
        runFormAuthority(
          {
            surface: "takoserver-integration-form-authority-worker",
            action: "status",
            environment: "integration",
            commit: COMMIT,
          },
          currentTarget,
          { state: historicalPinnedPublicState(currentTarget, options) },
        ),
      ).rejects.toBeInstanceOf(Error);
    });
  }

  test("passes an explicit provenance-bound JIT profile for current public Worker inspection", async () => {
    const jitTarget = {
      ...target,
      integrationE2eCredentialAuthority: {
        organizationId: "org_takosumi_hosted_staging",
        publicJwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: "E".repeat(43) },
      },
    } satisfies DeployTarget;
    const status = await runFormAuthority(
      {
        surface: "takoserver-integration-form-authority-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      jitTarget,
      { state: stateSequence(undefined, jitTarget) },
    );
    expect(status).toMatchObject({
      publicWorkerCommit: PUBLIC_WORKER_COMMIT,
      publicWorkerVersionId: PUBLIC_WORKER_VERSION_ID,
      publicWorkerCommitMatches: true,
    });
  });

  test("cannot report ready when the live public identity RPC is unavailable", async () => {
    const status = await runFormAuthorityImpl(
      {
        surface: "takoserver-integration-form-authority-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      target,
      {
        state: stateSequence({ isUploaded: () => true }),
        async fetcher(): Promise<never> {
          throw new Error("probe unavailable");
        },
      },
    );

    expect(status).toMatchObject({
      deployedCommit: COMMIT,
      publicWorkerCommitMatches: true,
      publicIdentityRpcReady: false,
      implementationPayloadDigest: null,
      implementationDigest: null,
      ready: false,
    });
  });

  test("transition status classifies only exact target or exact descriptor predecessor on current public", async () => {
    const predecessor = await runFormAuthority(
      {
        surface: "takoserver-integration-form-authority-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
        scopeTransition: SCOPE_TRANSITION,
      },
      target,
      { state: routeLessTransitionState({ beforeScope: PREDECESSOR_SCOPE }) },
    );
    expect(predecessor).toMatchObject({
      publicWorkerBindingProfile: "legacy-exact-pinned",
      scopeBindingProfile: "exact-transition-predecessor",
      scopeTransitionDigest: SCOPE_TRANSITION.digest,
      ready: false,
    });

    const exactTarget = await runFormAuthority(
      {
        surface: "takoserver-integration-form-authority-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
        scopeTransition: SCOPE_TRANSITION,
      },
      target,
      {
        state: routeLessTransitionState({
          beforeScope: target.formAuthority.integrationOperatorScope,
        }),
      },
    );
    expect(exactTarget).toMatchObject({
      publicWorkerBindingProfile: "legacy-exact-pinned",
      scopeBindingProfile: "exact-target",
      scopeTransitionDigest: SCOPE_TRANSITION.digest,
      ready: false,
    });

    for (const state of [
      routeLessTransitionState({
        beforeScope: { tenantId: "tenant-third", space: "space-third" },
      }),
      routeLessTransitionState({
        beforeScope: PREDECESSOR_SCOPE,
        publicProfile: "predecessor",
      }),
      routeLessTransitionState({ beforeScope: PREDECESSOR_SCOPE, absent: true }),
    ]) {
      await expect(
        runFormAuthority(
          {
            surface: "takoserver-integration-form-authority-worker",
            action: "status",
            environment: "integration",
            commit: COMMIT,
            scopeTransition: SCOPE_TRANSITION,
          },
          target,
          { state },
        ),
      ).rejects.toBeInstanceOf(Error);
    }
  });

  test("transition refusal output never reveals predecessor or foreign scope bindings", async () => {
    const thirdScope = { tenantId: "tenant-third-private", space: "space-third-private" } as const;
    for (const state of [
      routeLessTransitionState({ beforeScope: thirdScope }),
      routeLessTransitionState({
        beforeScope: PREDECESSOR_SCOPE,
        publicProfile: "predecessor",
      }),
    ]) {
      const failure = (await runFormAuthority(
        {
          surface: "takoserver-integration-form-authority-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          scopeTransition: SCOPE_TRANSITION,
        },
        target,
        { state },
      ).catch((error) => error)) as { readonly message: string; readonly detail?: string };
      const stdout = "";
      const stderr = `deploy failed during preflight: ${failure.message}\n${failure.detail ?? ""}\n`;
      expect(stdout).toBe("");
      expect(failure.message).toBe(
        "Form authority scope transition binding is neither exact-target nor exact-transition-predecessor",
      );
      expect(failure.detail).toBeUndefined();
      expect(stderr).not.toContain('{"');
      for (const sensitive of [
        PREDECESSOR_SCOPE.tenantId,
        PREDECESSOR_SCOPE.space,
        target.formAuthority.integrationOperatorScope.tenantId,
        target.formAuthority.integrationOperatorScope.space,
        thirdScope.tenantId,
        thirdScope.space,
      ]) {
        expect(stdout).not.toContain(sensitive);
        expect(stderr).not.toContain(sensitive);
      }
    }
  });

  test("route-less scope transition uploads predecessor to target exactly once and refuses target no-op", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-form-authority-scope-transition-"));
    let uploaded = false;
    try {
      const process = fakeProcess({
        onUpload() {
          uploaded = true;
        },
      });
      const result = await runFormAuthority(
        {
          surface: "takoserver-integration-form-authority-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          scopeTransition: SCOPE_TRANSITION,
        },
        target,
        {
          run: process.run,
          state: routeLessTransitionState({
            beforeScope: PREDECESSOR_SCOPE,
            isUploaded: () => uploaded,
          }),
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          review: "independent-reviewer",
        },
      );
      expect(result).toMatchObject({
        scopeBindingProfile: "exact-target",
        scopeTransitionDigest: SCOPE_TRANSITION.digest,
      });
      expect(process.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);

      await expect(
        runFormAuthority(
          {
            surface: "takoserver-integration-form-authority-worker",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
            scopeTransition: SCOPE_TRANSITION,
          },
          target,
          {
            run: process.run,
            state: routeLessTransitionState({
              beforeScope: target.formAuthority.integrationOperatorScope,
            }),
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
            review: "independent-reviewer",
          },
        ),
      ).rejects.toThrow("already exact-target");
      expect(process.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lost scope-transition acknowledgement settles through status without a duplicate upload", async () => {
    let uploaded = false;
    const process = fakeProcess({
      onUpload() {
        uploaded = true;
      },
      failUpload: true,
    });
    const state = routeLessTransitionState({
      beforeScope: PREDECESSOR_SCOPE,
      isUploaded: () => uploaded,
    });
    const failure = await runFormAuthority(
      {
        surface: "takoserver-integration-form-authority-worker",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
        scopeTransition: SCOPE_TRANSITION,
      },
      target,
      {
        run: process.run,
        state,
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        review: "independent-reviewer",
      },
    ).catch((error) => error);
    expect(failure).toMatchObject({ phase: "mutation" });

    const status = await runFormAuthority(
      {
        surface: "takoserver-integration-form-authority-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
        scopeTransition: SCOPE_TRANSITION,
      },
      target,
      { state },
    );
    expect(status).toMatchObject({ scopeBindingProfile: "exact-target", ready: true });

    await expect(
      runFormAuthority(
        {
          surface: "takoserver-integration-form-authority-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          scopeTransition: SCOPE_TRANSITION,
        },
        target,
        {
          run: process.run,
          state,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          review: "independent-reviewer",
        },
      ),
    ).rejects.toThrow("already exact-target");
    expect(process.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
  });

  test("gateway transition waits for route-less exact-target and then uploads predecessor once", async () => {
    const blockedProcess = fakeProcess();
    await expect(
      runFormAuthority(
        {
          surface: "takoserver-integration-form-authority-operator-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          scopeTransition: SCOPE_TRANSITION,
        },
        target,
        {
          run: blockedProcess.run,
          state: gatewayTransitionState({
            authorityScope: PREDECESSOR_SCOPE,
            gatewayBeforeScope: PREDECESSOR_SCOPE,
          }),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          review: "independent-reviewer",
        },
      ),
    ).rejects.toThrow("route-less");
    expect(blockedProcess.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);

    const root = mkdtempSync(join(tmpdir(), "takoserver-form-authority-gateway-transition-"));
    let uploaded = false;
    try {
      const process = fakeProcess({
        onUpload() {
          uploaded = true;
        },
      });
      const result = await runFormAuthority(
        {
          surface: "takoserver-integration-form-authority-operator-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          scopeTransition: SCOPE_TRANSITION,
        },
        target,
        {
          run: process.run,
          state: gatewayTransitionState({
            authorityScope: target.formAuthority.integrationOperatorScope,
            gatewayBeforeScope: PREDECESSOR_SCOPE,
            isUploaded: () => uploaded,
          }),
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          review: "independent-reviewer",
        },
      );
      expect(result).toMatchObject({
        scopeBindingProfile: "exact-target",
        authorityScopeBindingProfile: "exact-target",
        scopeTransitionDigest: SCOPE_TRANSITION.digest,
      });
      expect(process.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("migrates one exact non-predecessor legacy pin to one dynamic direct successor upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-form-authority-roll-forward-"));
    let uploaded = false;
    try {
      const process = fakeProcess({
        onUpload() {
          uploaded = true;
        },
      });
      const result = await runFormAuthority(
        {
          surface: "takoserver-integration-form-authority-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          run: process.run,
          state: stateSequence({
            isUploaded: () => uploaded,
            legacyBoundVersionId: ARBITRARY_PUBLIC_WORKER_VERSION_ID,
            legacyBoundArtifactDigest: PUBLIC_WORKER_DIGEST,
            legacyCommit: COMMIT,
          }),
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          review: "independent-reviewer",
        },
      );
      expect(result).toMatchObject({
        previousVersionId: PREVIOUS_AUTHORITY_VERSION_ID,
        versionId: CURRENT_AUTHORITY_VERSION_ID,
        authorityArtifactDigest: BUNDLE_DIGEST,
        workerArtifactDigest: PUBLIC_WORKER_DIGEST,
        publicWorkerVersionId: PUBLIC_WORKER_VERSION_ID,
      });
      expect(process.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects mismatched and malformed legacy pin claims before upload", async () => {
    const cases: readonly FormAuthorityDeployState[] = [
      invalidPredecessorState({ boundArtifactDigest: `sha256:${"e".repeat(64)}` }),
      invalidPredecessorState({ authorityCommit: COMMIT }),
      invalidPredecessorState({ boundVersionId: "not-a-worker-version" }),
      invalidPredecessorState({ malformedHistory: true }),
    ];
    for (const state of cases) {
      const process = fakeProcess();
      await expect(
        runFormAuthority(
          {
            surface: "takoserver-integration-form-authority-worker",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
          },
          target,
          {
            run: process.run,
            state,
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
            review: "independent-reviewer",
          },
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(process.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
    }
  });

  test("rejects public predecessor or authority history drift during qualification", async () => {
    for (const kind of ["public-predecessor", "authority-history"] as const) {
      let uploaded = false;
      const process = fakeProcess({
        onUpload() {
          uploaded = true;
        },
      });
      const failure = await runFormAuthority(
        {
          surface: "takoserver-integration-form-authority-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          run: process.run,
          state: qualificationDriftState(kind, () => uploaded),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          review: "independent-reviewer",
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(process.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
    }
  });

  test("seals one bundle, reads exact route-less closure, and uploads once", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-form-authority-deploy-"));
    try {
      const process = fakeProcess();
      const result = await runFormAuthority(
        {
          surface: "takoserver-integration-form-authority-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          run: process.run,
          state: stateSequence(),
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          review: "independent-reviewer",
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.form-authority-worker-apply@v1",
        policyAuthority: "takoserver-host",
        verificationMode: "integration-fixture",
        verificationAvailable: true,
        productionEligible: false,
        authorityArtifactDigest: BUNDLE_DIGEST,
        workerArtifactDigest: PUBLIC_WORKER_DIGEST,
        previousVersionId: PREVIOUS_AUTHORITY_VERSION_ID,
        versionId: CURRENT_AUTHORITY_VERSION_ID,
      });
      // Public source proof is the two-stage payload+outer build; the authority
      // Worker remains a third, independently sealed bundle.
      expect(process.calls.filter((call) => call.includes("--dry-run"))).toHaveLength(3);
      expect(process.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses public subdomain, stale zone route, and public Worker drift", async () => {
    for (const state of [stateSequence({ subdomain: true }), stateSequence({ route: true })]) {
      await expect(
        runFormAuthority(
          {
            surface: "takoserver-integration-form-authority-worker",
            action: "status",
            environment: "integration",
            commit: COMMIT,
          },
          target,
          { state },
        ),
      ).rejects.toThrow(/subdomain|zone route/u);
    }

    const process = fakeProcess();
    await expect(
      runFormAuthority(
        {
          surface: "takoserver-integration-form-authority-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          run: process.run,
          state: stateSequence({ publicDrift: true }),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          review: "independent-reviewer",
        },
      ),
    ).rejects.toThrow("deployment history changed during closure inspection");
    expect(process.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
  });

  test("seals and reads back the exact authenticated operator gateway closure", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-form-authority-gateway-"));
    try {
      const path = writeFormAuthorityConfig({
        path: join(root, "wrangler.jsonc"),
        main: "worker.js",
        invocation: {
          surface: "takoserver-integration-form-authority-operator-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        selected: {
          kind: "operator-gateway",
          workerName: target.formAuthority.integrationOperatorWorkerName,
          hostId: target.formAuthority.hostId,
          main: "src/entry-integration-form-authority-operator-worker.ts",
          operatorOrigin: OPERATOR_ORIGIN,
          authorityWorkerName: target.formAuthority.integrationWorkerName,
          operatorPublicJwk: OPERATOR_PUBLIC_JWK,
          operatorScope: target.formAuthority.integrationOperatorScope,
          policyAuthority: "takoserver-host",
          verificationMode: "integration-fixture",
          verificationAvailable: true,
          productionEligible: false,
        },
        capabilityManifestJson: CAPABILITY_MANIFEST_JSON,
      });
      const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(config).toMatchObject({
        workers_dev: false,
        preview_urls: false,
        routes: [{ pattern: "form-authority.integration.takoserver.com", custom_domain: true }],
        vars: {
          TAKOSERVER_FORM_AUTHORITY_OPERATOR_ORIGIN: OPERATOR_ORIGIN,
          TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: canonicalJson(OPERATOR_PUBLIC_JWK),
          TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID:
            target.formAuthority.integrationOperatorScope.tenantId,
          TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE:
            target.formAuthority.integrationOperatorScope.space,
        },
        services: [
          {
            binding: "FORM_AUTHORITY",
            service: target.formAuthority.integrationWorkerName,
            entrypoint: "IntegrationFormAuthorityEntrypoint",
          },
          {
            binding: "PUBLIC_HOST_IDENTITY",
            service: target.workerName,
            entrypoint: "PublicHostIdentityEntrypoint",
          },
        ],
      });
      const vars = config.vars as Record<string, unknown>;
      expect(vars.TAKOSERVER_PUBLIC_WORKER_VERSION_ID).toBeUndefined();
      expect(vars.TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST).toBeUndefined();
      expect(config).not.toHaveProperty("d1_databases");
      expect(config).not.toHaveProperty("r2_buckets");

      const status = await runFormAuthority(
        {
          surface: "takoserver-integration-form-authority-operator-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        { state: gatewayState() },
      );
      expect(status).toMatchObject({
        routeMode: "authenticated-integration-custom-domain",
        operatorOrigin: OPERATOR_ORIGIN,
        authorityWorkerName: target.formAuthority.integrationWorkerName,
        authorityCommitMatches: true,
        publicWorkerVersionId: PUBLIC_WORKER_VERSION_ID,
        commitMatches: true,
        ready: true,
      });

      let uploaded = false;
      const process = fakeProcess({
        onUpload() {
          uploaded = true;
        },
      });
      const bootstrapped = await runFormAuthority(
        {
          surface: "takoserver-integration-form-authority-operator-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          run: process.run,
          state: gatewayBootstrapState(() => uploaded),
          outputDirectory: join(root, "bootstrap"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          review: "independent-reviewer",
        },
      );
      expect(bootstrapped).toMatchObject({
        kind: "takoserver.form-authority-worker-apply@v1",
        surface: "takoserver-integration-form-authority-operator-worker",
        previousVersionId: null,
        versionId: "gateway-version",
        operatorOrigin: OPERATOR_ORIGIN,
      });
      expect(process.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gateway bootstrap refuses every partial or foreign custom-domain topology", async () => {
    for (const state of [
      gatewayPartialTopologyState({ scriptPresent: true }),
      gatewayPartialTopologyState({
        scriptPresent: false,
        domainService: target.formAuthority.integrationOperatorWorkerName,
      }),
      gatewayPartialTopologyState({ scriptPresent: false, domainService: "foreign-worker" }),
    ]) {
      await expect(
        runFormAuthority(
          {
            surface: "takoserver-integration-form-authority-operator-worker",
            action: "status",
            environment: "integration",
            commit: COMMIT,
          },
          target,
          { state },
        ),
      ).rejects.toThrow(/custom domain|topology|foreign/u);
    }
  });
});

describe("Form authority forward transition and descriptor drift", () => {
  // The exact live predecessor shape: the manifest of the commit before
  // ObjectBucket joined the Host's identity capability kinds.
  const STALE_MANIFEST_JSON = canonicalJson(
    yurucommuLifecycleCapabilityManifest(
      YURUCOMMU_IDENTITY_CAPABILITY_KINDS.filter((kind) => kind !== "ObjectBucket"),
    ),
  );
  const MANIFEST_DELTA = {
    retiredVars: [],
    addedVars: [],
    refreshedVars: ["TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST"],
    addedBindings: [],
    addedSecrets: [],
    rotatedSecrets: [],
  } as const;

  /**
   * The live wedge: the served authority Version carries the manifest of an
   * older commit, and the commit being deployed is the one that changed it.
   */
  function manifestAdvanceState(input: {
    readonly isUploaded?: () => boolean;
    readonly scope?: { readonly tenantId: string; readonly space: string };
  }): FormAuthorityDeployState {
    const isUploaded = input.isUploaded ?? (() => false);
    const current = stateSequence({ isUploaded });
    return {
      ...current,
      async workerVersion(workerName, versionId) {
        if (workerName !== target.formAuthority.integrationWorkerName) {
          return await current.workerVersion(workerName, versionId);
        }
        const scope = input.scope ?? target.formAuthority.integrationOperatorScope;
        if (isUploaded()) return dynamicVersion(COMMIT, BUNDLE_DIGEST, scope);
        const stale = JSON.parse(
          JSON.stringify(dynamicVersion(PREVIOUS_COMMIT, PREVIOUS_DIGEST, scope)),
        ) as { resources: { bindings: { name: string; text?: string }[] } };
        stale.resources.bindings = stale.resources.bindings.map((binding) =>
          binding.name === "TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST"
            ? { ...binding, text: STALE_MANIFEST_JSON }
            : binding,
        );
        return stale;
      },
    };
  }

  test("status names the capability-manifest advance instead of refusing opaquely", async () => {
    const status = await runFormAuthority(
      {
        surface: "takoserver-integration-form-authority-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      target,
      { state: manifestAdvanceState({}) },
    );
    expect(status).toMatchObject({
      publicWorkerBindingProfile: "unclassified",
      scopeBindingProfile: "unclassified",
      bindingTransitionProfile: "none",
      ready: false,
    });
    expect(status.descriptorDrift).toEqual([
      {
        workerName: target.formAuthority.integrationWorkerName,
        versionId: PREVIOUS_AUTHORITY_VERSION_ID,
        differences: [
          {
            binding: "TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST",
            difference: "value",
            field: "text",
            target: expect.stringContaining("sha256:"),
            live: expect.stringContaining("sha256:"),
          },
        ],
      },
    ]);
    // A code-derived value is never adopted from live state.
    expect(status.adoptableFromLive).toEqual([]);
    expect(status.unadoptableFromLive).toEqual([
      {
        worker: target.formAuthority.integrationWorkerName,
        binding: "TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST",
        reason: expect.stringContaining("--refresh-var"),
      },
    ]);
  });

  test("admits the manifest advance only through the declaration", async () => {
    const admitted = await runFormAuthority(
      {
        surface: "takoserver-integration-form-authority-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
        transition: {
          predecessorVersionId: PREVIOUS_AUTHORITY_VERSION_ID,
          delta: { ...MANIFEST_DELTA },
        },
      },
      target,
      { state: manifestAdvanceState({}) },
    );
    expect(admitted).toMatchObject({
      publicWorkerBindingProfile: "dynamic-public-rpc",
      scopeBindingProfile: "exact-target",
      bindingTransitionProfile: "declared-delta-predecessor",
      transitionPredecessorVersionId: PREVIOUS_AUTHORITY_VERSION_ID,
      ready: true,
    });

    // Naming a different binding leaves the manifest unaccounted for.
    const misdeclared = await runFormAuthority(
      {
        surface: "takoserver-integration-form-authority-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
        transition: {
          predecessorVersionId: PREVIOUS_AUTHORITY_VERSION_ID,
          delta: { ...MANIFEST_DELTA, refreshedVars: ["TAKOSERVER_FORM_AUTHORITY_HOST_ID"] },
        },
      },
      target,
      { state: manifestAdvanceState({}) },
    );
    expect(misdeclared).toMatchObject({ bindingTransitionProfile: "none", ready: false });
  });

  test("publishes the manifest advance once and refuses the same apply without the declaration", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-form-authority-manifest-"));
    let uploaded = false;
    try {
      const process = fakeProcess({
        onUpload() {
          uploaded = true;
        },
      });
      const result = await runFormAuthority(
        {
          surface: "takoserver-integration-form-authority-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
          transition: {
            predecessorVersionId: PREVIOUS_AUTHORITY_VERSION_ID,
            delta: { ...MANIFEST_DELTA },
          },
        },
        target,
        {
          run: process.run,
          state: manifestAdvanceState({ isUploaded: () => uploaded }),
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          review: "independent-reviewer",
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.form-authority-worker-apply@v1",
        bindingTransitionProfile: "none",
        transitionPredecessorVersionId: PREVIOUS_AUTHORITY_VERSION_ID,
        previousVersionId: PREVIOUS_AUTHORITY_VERSION_ID,
        versionId: CURRENT_AUTHORITY_VERSION_ID,
      });
      expect(process.calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);

      // The same advance without the declaration touches nothing.
      const undeclared = fakeProcess();
      const refusal = await runFormAuthority(
        {
          surface: "takoserver-integration-form-authority-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          run: undeclared.run,
          state: manifestAdvanceState({}),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          review: "independent-reviewer",
        },
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toContain("declared forward transition");
      expect(undeclared.calls.some((call) => call.includes("--no-bundle"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports a drifted operator Space and writes a candidate descriptor for it", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-form-authority-adopt-"));
    const outside = mkdtempSync(join(tmpdir(), "takoserver-adopt-candidate-"));
    try {
      // The descriptor on disk is a real one: the candidate must still load as
      // a deploy target, so the fixture cannot take the cast-shaped shortcut.
      const descriptor = {
        ...target,
        edgeSupplies: edgeSuppliesFixture(),
        objectBucketSupplies: objectBucketSuppliesFixture(),
      } satisfies DeployTarget;
      const descriptorPath = join(root, "integration.json");
      const descriptorBytes = `${JSON.stringify(descriptor, null, 2)}\n`;
      writeFileSync(descriptorPath, descriptorBytes, { mode: 0o600 });
      const liveScope = {
        tenantId: target.formAuthority.integrationOperatorScope.tenantId,
        space: "space-yurucommu-adopted",
      } as const;
      const candidatePath = join(outside, "integration.candidate.json");
      const status = await runFormAuthority(
        {
          surface: "takoserver-integration-form-authority-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          adoptLivePath: candidatePath,
        },
        target,
        {
          state: manifestAdvanceState({ scope: liveScope }),
          targetDescriptorPath: descriptorPath,
        },
      );
      expect(status.adoptableFromLive).toEqual([
        {
          worker: target.formAuthority.integrationWorkerName,
          binding: "TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE",
          field: "text",
          pointer: "/formAuthority/integrationOperatorScope/space",
          target: target.formAuthority.integrationOperatorScope.space,
          live: liveScope.space,
        },
      ]);
      expect(status.adoptedTargetCandidate).toBe(candidatePath);
      expect(status.adoptedTargetCandidatePatch).toEqual([
        { pointer: "/formAuthority/integrationOperatorScope/space", value: liveScope.space },
      ]);
      // The operator's own descriptor is never edited.
      expect(readFileSync(descriptorPath, "utf8")).toBe(descriptorBytes);
      const candidate = JSON.parse(readFileSync(candidatePath, "utf8")) as typeof target;
      expect(candidate.formAuthority.integrationOperatorScope.space).toBe(liveScope.space);
      expect(candidate.formAuthority.integrationOperatorScope.tenantId).toBe(
        target.formAuthority.integrationOperatorScope.tenantId,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

/**
 * Starting the released-Core lane at all.
 *
 * `takoserver-form-authority-worker`'s apply post-condition reads
 * `GET <identityProbeOrigin>/v1/core-verifier-identity`, which the probe serves
 * only through its `FORM_AUTHORITY` service binding — and the probe refuses to
 * publish a binding to a script that does not exist. So the released-Core
 * authority could not be deployed for the first time in any environment: its
 * verification needed a bridge only its own existence makes possible, and a
 * first Version has no predecessor to roll back to.
 */
describe("released-Core Form authority bootstrap", () => {
  const CORE_VERIFIER_PATH = "/v1/core-verifier-identity";
  const IDENTITY_PROBE_PREDECESSOR_VERSION_ID = "77777777-7777-4777-8777-777777777777";
  const RELEASED_CORE_VERSION_ID = "88888888-8888-4888-8888-888888888888";
  const RELEASED_CORE_SUCCESSOR_VERSION_ID = "99999999-9999-4999-8999-999999999999";

  function releasedCoreVersion(commit: string, artifactDigest: `sha256:${string}`) {
    return {
      annotations: {
        "workers/message": `form-authority:takoserver-form-authority-worker:${commit}:${artifactDigest}`,
      },
      resources: {
        bindings: [
          { type: "d1", name: "STATE_DB", id: target.d1.databaseId },
          { type: "r2_bucket", name: "OBJECTS", bucket_name: target.r2.bucketName },
          {
            type: "service",
            name: "PUBLIC_HOST_IDENTITY",
            service: target.workerName,
            entrypoint: "PublicHostIdentityEntrypoint",
          },
          { type: "plain_text", name: "TAKOSERVER_ENVIRONMENT", text: "integration" },
          {
            type: "plain_text",
            name: "TAKOSERVER_FORM_AUTHORITY_HOST_ID",
            text: target.formAuthority.hostId,
          },
          {
            type: "plain_text",
            name: "TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST",
            text: CAPABILITY_MANIFEST_JSON,
          },
          { type: "version_metadata", name: "WORKER_VERSION" },
          {
            type: "durable_object_namespace",
            name: "CORE_VERIFIER",
            class_name: "TakoformCoreVerifierContainer",
          },
          {
            type: "plain_text",
            name: "TAKOSERVER_TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST",
            text: takoformCoreVerifierArtifactDigest(),
          },
        ],
      },
    };
  }

  /** The account before the first upload, and after it once `uploaded` flips. */
  function releasedCoreState(input: {
    readonly present: boolean;
    readonly isUploaded?: () => boolean;
  }): FormAuthorityDeployState {
    const live = () => input.present || (input.isUploaded?.() ?? false);
    return {
      async workerScripts() {
        return [
          target.formAuthority.integrationWorkerName,
          target.formAuthority.identityProbeWorkerName,
          ...(live() ? [target.formAuthority.workerName] : []),
        ];
      },
      async workerDeployments(workerName) {
        if (workerName === target.workerName) {
          return [
            deployment("public-deployment", PUBLIC_WORKER_VERSION_ID, "2026-08-28T00:00:00Z"),
          ];
        }
        if (workerName === target.formAuthority.identityProbeWorkerName) {
          return [
            deployment(
              "identity-probe-predecessor",
              IDENTITY_PROBE_PREDECESSOR_VERSION_ID,
              "2026-08-28T01:00:00Z",
            ),
          ];
        }
        if (!live()) return [];
        // A bootstrap upload leaves exactly one Version, with nothing behind
        // it; a steady one leaves a successor whose predecessor is the Version
        // the run read before it.
        if (!input.present) {
          return [deployment("core-first", RELEASED_CORE_VERSION_ID, "2026-08-28T02:00:00Z")];
        }
        return input.isUploaded?.()
          ? [
              deployment(
                "core-successor",
                RELEASED_CORE_SUCCESSOR_VERSION_ID,
                "2026-08-28T03:00:00Z",
              ),
              deployment("core-current", RELEASED_CORE_VERSION_ID, "2026-08-28T02:00:00Z"),
            ]
          : [deployment("core-current", RELEASED_CORE_VERSION_ID, "2026-08-28T02:00:00Z")];
      },
      async workerVersion(workerName) {
        if (workerName === target.workerName) {
          return publicVersion(
            `takoserver-worker:${PUBLIC_WORKER_COMMIT}:${PUBLIC_WORKER_DIGEST.slice("sha256:".length)}`,
          );
        }
        if (workerName === target.formAuthority.identityProbeWorkerName) {
          return {
            annotations: {
              "workers/message": `form-authority-identity-probe:${COMMIT}:${BUNDLE_DIGEST}`,
            },
            resources: {
              bindings: [
                {
                  type: "plain_text",
                  name: "TAKOSERVER_FORM_AUTHORITY_HOST_ID",
                  text: target.formAuthority.hostId,
                },
                {
                  type: "service",
                  name: "PUBLIC_HOST_IDENTITY",
                  service: target.workerName,
                  entrypoint: "PublicHostIdentityEntrypoint",
                },
              ],
            },
          };
        }
        return releasedCoreVersion(COMMIT, BUNDLE_DIGEST);
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
  }

  /** The probe's two routes, told apart, so a run that must not read one cannot. */
  function releasedCoreFetcher(
    input: {
      readonly coreVerifier?: "ready" | "absent";
      readonly authorityWorkerVersionId?: string;
    } = {},
  ) {
    const paths: string[] = [];
    const fetcher = async (url: string): Promise<Response> => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === CORE_VERIFIER_PATH) {
        if (input.coreVerifier !== "ready") {
          return Response.json({ error: { code: "not_found" } }, { status: 404 });
        }
        return Response.json({
          kind: "takoserver.form-authority-core-verifier-identity@v1",
          authorityWorkerVersionId: input.authorityWorkerVersionId ?? RELEASED_CORE_VERSION_ID,
          verifier: {
            protocol: "takoserver.takoform-core-verifier@v1",
            coreVersion: "v1.1.0",
            coreCommit: "e0e48b864de2a127a255cb0574d37bbb0f1cac29",
            artifactDigest: takoformCoreVerifierArtifactDigest(),
          },
        });
      }
      const implementationPayloadDigest = `sha256:${"9".repeat(64)}` as const;
      const semantic = await derivePublicFormImplementationIdentity({
        implementationPayloadDigest,
        capabilities: publicFormCapabilityManifest(),
      });
      return Response.json({
        kind: "takoserver.public-host-identity@v2",
        hostId: target.formAuthority.hostId,
        workerVersionId: PUBLIC_WORKER_VERSION_ID,
        workerArtifactDigest: PUBLIC_WORKER_DIGEST,
        ...semantic,
      });
    };
    return { fetcher, paths };
  }

  const invocation = {
    surface: "takoserver-form-authority-worker",
    environment: "integration",
    commit: COMMIT,
  } as const;

  test("publishes the first Version with its readback deferred, and names what finishes the lane", async () => {
    let uploaded = false;
    const process = fakeProcess({
      onUpload: () => {
        uploaded = true;
      },
    });
    const live = releasedCoreFetcher();
    const result = await runFormAuthorityImpl(
      {
        ...invocation,
        action: "apply",
        bootstrapVerifierBridge: true,
        bootstrapProbePredecessorVersionId: IDENTITY_PROBE_PREDECESSOR_VERSION_ID,
      },
      target,
      {
        run: process.run,
        state: releasedCoreState({ present: false, isUploaded: () => uploaded }),
        fetcher: live.fetcher,
        review: "independent-reviewer",
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
      },
    );
    expect(result).toMatchObject({
      kind: "takoserver.form-authority-worker-apply@v1",
      workerName: target.formAuthority.workerName,
      verificationMode: "released-core",
      verifierBridgePending: true,
      bootstrapProbePredecessorVersionId: IDENTITY_PROBE_PREDECESSOR_VERSION_ID,
      bootstrapProbePredecessorCommit: COMMIT,
      bootstrapProbeArtifactDigest: BUNDLE_DIGEST,
      coreVerifierRpcReady: null,
      previousVersionId: null,
      versionId: RELEASED_CORE_VERSION_ID,
    });
    // Deferred, not attempted: the bridge cannot answer, so nothing asks it.
    expect(live.paths).not.toContain(CORE_VERIFIER_PATH);
    expect(String(result.verifierBridgeNextStep)).toContain(
      "takoserver-form-authority-identity-probe --apply",
    );
    expect(String(result.verifierBridgeNextStep)).toContain("--add-binding=FORM_AUTHORITY");
    expect(String(result.verifierBridgeNextStep)).toContain(
      `--closure-predecessor-version=${IDENTITY_PROBE_PREDECESSOR_VERSION_ID}`,
    );
    // A first Version has nothing to roll back to, so the forward repair is the
    // rest of the sequence rather than a rollback that does not exist.
    expect(String(result.rollback)).toContain("forward repair only");
    expect(String(result.rollback)).toContain("takoserver-form-authority-identity-probe --apply");
  });

  test("refuses a first upload that does not name the deferral, before it uploads", async () => {
    let uploaded = false;
    const process = fakeProcess({
      onUpload: () => {
        uploaded = true;
      },
    });
    const refusal = await runFormAuthorityImpl({ ...invocation, action: "apply" }, target, {
      run: process.run,
      state: releasedCoreState({ present: false, isUploaded: () => uploaded }),
      fetcher: releasedCoreFetcher().fetcher,
      review: "independent-reviewer",
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DeployError);
    expect((refusal as DeployError).phase).toBe("preflight");
    expect((refusal as DeployError).message).toContain("does not exist yet");
    expect((refusal as DeployError).detail).toContain("--bootstrap-verifier-bridge");
    expect(uploaded).toBe(false);
  });

  test("requires the bootstrap and exact probe predecessor selectors together", async () => {
    for (const partial of [
      { bootstrapVerifierBridge: true },
      { bootstrapProbePredecessorVersionId: IDENTITY_PROBE_PREDECESSOR_VERSION_ID },
    ] as const) {
      let uploaded = false;
      const refusal = await runFormAuthorityImpl(
        { ...invocation, action: "apply", ...partial },
        target,
        {
          run: fakeProcess({
            onUpload: () => {
              uploaded = true;
            },
          }).run,
          state: releasedCoreState({ present: false, isUploaded: () => uploaded }),
          fetcher: releasedCoreFetcher().fetcher,
          review: "independent-reviewer",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(DeployError);
      expect((refusal as DeployError).phase).toBe("preflight");
      expect((refusal as DeployError).message).toContain("declared together");
      expect(uploaded).toBe(false);
    }
  });

  test("refuses the deferral once the Worker has a Version of its own", async () => {
    let uploaded = false;
    const process = fakeProcess({
      onUpload: () => {
        uploaded = true;
      },
    });
    const refusal = await runFormAuthorityImpl(
      {
        ...invocation,
        action: "apply",
        bootstrapVerifierBridge: true,
        bootstrapProbePredecessorVersionId: IDENTITY_PROBE_PREDECESSOR_VERSION_ID,
      },
      target,
      {
        run: process.run,
        state: releasedCoreState({ present: true, isUploaded: () => uploaded }),
        fetcher: releasedCoreFetcher({ coreVerifier: "ready" }).fetcher,
        review: "independent-reviewer",
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
      },
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DeployError);
    expect((refusal as DeployError).phase).toBe("preflight");
    expect((refusal as DeployError).message).toContain("not a bootstrap");
    expect(uploaded).toBe(false);
  });

  test("still refuses a steady-state upload whose Core verifier is not live", async () => {
    let uploaded = false;
    const process = fakeProcess({
      onUpload: () => {
        uploaded = true;
      },
    });
    const refusal = await runFormAuthorityImpl({ ...invocation, action: "apply" }, target, {
      run: process.run,
      state: releasedCoreState({ present: true, isUploaded: () => uploaded }),
      fetcher: releasedCoreFetcher().fetcher,
      review: "independent-reviewer",
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DeployError);
    expect((refusal as DeployError).phase).toBe("verification");
    expect((refusal as DeployError).message).toContain("released Core verifier live identity");
  });

  test("publishes a steady-state successor only once the bridge proves it live", async () => {
    let uploaded = false;
    const process = fakeProcess({
      onUpload: () => {
        uploaded = true;
      },
    });
    const live = releasedCoreFetcher({
      coreVerifier: "ready",
      authorityWorkerVersionId: RELEASED_CORE_SUCCESSOR_VERSION_ID,
    });
    const result = await runFormAuthorityImpl({ ...invocation, action: "apply" }, target, {
      run: process.run,
      state: releasedCoreState({ present: true, isUploaded: () => uploaded }),
      fetcher: live.fetcher,
      review: "independent-reviewer",
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
    });
    expect(live.paths).toContain(CORE_VERIFIER_PATH);
    expect(result).toMatchObject({
      coreVerifierRpcReady: true,
      coreVerifierAuthorityWorkerVersionId: RELEASED_CORE_SUCCESSOR_VERSION_ID,
      versionId: RELEASED_CORE_SUCCESSOR_VERSION_ID,
      previousVersionId: RELEASED_CORE_VERSION_ID,
    });
    expect(result.verifierBridgePending).toBeUndefined();
    expect(String(result.rollback)).toContain(RELEASED_CORE_VERSION_ID);
  });

  test("reads the bridge and reports it ready once the probe has been bound", async () => {
    const live = releasedCoreFetcher({ coreVerifier: "ready" });
    const status = await runFormAuthorityImpl({ ...invocation, action: "status" }, target, {
      run: fakeProcess().run,
      state: releasedCoreState({ present: true }),
      fetcher: live.fetcher,
    });
    expect(live.paths).toContain(CORE_VERIFIER_PATH);
    expect(status).toMatchObject({
      coreVerifierRpcReady: true,
      coreVerifierAuthorityWorkerVersionId: RELEASED_CORE_VERSION_ID,
      ready: true,
    });
    expect(status.coreVerifierBridgeRemedy).toBeUndefined();
  });

  test("names the run that closes an unready bridge, absent Worker or not", async () => {
    const absent = await runFormAuthorityImpl({ ...invocation, action: "status" }, target, {
      run: fakeProcess().run,
      state: releasedCoreState({ present: false }),
      fetcher: releasedCoreFetcher().fetcher,
    });
    expect(absent).toMatchObject({ versionId: null, coreVerifierRpcReady: false, ready: false });
    expect(String(absent.coreVerifierBridgeRemedy)).toContain("--bootstrap-verifier-bridge");

    const unbound = await runFormAuthorityImpl({ ...invocation, action: "status" }, target, {
      run: fakeProcess().run,
      state: releasedCoreState({ present: true }),
      fetcher: releasedCoreFetcher().fetcher,
    });
    expect(unbound).toMatchObject({ coreVerifierRpcReady: false, ready: false });
    expect(String(unbound.coreVerifierBridgeRemedy)).toContain("--add-binding=FORM_AUTHORITY");
    expect(String(unbound.coreVerifierBridgeRemedy)).not.toContain("--bootstrap-verifier-bridge");
  });
});
