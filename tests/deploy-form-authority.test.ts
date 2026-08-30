import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FormAuthorityDeployState,
  type FormAuthorityProcess,
  runFormAuthority,
  writeFormAuthorityConfig,
} from "../scripts/deploy/form-authority.ts";
import { expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";
import { canonicalJson } from "../src/json.ts";
import {
  YURUCOMMU_IDENTITY_CAPABILITY_KINDS,
  yurucommuLifecycleCapabilityManifest,
} from "../src/takoform/implementation-catalog.ts";

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
const PUBLIC_WORKER_DIGEST = `sha256:${createHash("sha256")
  .update(PUBLIC_BUNDLE)
  .digest("hex")}` as const;
const CAPABILITY_MANIFEST_JSON = canonicalJson(
  yurucommuLifecycleCapabilityManifest(YURUCOMMU_IDENTITY_CAPABILITY_KINDS),
);
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

function stateSequence(input?: {
  readonly publicDrift?: boolean;
  readonly subdomain?: boolean;
  readonly route?: boolean;
  readonly isUploaded?: () => boolean;
}): FormAuthorityDeployState {
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
        );
      }
      const current = versionId === CURRENT_AUTHORITY_VERSION_ID;
      const commit = current ? COMMIT : PREVIOUS_COMMIT;
      const artifactDigest = current ? BUNDLE_DIGEST : PREVIOUS_DIGEST;
      return current
        ? version(commit, artifactDigest)
        : version(
            commit,
            artifactDigest,
            PREVIOUS_PUBLIC_WORKER_VERSION_ID,
            PREVIOUS_PUBLIC_WORKER_DIGEST,
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

function publicVersion(message: string) {
  const expected = expectedExactBindingClosure(target);
  return {
    annotations: { "workers/message": message },
    resources: {
      bindings: Object.entries(expected).flatMap(([name, requirement]) =>
        requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
      ),
    },
  };
}

function gatewayVersion(
  scope: { readonly tenantId: string; readonly space: string } = target.formAuthority
    .integrationOperatorScope,
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
        return version(COMMIT, BUNDLE_DIGEST);
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
      return version(
        COMMIT,
        versionId === CURRENT_AUTHORITY_VERSION_ID ? BUNDLE_DIGEST : PREVIOUS_DIGEST,
        publicVersionId,
        publicDigest,
        scope,
      );
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
        return version(
          COMMIT,
          BUNDLE_DIGEST,
          PUBLIC_WORKER_VERSION_ID,
          PUBLIC_WORKER_DIGEST,
          input.authorityScope,
        );
      }
      return gatewayVersion(
        isUploaded()
          ? (input.gatewayAfterScope ?? target.formAuthority.integrationOperatorScope)
          : input.gatewayBeforeScope,
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
        workerArtifactDigest: PUBLIC_WORKER_DIGEST,
        publicWorkerVersionId: PUBLIC_WORKER_VERSION_ID,
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
          TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST: PUBLIC_WORKER_DIGEST,
          TAKOSERVER_PUBLIC_WORKER_VERSION_ID: PUBLIC_WORKER_VERSION_ID,
          TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST: CAPABILITY_MANIFEST_JSON,
          TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: canonicalJson(OPERATOR_PUBLIC_JWK),
          TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID:
            target.formAuthority.integrationOperatorScope.tenantId,
          TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE:
            target.formAuthority.integrationOperatorScope.space,
        },
      });
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

  test("seals target-owned operation narrowing into the authority capability binding", () => {
    const narrowedTarget: DeployTarget = {
      ...target,
      formAuthority: {
        ...target.formAuthority,
        operatorOperations: { ModuleWorker: ["read"] },
      },
    };
    const manifest = canonicalJson(
      yurucommuLifecycleCapabilityManifest(YURUCOMMU_IDENTITY_CAPABILITY_KINDS, {
        ModuleWorker: ["read"],
      }),
    );
    const root = mkdtempSync(join(tmpdir(), "takoserver-form-authority-narrowing-"));
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
        target: narrowedTarget,
        selected: {
          kind: "authority",
          workerName: narrowedTarget.formAuthority?.integrationWorkerName ?? "missing",
          hostId: narrowedTarget.publicOrigin,
          main: "src/entry-integration-form-authority-worker.ts",
          operatorPublicJwk: OPERATOR_PUBLIC_JWK,
          operatorScope: target.formAuthority.integrationOperatorScope,
          policyAuthority: "takoserver-host",
          verificationMode: "integration-fixture",
          verificationAvailable: true,
          productionEligible: false,
        },
        workerArtifactDigest: PUBLIC_WORKER_DIGEST,
        publicWorkerVersionId: PUBLIC_WORKER_VERSION_ID,
        capabilityManifestJson: manifest,
      });
      const config = JSON.parse(readFileSync(path, "utf8")) as {
        vars: { TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST: string };
      };
      expect(JSON.parse(config.vars.TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST)).toMatchObject({
        forms: { ModuleWorker: ["read"] },
      });
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

  test("reports the exact direct public predecessor as an explicit stale profile", async () => {
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
      publicWorkerBindingProfile: "exact-direct-public-predecessor",
      boundPublicWorkerVersionId: PREVIOUS_PUBLIC_WORKER_VERSION_ID,
      boundPublicWorkerArtifactDigest: PREVIOUS_PUBLIC_WORKER_DIGEST,
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
      publicWorkerBindingProfile: "exact-current-public",
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
      publicWorkerBindingProfile: "exact-current-public",
      scopeBindingProfile: "exact-target",
      scopeTransitionDigest: SCOPE_TRANSITION.digest,
      ready: true,
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

  test("replaces one validated predecessor with one exact-current direct successor upload", async () => {
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
          state: stateSequence({ isUploaded: () => uploaded }),
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

  test("rejects arbitrary, two-hop, mismatched, and malformed predecessor claims before upload", async () => {
    const cases: readonly FormAuthorityDeployState[] = [
      invalidPredecessorState({ boundVersionId: ARBITRARY_PUBLIC_WORKER_VERSION_ID }),
      invalidPredecessorState({
        boundVersionId: TWO_HOP_PUBLIC_WORKER_VERSION_ID,
        twoHop: true,
      }),
      invalidPredecessorState({ boundArtifactDigest: `sha256:${"e".repeat(64)}` }),
      invalidPredecessorState({ authorityCommit: COMMIT }),
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
      expect(process.calls.filter((call) => call.includes("--dry-run"))).toHaveLength(2);
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
    ).rejects.toThrow("public Takoserver Worker changed");
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
        workerArtifactDigest: PUBLIC_WORKER_DIGEST,
        publicWorkerVersionId: PUBLIC_WORKER_VERSION_ID,
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
          TAKOSERVER_PUBLIC_WORKER_VERSION_ID: PUBLIC_WORKER_VERSION_ID,
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
