import { describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type IntegrationE2eCredentialProcess,
  runIntegrationE2eCredentials,
} from "../scripts/deploy/integration-e2e-credentials.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import type { WorkerState } from "../scripts/deploy/worker-live.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";
import {
  AUTHORITY_CONFIG_ENVIRONMENT_VARIABLE,
  credentialPaths,
  OUTPUT_DIRECTORY_ENVIRONMENT_VARIABLE,
  PRIVATE_JWK_ENVIRONMENT_VARIABLE,
  TARGET_ENVIRONMENT_VARIABLE,
} from "../scripts/integration-e2e-credentials.ts";
import { INTEGRATION_E2E_ORGANIZATION_ID } from "../src/integration-e2e-credential-authority.ts";

const COMMIT = "a".repeat(40);
const BUNDLE_DIGEST = "b".repeat(64);
const VERSION_ID = "00000000-0000-4000-8000-000000000001";
const PUBLIC_JWK = { kty: "OKP" as const, crv: "Ed25519" as const, x: "E".repeat(43) };
const DISTINCT_SIGNING_X = `${"F".repeat(42)}A`;

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
  integrationE2eCredentialAuthority: {
    organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
    publicJwk: PUBLIC_JWK,
  },
} satisfies DeployTarget;

describe("integration E2E credential owner surface", () => {
  test("derives the helper authority only from exact live Worker provenance", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-deploy-jit-credentials-"));
    try {
      const calls: {
        command: readonly string[];
        env: Readonly<Record<string, string>>;
      }[] = [];
      const privatePath = join(root, "private.jwk");
      const outputDirectory = join(root, "credentials");
      const run: IntegrationE2eCredentialProcess = async (command, options) => {
        calls.push({ command: [...command], env: { ...(options?.env ?? {}) } });
        return ok(
          JSON.stringify({
            version: 3,
            kind: "takoserver.integration-e2e-credential-pair@v3",
            origin: target.publicOrigin,
            environment: "integration",
            organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
            operationId: "issue-owner-derived",
            ttlSeconds: 3_600,
            requestedAuthority: {
              sourceCommit: COMMIT,
              artifactDigest: `sha256:${BUNDLE_DIGEST}`,
              publicWorkerVersionId: VERSION_ID,
            },
            roles: {
              writer: {
                role: "writer",
                name: "integration-e2e-writer",
                keyId: "key_ie2e_w_exact",
                scopes: ["resources:write"],
                secretPath: join(outputDirectory, "task-0037-integration-writer.secret"),
              },
              evidence: {
                role: "evidence",
                name: "integration-e2e-evidence",
                keyId: "key_ie2e_e_exact",
                scopes: ["resources:read"],
                secretPath: join(outputDirectory, "task-0037-integration-evidence.secret"),
              },
            },
          }),
        );
      };

      const result = await runIntegrationE2eCredentials(invocation("issue"), target, {
        state: staticState(version()),
        run,
        privateJwkPath: privatePath,
        credentialOutputDirectory: outputDirectory,
        temporaryDirectory: root,
        review: "reviewer@example.test",
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "must-not-cross" },
        signingDatabase: signingDatabase(DISTINCT_SIGNING_X),
      });

      expect(result).toMatchObject({
        kind: "takoserver.integration-e2e-credential-invocation@v1",
        surface: "takoserver-integration-e2e-credentials",
        action: "issue",
        selectedCommit: COMMIT,
        deployedCommit: COMMIT,
        artifactDigest: `sha256:${BUNDLE_DIGEST}`,
        publicWorkerVersionId: VERSION_ID,
        organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
        reviewer: "reviewer@example.test",
        credentialsRedacted: true,
      });
      expect(calls).toHaveLength(1);
      const call = calls[0];
      if (!call) throw new Error("missing helper call");
      expect(call.command).toHaveLength(3);
      expect(call.command[0]).toBe("bun");
      expect(call.command[1]).toEndWith("/scripts/integration-e2e-credentials.ts");
      expect(call.command[2]).toBe("issue");
      expect(call.command.join(" ")).not.toContain(privatePath);
      expect(call.command.join(" ")).not.toContain("must-not-cross");
      expect(call.env).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
      expect(call.env[PRIVATE_JWK_ENVIRONMENT_VARIABLE]).toBe(privatePath);
      expect(call.env[OUTPUT_DIRECTORY_ENVIRONMENT_VARIABLE]).toBe(outputDirectory);

      const authority = JSON.parse(
        call.env[AUTHORITY_CONFIG_ENVIRONMENT_VARIABLE] ?? "null",
      ) as Record<string, unknown>;
      expect(authority).toEqual({
        environment: "integration",
        organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
        publicJwk: PUBLIC_JWK,
        sourceCommit: COMMIT,
        artifactDigest: `sha256:${BUNDLE_DIGEST}`,
        publicWorkerVersionId: VERSION_ID,
      });
      const snapshotPath = call.env[TARGET_ENVIRONMENT_VARIABLE];
      if (!snapshotPath) throw new Error("missing target snapshot");
      expect(lstatSync(snapshotPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(snapshotPath, "utf8"))).toEqual(target);
      expect(JSON.stringify(result)).not.toContain("must-not-cross");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses type-correct helper paths outside the exact credential output custody", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-deploy-jit-custody-"));
    const outputDirectory = join(root, "credentials");
    const paths = credentialPaths(outputDirectory);
    const baseOptions = {
      state: staticState(version()),
      privateJwkPath: join(root, "private.jwk"),
      credentialOutputDirectory: outputDirectory,
      temporaryDirectory: root,
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
      signingDatabase: signingDatabase(DISTINCT_SIGNING_X),
    } as const;
    try {
      const issueFailure = await runIntegrationE2eCredentials(invocation("issue"), target, {
        ...baseOptions,
        review: "reviewer@example.test",
        run: async () =>
          ok(
            JSON.stringify({
              version: 3,
              kind: "takoserver.integration-e2e-credential-pair@v3",
              origin: target.publicOrigin,
              environment: "integration",
              organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
              operationId: "issue-owner-wrong-custody",
              ttlSeconds: 3_600,
              requestedAuthority: {
                sourceCommit: COMMIT,
                artifactDigest: `sha256:${BUNDLE_DIGEST}`,
                publicWorkerVersionId: VERSION_ID,
              },
              roles: {
                writer: {
                  role: "writer",
                  name: "integration-e2e-writer",
                  keyId: "key_ie2e_w_exact",
                  scopes: ["resources:write"],
                  secretPath: join(root, "attacker-selected-writer.secret"),
                },
                evidence: {
                  role: "evidence",
                  name: "integration-e2e-evidence",
                  keyId: "key_ie2e_e_exact",
                  scopes: ["resources:read"],
                  secretPath: paths.evidenceSecret,
                },
              },
            }),
          ),
      }).catch((error) => error);
      expect(issueFailure).toMatchObject({ phase: "mutation" });
      expect(issueFailure.message).toContain("custody");
      unlinkSync(join(root, "deploy-target.json"));

      const statusFailure = await runIntegrationE2eCredentials(invocation("status"), target, {
        ...baseOptions,
        run: async () =>
          ok(
            JSON.stringify({
              kind: "takoserver.integration-e2e-credential-pair-local-status@v3",
              origin: target.publicOrigin,
              organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
              operationId: "",
              remote: null,
              files: {
                writerSecret: {
                  path: paths.writerSecret,
                  exists: false,
                  mode: null,
                  symlink: false,
                },
                evidenceSecret: {
                  path: paths.evidenceSecret,
                  exists: false,
                  mode: null,
                  symlink: false,
                },
                metadata: {
                  path: join(root, "attacker-selected-metadata.json"),
                  exists: false,
                  mode: null,
                  symlink: false,
                },
              },
            }),
          ),
      }).catch((error) => error);
      expect(statusFailure).toMatchObject({ phase: "preflight" });
      expect(statusFailure.message).toContain("custody");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects undeclared child fields instead of accepting value-bearing helper output", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-deploy-jit-exact-output-"));
    const outputDirectory = join(root, "credentials");
    const leaked = "api-key-secret-value-must-not-cross";
    try {
      const failure = await runIntegrationE2eCredentials(invocation("issue"), target, {
        state: staticState(version()),
        run: async () =>
          ok(JSON.stringify({ ...helperIssueResult(outputDirectory), secret: leaked })),
        privateJwkPath: join(root, "private.jwk"),
        credentialOutputDirectory: outputDirectory,
        temporaryDirectory: root,
        review: "reviewer@example.test",
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        signingDatabase: signingDatabase(DISTINCT_SIGNING_X),
      }).catch((error) => error);

      expect(failure).toMatchObject({ phase: "mutation" });
      expect(failure.message).toContain("invalid result");
      expect(JSON.stringify(failure)).not.toContain(leaked);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses selected-source and bound provenance drift before invoking the helper", async () => {
    const calls: readonly string[][] = [];
    const run: IntegrationE2eCredentialProcess = async (command) => {
      (calls as string[][]).push([...command]);
      return ok("{}");
    };
    const selectedFailure = await runIntegrationE2eCredentials(
      { ...invocation("status"), commit: "c".repeat(40) },
      target,
      localOptions(staticState(version()), run),
    ).catch((error) => error);
    expect(selectedFailure).toMatchObject({ phase: "preflight" });
    expect(selectedFailure.message).toContain("exact live Worker commit");

    const drifted = version() as { resources: { bindings: Record<string, unknown>[] } };
    const source = drifted.resources.bindings.find(
      (binding) => binding.name === "TAKOSERVER_SOURCE_COMMIT",
    );
    if (!source) throw new Error("missing source binding");
    source.text = "d".repeat(40);
    const provenanceFailure = await runIntegrationE2eCredentials(
      invocation("status"),
      target,
      localOptions(staticState(drifted), run),
    ).catch((error) => error);
    expect(provenanceFailure).toMatchObject({ phase: "preflight" });
    expect(provenanceFailure.message).toContain("unexpected text");
    expect(calls).toHaveLength(0);
  });

  test("closes live Version races and never retries a failed mutation helper", async () => {
    let helperCalls = 0;
    const run: IntegrationE2eCredentialProcess = async () => {
      helperCalls += 1;
      return { exitCode: 1, stdout: "", stderr: "credential state unknown" };
    };
    const raceFailure = await runIntegrationE2eCredentials(
      invocation("issue"),
      target,
      localOptions(racingState(), run, { review: "reviewer@example.test" }),
    ).catch((error) => error);
    expect(raceFailure).toMatchObject({ phase: "preflight" });
    expect(raceFailure.message).toContain("changed before credential helper");
    expect(helperCalls).toBe(0);

    const mutationFailure = await runIntegrationE2eCredentials(
      invocation("issue"),
      target,
      localOptions(staticState(version()), run, { review: "reviewer@example.test" }),
    ).catch((error) => error);
    expect(mutationFailure).toMatchObject({ phase: "mutation" });
    expect(mutationFailure.message).toContain("do not retry before status");
    expect(JSON.stringify(mutationFailure)).not.toContain("credential state unknown");
    expect(helperCalls).toBe(1);
  });

  test("hard-refuses non-integration, wrong organization, and authority-key reuse", async () => {
    let helperCalls = 0;
    const run: IntegrationE2eCredentialProcess = async () => {
      helperCalls += 1;
      throw new Error("helper must not run");
    };
    const production = { ...target, environment: "production" as const } as DeployTarget;
    const environmentFailure = await runIntegrationE2eCredentials(
      { ...invocation("status"), environment: "production" },
      production,
      localOptions(staticState(version()), run),
    ).catch((error) => error);
    expect(environmentFailure.message).toContain("integration-only");

    const wrongOrganization = {
      ...target,
      integrationE2eCredentialAuthority: {
        ...target.integrationE2eCredentialAuthority,
        organizationId: "org_wrong",
      },
    } as unknown as DeployTarget;
    const organizationFailure = await runIntegrationE2eCredentials(
      invocation("status"),
      wrongOrganization,
      localOptions(staticState(version()), run),
    ).catch((error) => error);
    expect(organizationFailure.message).toContain("exact organization");

    const reused = {
      ...target,
      operatorIdentity: { publicJwk: PUBLIC_JWK },
    } satisfies DeployTarget;
    const reuseFailure = await runIntegrationE2eCredentials(
      invocation("status"),
      reused,
      localOptions(staticState(version()), run),
    ).catch((error) => error);
    expect(reuseFailure.message).toContain("reused");

    const signingReuseFailure = await runIntegrationE2eCredentials(invocation("issue"), target, {
      ...localOptions(staticState(version()), run, { review: "reviewer@example.test" }),
      signingDatabase: signingDatabase(PUBLIC_JWK.x),
    }).catch((error) => error);
    expect(signingReuseFailure).toMatchObject({ phase: "preflight" });
    expect(signingReuseFailure.message).toContain("active runtime signing key");
    expect(JSON.stringify(signingReuseFailure)).not.toContain(PUBLIC_JWK.x);
    expect(helperCalls).toBe(0);
  });
});

