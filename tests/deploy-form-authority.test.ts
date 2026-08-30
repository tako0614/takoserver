import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FormAuthorityDeployState,
  type FormAuthorityProcess,
  publicFormCapabilityManifest,
  runFormAuthority as runFormAuthorityImpl,
  writeFormAuthorityConfig,
} from "../scripts/deploy/form-authority.ts";
import { expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";
import { canonicalJson } from "../src/json.ts";
import { derivePublicFormImplementationIdentity } from "../src/public-worker-implementation.ts";
import { YURUCOMMU_IDENTITY_CAPABILITY_KINDS } from "../src/takoform/implementation-catalog.ts";

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
    offerings: YURUCOMMU_IDENTITY_CAPABILITY_KINDS.map((formKind) => ({ formKind })),
  } as unknown as NonNullable<DeployTarget["edgeSupplies"]>,
  workerEndpointSuffix: "integration.example.workers.dev",
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
    standardServiceSupplies: {
      kind: "takoserver.standard-service-supplies@v1",
      supplies: [],
    } as unknown as NonNullable<DeployTarget["standardServiceSupplies"]>,
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
    ["standard supplies", "TAKOSERVER_STANDARD_SERVICE_SUPPLIES", "text", "{}"],
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
