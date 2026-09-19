import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { cloudflareProviderExecutorTarget } from "./helpers/hosted-supply-fixtures.ts";

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
    offerings: YURUCOMMU_IDENTITY_CAPABILITY_KINDS.filter(
      (formKind) => formKind !== "ObjectBucket",
    ).map((formKind) => ({ formKind })),
  } as unknown as NonNullable<DeployTarget["edgeSupplies"]>,
  objectBucketSupplies: {
    supplies: [{ provider: { kind: "cloudflare" } }],
  } as unknown as NonNullable<DeployTarget["objectBucketSupplies"]>,
  cloudflareProviderExecutor: cloudflareProviderExecutorTarget("cloudflare.primary"),
  formAuthority: {
    workerName: "takoserver-form-authority-production",
    identityProbeWorkerName: "takoserver-form-identity-production",
    identityProbeOrigin:
      "https://takoserver-form-identity-production.production.example.workers.dev",
    hostId: "https://api.example.test",
  },
  signing: { currentKeyId: "key-current" },
} satisfies DeployTarget;

const integrationHostOnlyTarget = {
  ...target,
  environment: "integration",
  workerName: "takoserver-api-integration",
  publicOrigin: "https://api.integration.example.test",
  formAuthority: {
    ...target.formAuthority,
    workerName: "takoserver-form-authority-integration",
    identityProbeWorkerName: "takoserver-form-identity-integration",
    identityProbeOrigin:
      "https://takoserver-form-identity-integration.integration.example.workers.dev",
    integrationWorkerName: "takoserver-form-fixture-integration",
    integrationOperatorWorkerName: "takoserver-form-operator-integration",
    integrationOperatorOrigin: "https://form-authority.integration.takoserver.com",
    integrationOperatorScope: {
      tenantId: "tenant-yurucommu-integration",
      space: "space-yurucommu-integration",
    },
    operatorPublicJwk: {
      kty: "OKP" as const,
      crv: "Ed25519" as const,
      x: "A".repeat(43),
    },
    hostId: "https://api.integration.example.test",
  },
} satisfies DeployTarget;