function invocation(action: "issue" | "status" | "revoke") {
  return {
    surface: "takoserver-integration-e2e-credentials" as const,
    action,
    environment: "integration" as const,
    commit: COMMIT,
  };
}

function version() {
  const closure = expectedExactBindingClosure(target, {
    provenance: {
      sourceCommit: COMMIT,
      artifactDigest: `sha256:${BUNDLE_DIGEST}`,
    },
  });
  return {
    annotations: { "workers/message": `takoserver-worker:${COMMIT}:${BUNDLE_DIGEST}` },
    resources: {
      bindings: Object.entries(closure).flatMap(([name, requirement]) =>
        requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
      ),
    },
  };
}

function staticState(workerVersion: unknown): WorkerState {
  return {
    async workerDeployments() {
      return [deployment("deployment-current", VERSION_ID, null)];
    },
    async workerVersion() {
      return structuredClone(workerVersion);
    },
    async workerSecrets() {
      return [{ name: "TAKOSERVER_SIGNING_KEY", type: "secret_text" }];
    },
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: target.workerName }];
    },
  };
}

function racingState(): WorkerState {
  let reads = 0;
  return {
    ...staticState(version()),
    async workerDeployments() {
      reads += 1;
      return reads === 1
        ? [deployment("deployment-current", VERSION_ID, null)]
        : [deployment("deployment-raced", "00000000-0000-4000-8000-000000000002", VERSION_ID)];
    },
  };
}

function deployment(id: string, versionId: string, previousVersionId: string | null) {
  return {
    id,
    created_on: "2026-08-30T12:00:00Z",
    versions: [{ version_id: versionId, percentage: 100 }],
    ...(previousVersionId === null ? {} : { previous_version_id: previousVersionId }),
  };
}

function localOptions(
  state: WorkerState,
  run: IntegrationE2eCredentialProcess,
  extra: { readonly review?: string } = {},
) {
  return {
    state,
    run,
    privateJwkPath: join(tmpdir(), "takoserver-jit-owner-test-private.jwk"),
    credentialOutputDirectory: join(tmpdir(), "takoserver-jit-owner-test-credentials"),
    cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
    signingDatabase: signingDatabase(DISTINCT_SIGNING_X),
    ...extra,
  };
}

function signingDatabase(publicX: string) {
  return {
    async readKey(keyId: string) {
      return {
        keyId,
        publicJwk: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: publicX }),
        createdAtEpochSeconds: 1_700_000_000,
        revokedAtEpochSeconds: null,
      };
    },
  };
}

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" };
}

function helperIssueResult(outputDirectory: string) {
  const paths = credentialPaths(outputDirectory);
  return {
    version: 3,
    kind: "takoserver.integration-e2e-credential-pair@v3",
    origin: target.publicOrigin,
    environment: "integration",
    organizationId: INTEGRATION_E2E_ORGANIZATION_ID,
    operationId: "issue-owner-exact-output",
    ttlSeconds: 3_600,
    requestedAuthority: {
      sourceCommit: COMMIT,
      artifactDigest: `sha256:${BUNDLE_DIGEST}`,
      publicWorkerVersionId: VERSION_ID,
    },
    roles: {
      writer: {
        role: "writer",
        name: "integration-e2e-writer",
        keyId: "key_ie2e_w_exact",
        scopes: ["resources:write"],
        secretPath: paths.writerSecret,
      },
      evidence: {
        role: "evidence",
        name: "integration-e2e-evidence",
        keyId: "key_ie2e_e_exact",
        scopes: ["resources:read"],
        secretPath: paths.evidenceSecret,
      },
    },
  };
}