describe("Form authority identity probe deploy surface", () => {
  test("service binding refresh is refused outside integration before credentials", async () => {
    let credentialCalls = 0;
    const failure = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "apply",
        environment: "production",
        commit: COMMIT,
        transition: {
          predecessorVersionId: PROBE_VERSION,
          delta: {
            retiredVars: [],
            addedVars: [],
            refreshedVars: [],
            refreshedServiceBindings: ["PUBLIC_HOST_IDENTITY"],
            addedBindings: [],
            addedSecrets: [],
            rotatedSecrets: [],
          },
        },
      },
      target,
      {
        run: async () => {
          credentialCalls += 1;
          throw new Error("must refuse before credential resolution");
        },
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "Worker service binding refresh is integration-only",
    );
    expect(credentialCalls).toBe(0);
  });

  test("storage rebind is explicitly refused before identity-probe provider effects", async () => {
    let processCalls = 0;
    const failure = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "apply",
        environment: "production",
        commit: COMMIT,
        transition: {
          predecessorVersionId: PROBE_VERSION,
          delta: {
            retiredVars: [],
            addedVars: [],
            refreshedVars: [],
            addedBindings: [],
            addedSecrets: [],
            rotatedSecrets: [],
            storageRebind: {
              predecessorStateDatabaseId: "00000000-0000-4000-8000-0000000000a4",
              predecessorObjectBucketName: "takoserver-i-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            },
          },
        },
      },
      target,
      {
        run: async () => {
          processCalls += 1;
          throw new Error("identity probe must refuse before credentials");
        },
        state: probeState(true),
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "Form authority identity probe does not bind STATE_DB or OBJECTS",
    );
    expect(processCalls).toBe(0);
  });

  test("realizes only the two read-only identity RPC bindings and Host id", () => {
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
          {
            binding: "FORM_AUTHORITY",
            service: target.formAuthority.workerName,
            entrypoint: "FormAuthorityEntrypoint",
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
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
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
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
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

describe("integration Host-only identity probe bootstrap profile", () => {
  const PUBLIC_BUNDLE =
    "export default { async fetch() { return new Response('public-host-only'); } };\n";
  const PROBE_BUNDLE =
    "export default { async fetch() { return new Response('probe-host-only'); } };\n";
  const PUBLIC_DIGEST = `sha256:${createHash("sha256")
    .update(PUBLIC_BUNDLE)
    .digest("hex")}` as const;
  const PROBE_DIGEST = `sha256:${createHash("sha256").update(PROBE_BUNDLE).digest("hex")}` as const;
  const PROFILE_COMMIT = "c".repeat(40);
  const PUBLIC_VERSION = "77777777-7777-4777-8777-777777777777";
  const PROBE_VERSION = "88888888-8888-4888-8888-888888888888";
  const UPDATED_PROFILE_COMMIT = "e".repeat(40);
  const UPDATED_PROBE_BUNDLE =
    "export default { async fetch() { return new Response('probe-host-only-update'); } };\n";
  const UPDATED_PROBE_DIGEST = `sha256:${createHash("sha256")
    .update(UPDATED_PROBE_BUNDLE)
    .digest("hex")}` as const;
  const UPDATED_PROBE_VERSION = "99999999-9999-4999-8999-999999999999";

  test("publishes the exact Host-only closure when both native Workers are absent", async () => {
    const uploaded = { value: false };
    const uploads: string[][] = [];
    const uploadedConfigs: Record<string, unknown>[] = [];
    const state = hostOnlyState(uploaded);
    const result = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "apply",
        environment: "integration",
        commit: PROFILE_COMMIT,
      },
      integrationHostOnlyTarget,
      {
        state,
        fetcher: hostOnlyFetcher(),
        review: "independent-reviewer",
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        run: async (command) => {
          uploads.push([...command]);
          const key = command.join(" ");
          if (key === "git rev-parse HEAD") return ok(`${PROFILE_COMMIT}\n`);
          if (key === "git branch --show-current") return ok("fix/integration-host-only\n");
          if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
          if (key === "bun run check") return ok("green\n");
          if (command.includes("--dry-run")) {
            const out = command[command.indexOf("--outdir") + 1];
            if (!out) throw new Error("dry-run outdir missing");
            mkdirSync(out, { recursive: true });
            writeFileSync(
              join(out, "worker.js"),
              out.includes("public-worker-proof") ? PUBLIC_BUNDLE : PROBE_BUNDLE,
            );
            writeFileSync(join(out, "worker.js.map"), "{}\n");
            return ok("built\n");
          }
          if (command.includes("--no-bundle")) {
            const configPath = command[command.indexOf("--config") + 1];
            if (!configPath) throw new Error("upload config missing");
            uploadedConfigs.push(JSON.parse(readFileSync(configPath, "utf8")));
            uploaded.value = true;
            return ok("uploaded\n");
          }
          throw new Error(`unexpected command: ${key}`);
        },
      },
    );

    expect(result).toMatchObject({
      probeProfile: "integration-host-only",
      formAuthorityWorkerPresent: false,
      publicIdentityRpcReady: true,
      coreVerifierConfigured: false,
      coreVerifierRpcReady: false,
      ready: true,
    });
    expect(uploads.filter((command) => command.includes("--no-bundle"))).toHaveLength(1);
    expect(uploadedConfigs).toEqual([
      {
        account_id: integrationHostOnlyTarget.accountId,
        name: integrationHostOnlyTarget.formAuthority.identityProbeWorkerName,
        main: "worker.js",
        compatibility_date: "2026-08-17",
        compatibility_flags: ["nodejs_compat"],
        workers_dev: true,
        preview_urls: false,
        observability: { enabled: true },
        vars: { TAKOSERVER_FORM_AUTHORITY_HOST_ID: integrationHostOnlyTarget.formAuthority.hostId },
        services: [
          {
            binding: "PUBLIC_HOST_IDENTITY",
            service: integrationHostOnlyTarget.workerName,
            entrypoint: "PublicHostIdentityEntrypoint",
          },
        ],
      },
    ]);
    expect(state.observedProbeBindings).toEqual([
      "TAKOSERVER_FORM_AUTHORITY_HOST_ID",
      "PUBLIC_HOST_IDENTITY",
    ]);
  });

  test("status recognizes the emitted Host-only profile without inventing Core readiness", async () => {
    const uploaded = { value: true };
    const result = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "status",
        environment: "integration",
        commit: PROFILE_COMMIT,
      },
      integrationHostOnlyTarget,
      { state: hostOnlyState(uploaded), fetcher: hostOnlyFetcher() },
    );

    expect(result).toMatchObject({
      probeProfile: "integration-host-only",
      formAuthorityWorkerPresent: false,
      publicIdentityRpcReady: true,
      coreVerifierConfigured: false,
      coreVerifierRpcReady: false,
      ready: true,
    });
    expect(result).not.toHaveProperty("formAuthorityWorkerRemedy");
  });

  test("publishes an existing Host-only profile code update without adding Core binding", async () => {
    const uploaded = { value: false };
    const probePublished = { value: true };
    const uploads: string[][] = [];
    const uploadedConfigs: Record<string, unknown>[] = [];
    const base = hostOnlyState(probePublished, integrationHostOnlyTarget, {
      publicCommit: UPDATED_PROFILE_COMMIT,
    });
    const state: FormAuthorityIdentityProbeState = {
      ...base,
      async workerDeployments(workerName) {
        if (workerName !== integrationHostOnlyTarget.formAuthority.identityProbeWorkerName) {
          return base.workerDeployments(workerName);
        }
        return uploaded.value
          ? [
              {
                id: "probe-update-deployment",
                created_on: "2026-09-02T01:00:00Z",
                versions: [{ version_id: UPDATED_PROBE_VERSION, percentage: 100 }],
              },
              {
                id: "probe-deployment",
                created_on: "2026-09-01T01:00:00Z",
                versions: [{ version_id: PROBE_VERSION, percentage: 100 }],
              },
            ]
          : [
              {
                id: "probe-deployment",
                created_on: "2026-09-01T01:00:00Z",
                versions: [{ version_id: PROBE_VERSION, percentage: 100 }],
              },
            ];
      },
      async workerVersion(workerName, versionId) {
        const value = await base.workerVersion(workerName, versionId);
        if (
          workerName !== integrationHostOnlyTarget.formAuthority.identityProbeWorkerName ||
          !uploaded.value
        ) {
          return value;
        }
        const version = value as {
          readonly annotations: Readonly<Record<string, unknown>>;
          readonly resources: unknown;
        };
        return {
          ...version,
          annotations: {
            ...version.annotations,
            "workers/message": `form-authority-identity-probe:${UPDATED_PROFILE_COMMIT}:${UPDATED_PROBE_DIGEST}`,
          },
        };
      },
    };
    const result = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "apply",
        environment: "integration",
        commit: UPDATED_PROFILE_COMMIT,
      },
      integrationHostOnlyTarget,
      {
        state,
        fetcher: hostOnlyFetcher(),
        review: "independent-reviewer",
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        run: async (command) => {
          uploads.push([...command]);
          const key = command.join(" ");
          if (key === "git rev-parse HEAD") return ok(`${UPDATED_PROFILE_COMMIT}\n`);
          if (key === "git branch --show-current") return ok("fix/integration-host-only-update\n");
          if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
          if (key === "bun run check") return ok("green\n");
          if (command.includes("--dry-run")) {
            const out = command[command.indexOf("--outdir") + 1];
            if (!out) throw new Error("dry-run outdir missing");
            mkdirSync(out, { recursive: true });
            writeFileSync(
              join(out, "worker.js"),
              out.includes("public-worker-proof") ? PUBLIC_BUNDLE : UPDATED_PROBE_BUNDLE,
            );
            writeFileSync(join(out, "worker.js.map"), "{}\n");
            return ok("built\n");
          }
          if (command.includes("--no-bundle")) {
            const configPath = command[command.indexOf("--config") + 1];
            if (!configPath) throw new Error("upload config missing");
            uploadedConfigs.push(JSON.parse(readFileSync(configPath, "utf8")));
            uploaded.value = true;
            return ok("uploaded\n");
          }
          throw new Error(`unexpected command: ${key}`);
        },
      },
    );

    expect(result).toMatchObject({
      probeProfile: "integration-host-only",
      formAuthorityWorkerPresent: false,
      previousVersionId: PROBE_VERSION,
      ready: true,
    });
    expect(uploads.filter((command) => command.includes("--no-bundle"))).toHaveLength(1);
    expect(uploadedConfigs).toHaveLength(1);
    expect(uploadedConfigs[0]?.services).toEqual([
      {
        binding: "PUBLIC_HOST_IDENTITY",
        service: integrationHostOnlyTarget.workerName,
        entrypoint: "PublicHostIdentityEntrypoint",
      },
    ]);
  });

  test("refuses an existing Host-only update after Core appears instead of auto-transitioning", async () => {
    const calls: string[][] = [];
    const base = hostOnlyState({ value: true });
    const state: FormAuthorityIdentityProbeState = {
      ...base,
      async workerScripts() {
        return [
          ...(await base.workerScripts()),
          integrationHostOnlyTarget.formAuthority.workerName,
        ];
      },
    };
    const refusal = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "apply",
        environment: "integration",
        commit: PROFILE_COMMIT,
      },
      integrationHostOnlyTarget,
      {
        state,
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        run: async (command) => {
          calls.push([...command]);
          throw new Error(`unexpected command: ${command.join(" ")}`);
        },
      },
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("already exists");
    expect((refusal as Error).message).toContain("--add-binding=FORM_AUTHORITY");
    expect(calls).toEqual([]);
  });

  test("does not recognize Host-only status when integration operator topology is incomplete", async () => {
    const { integrationOperatorScope: _integrationOperatorScope, ...incompleteAuthority } =
      integrationHostOnlyTarget.formAuthority;
    const incomplete = {
      ...integrationHostOnlyTarget,
      formAuthority: incompleteAuthority,
    } as DeployTarget;
    const result = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "status",
        environment: "integration",
        commit: PROFILE_COMMIT,
      },
      incomplete,
      { state: hostOnlyState({ value: true }), fetcher: hostOnlyFetcher() },
    );

    expect(result).toMatchObject({
      probeProfile: null,
      publicIdentityRpcReady: true,
      ready: false,
    });
    expect(result.formAuthorityWorkerRemedy).toContain("takoserver-form-authority-worker");
  });

  test("refuses routine Host-only apply from an incomplete integration topology", async () => {
    const { integrationOperatorScope: _integrationOperatorScope, ...incompleteAuthority } =
      integrationHostOnlyTarget.formAuthority;
    const incomplete = {
      ...integrationHostOnlyTarget,
      formAuthority: incompleteAuthority,
    } as DeployTarget;
    const base = hostOnlyState({ value: true });
    const state: FormAuthorityIdentityProbeState = {
      ...base,
      async workerScripts() {
        return [
          ...(await base.workerScripts()),
          integrationHostOnlyTarget.formAuthority.workerName,
        ];
      },
    };
    const calls: string[][] = [];
    const refusal = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "apply",
        environment: "integration",
        commit: PROFILE_COMMIT,
      },
      incomplete,
      {
        state,
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        run: async (command) => {
          calls.push([...command]);
          throw new Error(`unexpected command: ${command.join(" ")}`);
        },
      },
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("FORM_AUTHORITY");
    expect(calls).toEqual([]);
  });

  test("keeps the existing production absence refusal", async () => {
    const calls: string[][] = [];
    const refusal = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "apply",
        environment: "production",
        commit: COMMIT,
      },
      target,
      {
        state: hostOnlyState({ value: false }, target),
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        run: async (command) => {
          calls.push([...command]);
          return ok("");
        },
      },
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("does not exist on account");
    expect(calls).toEqual([]);
  });

  test("does not classify a non-integration missing Core binding as Host-only", async () => {
    const base = probeState(true);
    const state: FormAuthorityIdentityProbeState = {
      ...base,
      async workerVersion(workerName, versionId) {
        const value = await base.workerVersion(workerName, versionId);
        if (workerName !== target.formAuthority.identityProbeWorkerName) return value;
        const version = value as {
          readonly resources: { readonly bindings: readonly { readonly name: string }[] };
        };
        return {
          ...version,
          resources: {
            ...version.resources,
            bindings: version.resources.bindings.filter(({ name }) => name !== "FORM_AUTHORITY"),
          },
        };
      },
    };
    const calls: string[][] = [];
    const refusal = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "apply",
        environment: "production",
        commit: COMMIT,
      },
      target,
      {
        state,
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        run: async (command) => {
          calls.push([...command]);
          throw new Error(`unexpected command: ${command.join(" ")}`);
        },
      },
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("FORM_AUTHORITY");
    expect(calls).toEqual([]);
  });

  test("rechecks full-Core authority presence at the final fence before uploading", async () => {
    const uploaded = { value: false };
    let ownerGate = false;
    const calls: string[][] = [];
    const publicExpected = expectedExactBindingClosure(target, {
      workerArtifactDigest: PUBLIC_DIGEST,
    });
    const base = probeState(true);
    const state: FormAuthorityIdentityProbeState = {
      ...base,
      async workerScripts() {
        const scripts = await base.workerScripts();
        return ownerGate
          ? scripts.filter((name) => name !== target.formAuthority.workerName)
          : scripts;
      },
      async workerDeployments(workerName) {
        if (workerName === target.workerName) {
          return [
            {
              id: `${workerName}-deployment`,
              created_on: "2026-08-30T00:00:00Z",
              versions: [{ version_id: PUBLIC_VERSION, percentage: 100 }],
            },
          ];
        }
        return base.workerDeployments(workerName);
      },
      async workerVersion(workerName, versionId) {
        if (workerName !== target.workerName) return base.workerVersion(workerName, versionId);
        return {
          annotations: {
            "workers/message": `takoserver-worker:${COMMIT}:${PUBLIC_DIGEST.slice("sha256:".length)}`,
            "workers/triggered_by": "version_upload",
          },
          resources: {
            bindings: Object.entries(publicExpected).flatMap(([name, requirement]) =>
              requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
            ),
          },
        };
      },
    };
    const semantic = await derivePublicFormImplementationIdentity({
      implementationPayloadDigest: PAYLOAD_DIGEST,
      capabilities: publicFormCapabilityManifest(),
    });
    const refusal = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "apply",
        environment: "production",
        commit: COMMIT,
      },
      target,
      {
        state,
        fetcher: async () =>
          Response.json({
            kind: "takoserver.public-host-identity@v2",
            hostId: target.formAuthority.hostId,
            workerVersionId: PUBLIC_VERSION,
            workerArtifactDigest: PUBLIC_DIGEST,
            ...semantic,
          }),
        review: "independent-reviewer",
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        run: async (command) => {
          calls.push([...command]);
          const key = command.join(" ");
          if (key === "git rev-parse HEAD") return ok(`${"a".repeat(40)}\n`);
          if (key === "git branch --show-current") return ok("fix/full-core-fence\n");
          if (key === "git fetch --quiet --all --prune") return ok("");
          if (key === `git branch -r --contains ${"a".repeat(40)}`) {
            return ok("  origin/fix/full-core-fence\n");
          }
          if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
          if (key === "bun run check") {
            ownerGate = true;
            return ok("green\n");
          }
          if (command.includes("--dry-run")) {
            const out = command[command.indexOf("--outdir") + 1];
            if (!out) throw new Error("dry-run outdir missing");
            mkdirSync(out, { recursive: true });
            writeFileSync(
              join(out, "worker.js"),
              out.includes("public-worker-proof") ? PUBLIC_BUNDLE : PROBE_BUNDLE,
            );
            writeFileSync(join(out, "worker.js.map"), "{}\n");
            return ok("built\n");
          }
          if (command.includes("--no-bundle")) {
            uploaded.value = true;
            return ok("uploaded\n");
          }
          throw new Error(`unexpected command: ${key}`);
        },
      },
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("does not exist on account");
    expect(ownerGate).toBe(true);
    expect(uploaded.value).toBe(false);
    expect(calls.filter((command) => command.includes("--no-bundle"))).toHaveLength(0);
  });

  test("refuses an incomplete integration topology before reading or uploading", async () => {
    const calls: string[][] = [];
    const { identityProbeOrigin: _identityProbeOrigin, ...incompleteAuthority } =
      integrationHostOnlyTarget.formAuthority;
    const incomplete = {
      ...integrationHostOnlyTarget,
      formAuthority: incompleteAuthority,
    } as DeployTarget;
    const refusal = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "apply",
        environment: "integration",
        commit: PROFILE_COMMIT,
      },
      incomplete,
      {
        state: hostOnlyState({ value: false }),
        run: async (command) => {
          calls.push([...command]);
          return ok("");
        },
      },
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("identity probe");
    expect(calls).toEqual([]);
  });

  test("refuses a public identity drift and never uploads", async () => {
    const uploaded = { value: false };
    const calls: string[][] = [];
    const refusal = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "apply",
        environment: "integration",
        commit: PROFILE_COMMIT,
      },
      integrationHostOnlyTarget,
      {
        state: hostOnlyState(uploaded, integrationHostOnlyTarget, {
          publicCommit: "d".repeat(40),
        }),
        fetcher: hostOnlyFetcher(),
        review: "independent-reviewer",
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        run: async (command) => {
          calls.push([...command]);
          const key = command.join(" ");
          if (key === "git rev-parse HEAD") return ok(`${PROFILE_COMMIT}\n`);
          if (key === "git branch --show-current") return ok("fix/integration-host-only\n");
          if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
          if (key === "bun run check") return ok("green\n");
          if (command.includes("--no-bundle")) {
            uploaded.value = true;
            return ok("uploaded\n");
          }
          throw new Error(`unexpected command: ${key}`);
        },
      },
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("public");
    expect(uploaded.value).toBe(false);
    expect(calls.filter((command) => command.includes("--no-bundle"))).toHaveLength(0);
  });

  test("does not retry an acknowledged upload when the public post-readback drifts", async () => {
    const uploaded = { value: false };
    const calls: string[][] = [];
    let fetchCalls = 0;
    const refusal = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "apply",
        environment: "integration",
        commit: PROFILE_COMMIT,
      },
      integrationHostOnlyTarget,
      {
        state: hostOnlyState(uploaded),
        fetcher: async () => {
          fetchCalls += 1;
          const semantic = await derivePublicFormImplementationIdentity({
            implementationPayloadDigest: PAYLOAD_DIGEST,
            capabilities: publicFormCapabilityManifest(),
          });
          return Response.json({
            kind: "takoserver.public-host-identity@v2",
            hostId: "https://drifted.example.test",
            workerVersionId: PUBLIC_VERSION,
            workerArtifactDigest: PUBLIC_DIGEST,
            ...semantic,
          });
        },
        review: "independent-reviewer",
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        run: async (command) => {
          calls.push([...command]);
          const key = command.join(" ");
          if (key === "git rev-parse HEAD") return ok(`${PROFILE_COMMIT}\n`);
          if (key === "git branch --show-current") return ok("fix/integration-host-only\n");
          if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
          if (key === "bun run check") return ok("green\n");
          if (command.includes("--dry-run")) {
            const out = command[command.indexOf("--outdir") + 1];
            if (!out) throw new Error("dry-run outdir missing");
            mkdirSync(out, { recursive: true });
            writeFileSync(
              join(out, "worker.js"),
              out.includes("public-worker-proof") ? PUBLIC_BUNDLE : PROBE_BUNDLE,
            );
            writeFileSync(join(out, "worker.js.map"), "{}\n");
            return ok("built\n");
          }
          if (command.includes("--no-bundle")) {
            uploaded.value = true;
            return ok("uploaded\n");
          }
          throw new Error(`unexpected command: ${key}`);
        },
      },
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("identity");
    expect(uploaded.value).toBe(true);
    expect(fetchCalls).toBe(1);
    expect(calls.filter((command) => command.includes("--no-bundle"))).toHaveLength(1);
  });

  test("refuses probe or authority appearance at the final absence fence", async () => {
    for (const appeared of ["probe", "authority"] as const) {
      const uploaded = { value: false };
      let ownerGate = false;
      const calls: string[][] = [];
      const base = hostOnlyState(uploaded);
      const state: FormAuthorityIdentityProbeState = {
        ...base,
        async workerScripts() {
          const scripts = await base.workerScripts();
          if (!ownerGate) return scripts;
          return appeared === "probe"
            ? [...scripts, integrationHostOnlyTarget.formAuthority.identityProbeWorkerName]
            : [...scripts, integrationHostOnlyTarget.formAuthority.workerName];
        },
      };
      const refusal = await runFormAuthorityIdentityProbe(
        {
          surface: "takoserver-form-authority-identity-probe",
          action: "apply",
          environment: "integration",
          commit: PROFILE_COMMIT,
        },
        integrationHostOnlyTarget,
        {
          state,
          fetcher: hostOnlyFetcher(),
          review: "independent-reviewer",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          run: async (command) => {
            calls.push([...command]);
            const key = command.join(" ");
            if (key === "git rev-parse HEAD") return ok(`${PROFILE_COMMIT}\n`);
            if (key === "git branch --show-current") return ok("fix/integration-host-only\n");
            if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
            if (key === "bun run check") {
              ownerGate = true;
              return ok("green\n");
            }
            if (command.includes("--dry-run")) {
              const out = command[command.indexOf("--outdir") + 1];
              if (!out) throw new Error("dry-run outdir missing");
              mkdirSync(out, { recursive: true });
              writeFileSync(
                join(out, "worker.js"),
                out.includes("public-worker-proof") ? PUBLIC_BUNDLE : PROBE_BUNDLE,
              );
              writeFileSync(join(out, "worker.js.map"), "{}\n");
              return ok("built\n");
            }
            if (command.includes("--no-bundle")) {
              uploaded.value = true;
              return ok("uploaded\n");
            }
            throw new Error(`unexpected command: ${key}`);
          },
        },
      ).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toMatch(/(probe|authority)/u);
      expect(uploaded.value).toBe(false);
      expect(calls.filter((command) => command.includes("--no-bundle"))).toHaveLength(0);
    }
  });

  function hostOnlyState(
    uploaded: { value: boolean },
    selectedTarget: DeployTarget = integrationHostOnlyTarget,
    input: { readonly publicCommit?: string } = {},
  ): FormAuthorityIdentityProbeState & {
    readonly observedProbeBindings: string[];
  } {
    const observedProbeBindings: string[] = [];
    const selectedAuthority = selectedTarget.formAuthority;
    if (!selectedAuthority) throw new Error("fixture Form authority topology missing");
    const publicExpected = expectedExactBindingClosure(selectedTarget, {
      workerArtifactDigest: PUBLIC_DIGEST,
    });
    return {
      observedProbeBindings,
      async workerScripts() {
        return uploaded.value
          ? [selectedTarget.workerName, selectedAuthority.identityProbeWorkerName]
          : [selectedTarget.workerName];
      },
      async workerDeployments(workerName) {
        if (workerName === selectedTarget.workerName) {
          return [
            {
              id: "public-deployment",
              created_on: "2026-09-01T00:00:00Z",
              versions: [{ version_id: PUBLIC_VERSION, percentage: 100 }],
            },
          ];
        }
        return uploaded.value
          ? [
              {
                id: "probe-deployment",
                created_on: "2026-09-01T01:00:00Z",
                versions: [{ version_id: PROBE_VERSION, percentage: 100 }],
              },
            ]
          : [];
      },
      async workerVersion(workerName) {
        if (workerName === selectedTarget.workerName) {
          return {
            annotations: {
              "workers/message": `takoserver-worker:${input.publicCommit ?? PROFILE_COMMIT}:${PUBLIC_DIGEST.slice("sha256:".length)}`,
              "workers/triggered_by": "version_upload",
            },
            resources: {
              bindings: Object.entries(publicExpected).flatMap(([name, requirement]) =>
                requirement === null
                  ? []
                  : [{ name, type: requirement.type, ...requirement.fields }],
              ),
            },
          };
        }
        const bindings = [
          {
            name: "TAKOSERVER_FORM_AUTHORITY_HOST_ID",
            type: "plain_text",
            text: selectedAuthority.hostId,
          },
          {
            name: "PUBLIC_HOST_IDENTITY",
            type: "service",
            service: selectedTarget.workerName,
            entrypoint: "PublicHostIdentityEntrypoint",
          },
        ];
        observedProbeBindings.splice(
          0,
          observedProbeBindings.length,
          ...bindings.map(({ name }) => name),
        );
        return {
          annotations: {
            "workers/message": `form-authority-identity-probe:${PROFILE_COMMIT}:${PROBE_DIGEST}`,
          },
          resources: { bindings },
        };
      },
      async workerSecrets(workerName) {
        return workerName === selectedTarget.workerName
          ? expectedWorkerSecrets(selectedTarget).map((name) => ({ name, type: "secret_text" }))
          : [];
      },
      async workerDomains() {
        return [
          {
            hostname: new URL(selectedTarget.publicOrigin).hostname,
            service: selectedTarget.workerName,
          },
        ];
      },
      async workerSubdomain(workerName) {
        return {
          enabled: workerName === selectedAuthority.identityProbeWorkerName,
          previewsEnabled: false,
        };
      },
      async workerRoutes() {
        return [];
      },
    };
  }

  function hostOnlyFetcher(): (input: string, init?: RequestInit) => Promise<Response> {
    return async () => {
      const semantic = await derivePublicFormImplementationIdentity({
        implementationPayloadDigest: PAYLOAD_DIGEST,
        capabilities: publicFormCapabilityManifest(),
      });
      return Response.json({
        kind: "takoserver.public-host-identity@v2",
        hostId: integrationHostOnlyTarget.formAuthority.hostId,
        workerVersionId: PUBLIC_VERSION,
        workerArtifactDigest: PUBLIC_DIGEST,
        ...semantic,
      });
    };
  }

  function ok(stdout: string) {
    return { exitCode: 0, stdout, stderr: "" };
  }
});

function probeState(present: boolean): FormAuthorityIdentityProbeState {
  return {
    async workerScripts() {
      // The authority Worker the probe's FORM_AUTHORITY binding names is always
      // present here; its absence is a separate, separately owned refusal.
      return present
        ? [
            target.workerName,
            target.formAuthority.workerName,
            target.formAuthority.identityProbeWorkerName,
          ]
        : [target.workerName, target.formAuthority.workerName];
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
            {
              name: "FORM_AUTHORITY",
              type: "service",
              service: target.formAuthority.workerName,
              entrypoint: "FormAuthorityEntrypoint",
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

describe("Form authority identity probe forward transition", () => {
  const FORM_AUTHORITY_DELTA = {
    retiredVars: [],
    addedVars: [],
    refreshedVars: [],
    addedBindings: ["FORM_AUTHORITY"],
    addedSecrets: [],
    rotatedSecrets: [],
  } as const;

  /** The live wedge: the probe predates the commit that added its third binding. */
  function twoBindingProbeState(input: {
    readonly isUploaded?: () => boolean;
    readonly authorityWorkerPresent?: boolean;
  }): FormAuthorityIdentityProbeState {
    const isUploaded = input.isUploaded ?? (() => false);
    const present = input.authorityWorkerPresent !== false;
    const base = probeState(true);
    return {
      ...base,
      async workerScripts() {
        return [
          target.workerName,
          ...(present ? [target.formAuthority.workerName] : []),
          target.formAuthority.identityProbeWorkerName,
        ];
      },
      async workerVersion(workerName, versionId) {
        const value = (await base.workerVersion(workerName, versionId)) as {
          resources: { bindings: { name: string }[] };
        };
        if (workerName === target.workerName || isUploaded()) return value;
        return {
          ...value,
          resources: {
            bindings: value.resources.bindings.filter(({ name }) => name !== "FORM_AUTHORITY"),
          },
        };
      },
    };
  }

  test("status names the missing FORM_AUTHORITY binding instead of refusing opaquely", async () => {
    const status = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "status",
        environment: "production",
        commit: COMMIT,
      },
      target,
      {
        state: twoBindingProbeState({}),
        fetcher: readyFetcher(),
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
      },
    );
    expect(status).toMatchObject({
      bindingTransitionProfile: "none",
      formAuthorityWorkerPresent: true,
      ready: false,
    });
    expect(status.descriptorDrift).toEqual([
      {
        workerName: target.formAuthority.identityProbeWorkerName,
        versionId: PROBE_VERSION,
        differences: [{ binding: "FORM_AUTHORITY", difference: "missing", target: "service" }],
      },
    ]);
    // A binding that is absent is a closure change, not a value to adopt.
    expect(status.adoptableFromLive).toEqual([]);
    expect(status.unadoptableFromLive).toEqual([
      {
        worker: target.formAuthority.identityProbeWorkerName,
        binding: "FORM_AUTHORITY",
        reason: expect.stringContaining("--add-binding"),
      },
    ]);
  });

  test("admits the added service binding only through the declaration", async () => {
    const admitted = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "status",
        environment: "production",
        commit: COMMIT,
        transition: {
          predecessorVersionId: PROBE_VERSION,
          delta: { ...FORM_AUTHORITY_DELTA },
        },
      },
      target,
      {
        state: twoBindingProbeState({}),
        fetcher: readyFetcher(),
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
      },
    );
    expect(admitted).toMatchObject({
      bindingTransitionProfile: "declared-delta-predecessor",
      transitionPredecessorVersionId: PROBE_VERSION,
      ready: true,
    });

    // Declaring it as a plain-text var does not describe the target closure.
    const misdeclared = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "status",
        environment: "production",
        commit: COMMIT,
        transition: {
          predecessorVersionId: PROBE_VERSION,
          delta: { ...FORM_AUTHORITY_DELTA, addedBindings: [], addedVars: ["FORM_AUTHORITY"] },
        },
      },
      target,
      {
        state: twoBindingProbeState({}),
        fetcher: readyFetcher(),
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
      },
    );
    expect(misdeclared).toMatchObject({ bindingTransitionProfile: "none", ready: false });
  });

  test("refuses the undeclared apply and publishes the declared one exactly once", async () => {
    const undeclared = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "apply",
        environment: "production",
        commit: COMMIT,
      },
      target,
      {
        state: twoBindingProbeState({}),
        fetcher: readyFetcher(),
        review: "independent-reviewer",
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        async run() {
          throw new Error("no command may run before the closure fence");
        },
      },
    ).catch((error: unknown) => error);
    expect(undeclared).toBeInstanceOf(Error);
    expect((undeclared as Error).message).toContain("does not declare the FORM_AUTHORITY binding");
  });

  test("refuses to bind a Form authority Worker that does not exist on the account", async () => {
    const status = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "status",
        environment: "production",
        commit: COMMIT,
      },
      target,
      {
        state: twoBindingProbeState({ authorityWorkerPresent: false }),
        fetcher: readyFetcher(),
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
      },
    );
    expect(status).toMatchObject({
      formAuthorityWorkerName: target.formAuthority.workerName,
      formAuthorityWorkerPresent: false,
      ready: false,
    });
    expect(status.formAuthorityWorkerRemedy).toContain("takoserver-form-authority-worker");

    const refusal = await runFormAuthorityIdentityProbe(
      {
        surface: "takoserver-form-authority-identity-probe",
        action: "apply",
        environment: "production",
        commit: COMMIT,
        transition: { predecessorVersionId: PROBE_VERSION, delta: { ...FORM_AUTHORITY_DELTA } },
      },
      target,
      {
        state: twoBindingProbeState({ authorityWorkerPresent: false }),
        fetcher: readyFetcher(),
        review: "independent-reviewer",
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        async run() {
          throw new Error("no command may run before the missing Worker is named");
        },
      },
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain(target.formAuthority.workerName);
    expect((refusal as Error).message).toContain("takoserver-form-authority-worker --apply");
  });
});

function readyFetcher(): (input: string, init?: RequestInit) => Promise<Response> {
  return async () => {
    const semantic = await derivePublicFormImplementationIdentity({
      implementationPayloadDigest: PAYLOAD_DIGEST,
      capabilities: publicFormCapabilityManifest(),
    });
    return Response.json({
      kind: "takoserver.public-host-identity@v2",
      hostId: target.formAuthority.hostId,
      workerVersionId: PUBLIC_VERSION,
      workerArtifactDigest: OUTER_DIGEST,
      ...semantic,
    });
  };
}

describe("Form authority identity probe forward transition apply", () => {
  const PUBLIC_BUNDLE = "export default { async fetch() { return new Response('public'); } };\n";
  const PROBE_BUNDLE = "export default { async fetch() { return new Response('probe'); } };\n";
  const PUBLIC_DIGEST = `sha256:${createHash("sha256")
    .update(PUBLIC_BUNDLE)
    .digest("hex")}` as const;
  const PROBE_SUCCESSOR = "44444444-4444-4444-8444-444444444444";
  const APPLY_COMMIT = "b".repeat(40);
  const PREDECESSOR_HOST_ID = "https://api.previous.integration.example.test";
  const PREDECESSOR_PUBLIC_SERVICE = "takoserver-api-integration-previous";

  const applyTarget = {
    ...target,
    environment: "integration",
    workerName: "takoserver-api-integration",
    publicOrigin: "https://api.integration.example.test",
    formAuthority: {
      ...target.formAuthority,
      identityProbeOrigin:
        "https://takoserver-form-identity-production.integration.example.workers.dev",
    },
  } satisfies DeployTarget;

  function probeVersion(
    bindings: readonly string[],
    commit: string,
    digest: `sha256:${string}`,
    staleIdentity = false,
  ) {
    const all = [
      {
        name: "TAKOSERVER_FORM_AUTHORITY_HOST_ID",
        type: "plain_text",
        text: staleIdentity ? PREDECESSOR_HOST_ID : applyTarget.formAuthority.hostId,
      },
      {
        name: "PUBLIC_HOST_IDENTITY",
        type: "service",
        service: staleIdentity ? PREDECESSOR_PUBLIC_SERVICE : applyTarget.workerName,
        entrypoint: "PublicHostIdentityEntrypoint",
      },
      {
        name: "FORM_AUTHORITY",
        type: "service",
        service: applyTarget.formAuthority.workerName,
        entrypoint: "FormAuthorityEntrypoint",
      },
    ];
    return {
      annotations: {
        "workers/message": `form-authority-identity-probe:${commit}:${digest}`,
        "workers/triggered_by": "version_upload",
      },
      resources: { bindings: all.filter(({ name }) => bindings.includes(name)) },
    };
  }

  function applyState(
    isUploaded: () => boolean,
    input: { readonly stalePredecessorIdentity?: boolean } = {},
  ): FormAuthorityIdentityProbeState {
    const expected = expectedExactBindingClosure(applyTarget, {
      workerArtifactDigest: PUBLIC_DIGEST,
    });
    return {
      async workerScripts() {
        return [
          applyTarget.workerName,
          applyTarget.formAuthority.workerName,
          applyTarget.formAuthority.identityProbeWorkerName,
        ];
      },
      async workerDeployments(workerName) {
        if (workerName === applyTarget.workerName) {
          return [
            {
              id: "public-deployment",
              created_on: "2026-09-02T00:00:00Z",
              versions: [{ version_id: PUBLIC_VERSION, percentage: 100 }],
            },
          ];
        }
        return isUploaded()
          ? [
              {
                id: "probe-successor",
                created_on: "2026-09-02T02:00:00Z",
                versions: [{ version_id: PROBE_SUCCESSOR, percentage: 100 }],
              },
              {
                id: "probe-predecessor",
                created_on: "2026-09-02T01:00:00Z",
                versions: [{ version_id: PROBE_VERSION, percentage: 100 }],
              },
            ]
          : [
              {
                id: "probe-predecessor",
                created_on: "2026-09-02T01:00:00Z",
                versions: [{ version_id: PROBE_VERSION, percentage: 100 }],
              },
            ];
      },
      async workerVersion(workerName, versionId) {
        if (workerName === applyTarget.workerName) {
          return {
            annotations: {
              "workers/message": `takoserver-worker:${APPLY_COMMIT}:${PUBLIC_DIGEST.slice(
                "sha256:".length,
              )}`,
              "workers/triggered_by": "version_upload",
            },
            resources: {
              bindings: Object.entries(expected).flatMap(([name, requirement]) =>
                requirement === null
                  ? []
                  : [{ name, type: requirement.type, ...requirement.fields }],
              ),
            },
          };
        }
        return versionId === PROBE_SUCCESSOR
          ? probeVersion(
              ["TAKOSERVER_FORM_AUTHORITY_HOST_ID", "PUBLIC_HOST_IDENTITY", "FORM_AUTHORITY"],
              APPLY_COMMIT,
              uploadedProbeDigest ?? PUBLIC_DIGEST,
            )
          : probeVersion(
              ["TAKOSERVER_FORM_AUTHORITY_HOST_ID", "PUBLIC_HOST_IDENTITY"],
              APPLY_COMMIT,
              PUBLIC_DIGEST,
              input.stalePredecessorIdentity,
            );
      },
      async workerSecrets(workerName) {
        return workerName === applyTarget.workerName
          ? expectedWorkerSecrets(applyTarget).map((name) => ({ name, type: "secret_text" }))
          : [];
      },
      async workerDomains() {
        return [{ hostname: "api.integration.example.test", service: applyTarget.workerName }];
      },
      async workerSubdomain() {
        return { enabled: true, previewsEnabled: false };
      },
      async workerRoutes() {
        return [];
      },
    };
  }

  let uploadedProbeDigest: `sha256:${string}` | null = null;

  test("refreshes Host id and service binding from the target while adding authority in one upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-probe-transition-"));
    let uploaded = false;
    uploadedProbeDigest = null;
    let uploadConfig: Record<string, unknown> | undefined;
    const calls: string[][] = [];
    try {
      const run = async (command: readonly string[]) => {
        calls.push([...command]);
        const key = command.join(" ");
        if (key === "git rev-parse HEAD") return ok(`${APPLY_COMMIT}\n`);
        if (key === "git branch --show-current") return ok("fix/probe-transition\n");
        if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
        if (key === "bun run check") return ok("green\n");
        if (command.includes("--dry-run")) {
          const out = command[command.indexOf("--outdir") + 1];
          if (!out) throw new Error("dry-run outdir missing");
          mkdirSync(out, { recursive: true });
          const publicBuild = out.includes("public-worker-proof");
          writeFileSync(join(out, "worker.js"), publicBuild ? PUBLIC_BUNDLE : PROBE_BUNDLE);
          writeFileSync(join(out, "worker.js.map"), "{}\n");
          return ok("built\n");
        }
        if (command.includes("--no-bundle")) {
          const message = command[command.indexOf("--message") + 1] ?? "";
          uploadedProbeDigest = message.slice(
            message.indexOf(":sha256:") + 1,
          ) as `sha256:${string}`;
          const configPath = command[command.indexOf("--config") + 1];
          if (!configPath) throw new Error("upload config path missing");
          uploadConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
          uploaded = true;
          return ok("uploaded\n");
        }
        throw new Error(`unexpected command: ${key}`);
      };
      const result = await runFormAuthorityIdentityProbe(
        {
          surface: "takoserver-form-authority-identity-probe",
          action: "apply",
          environment: "integration",
          commit: APPLY_COMMIT,
          transition: {
            predecessorVersionId: PROBE_VERSION,
            delta: {
              retiredVars: [],
              addedVars: [],
              refreshedVars: ["TAKOSERVER_FORM_AUTHORITY_HOST_ID"],
              refreshedServiceBindings: ["PUBLIC_HOST_IDENTITY"],
              addedBindings: ["FORM_AUTHORITY"],
              addedSecrets: [],
              rotatedSecrets: [],
            },
          },
        },
        applyTarget,
        {
          run,
          state: applyState(() => uploaded, { stalePredecessorIdentity: true }),
          fetcher: applyFetcher(),
          review: "independent-reviewer",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          outputDirectory: root,
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.form-authority-identity-probe-apply@v1",
        bindingTransitionProfile: "none",
        transitionPredecessorVersionId: PROBE_VERSION,
        previousVersionId: PROBE_VERSION,
        versionId: PROBE_SUCCESSOR,
        formAuthorityWorkerName: applyTarget.formAuthority.workerName,
        ready: true,
      });
      expect(calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(1);
      expect(uploadConfig).toMatchObject({
        vars: { TAKOSERVER_FORM_AUTHORITY_HOST_ID: applyTarget.formAuthority.hostId },
        services: [
          {
            binding: "PUBLIC_HOST_IDENTITY",
            service: applyTarget.workerName,
            entrypoint: "PublicHostIdentityEntrypoint",
          },
          {
            binding: "FORM_AUTHORITY",
            service: applyTarget.formAuthority.workerName,
            entrypoint: "FormAuthorityEntrypoint",
          },
        ],
      });
    } finally {
      uploadedProbeDigest = null;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rechecks the Form authority Worker at the mutation fence before uploading", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-probe-authority-fence-"));
    let uploaded = false;
    uploadedProbeDigest = null;
    let workerScriptsCalls = 0;
    const calls: string[][] = [];
    const baseState = applyState(() => uploaded);
    const state: FormAuthorityIdentityProbeState = {
      ...baseState,
      async workerScripts() {
        workerScriptsCalls += 1;
        const scripts = await baseState.workerScripts();
        // The first three reads cover initial authority validation and both
        // final qualification snapshots. The fourth read is the mutation
        // fence: the bound authority Worker disappears before publication.
        return workerScriptsCalls >= 4
          ? scripts.filter((name) => name !== applyTarget.formAuthority.workerName)
          : scripts;
      },
    };
    try {
      const refusal = await runFormAuthorityIdentityProbe(
        {
          surface: "takoserver-form-authority-identity-probe",
          action: "apply",
          environment: "integration",
          commit: APPLY_COMMIT,
          transition: {
            predecessorVersionId: PROBE_VERSION,
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
        applyTarget,
        {
          run: async (command: readonly string[]) => {
            calls.push([...command]);
            const key = command.join(" ");
            if (key === "git rev-parse HEAD") return ok(`${APPLY_COMMIT}\n`);
            if (key === "git branch --show-current") return ok("fix/probe-transition\n");
            if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
            if (key === "bun run check") return ok("green\n");
            if (command.includes("--dry-run")) {
              const out = command[command.indexOf("--outdir") + 1];
              if (!out) throw new Error("dry-run outdir missing");
              mkdirSync(out, { recursive: true });
              const publicBuild = out.includes("public-worker-proof");
              writeFileSync(join(out, "worker.js"), publicBuild ? PUBLIC_BUNDLE : PROBE_BUNDLE);
              writeFileSync(join(out, "worker.js.map"), "{}\n");
              return ok("built\n");
            }
            if (command.includes("--no-bundle")) {
              uploadedProbeDigest = "sha256:unexpected" as `sha256:${string}`;
              uploaded = true;
              return ok("uploaded\n");
            }
            throw new Error(`unexpected command: ${key}`);
          },
          state,
          fetcher: applyFetcher(),
          review: "independent-reviewer",
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          outputDirectory: root,
        },
      ).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(Error);
      expect(calls.filter((call) => call.includes("--no-bundle"))).toHaveLength(0);
      expect(workerScriptsCalls).toBeGreaterThanOrEqual(4);
      expect((refusal as Error).message).toContain(applyTarget.formAuthority.workerName);
      expect((refusal as Error).message).toContain("does not exist on account");
    } finally {
      uploadedProbeDigest = null;
      rmSync(root, { recursive: true, force: true });
    }
  });

  function applyFetcher(): (input: string, init?: RequestInit) => Promise<Response> {
    return async () => {
      const semantic = await derivePublicFormImplementationIdentity({
        implementationPayloadDigest: PAYLOAD_DIGEST,
        capabilities: publicFormCapabilityManifest(),
      });
      return Response.json({
        kind: "takoserver.public-host-identity@v2",
        hostId: applyTarget.formAuthority.hostId,
        workerVersionId: PUBLIC_VERSION,
        workerArtifactDigest: PUBLIC_DIGEST,
        ...semantic,
      });
    };
  }

  function ok(stdout: string) {
    return { exitCode: 0, stdout, stderr: "" };
  }
});
