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
      { state: twoBindingProbeState({}), fetcher: readyFetcher() },
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
      { state: twoBindingProbeState({}), fetcher: readyFetcher() },
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
      { state: twoBindingProbeState({}), fetcher: readyFetcher() },
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

  const applyTarget = {
    ...target,
    environment: "integration",
    workerName: "takoserver-api-integration",
    publicOrigin: "https://api.integration.example.test",
    workerEndpointSuffix: "integration.example.workers.dev",
    formAuthority: {
      ...target.formAuthority,
      identityProbeOrigin:
        "https://takoserver-form-identity-production.integration.example.workers.dev",
    },
  } satisfies DeployTarget;

  function probeVersion(bindings: readonly string[], commit: string, digest: `sha256:${string}`) {
    const all = [
      {
        name: "TAKOSERVER_FORM_AUTHORITY_HOST_ID",
        type: "plain_text",
        text: applyTarget.formAuthority.hostId,
      },
      {
        name: "PUBLIC_HOST_IDENTITY",
        type: "service",
        service: applyTarget.workerName,
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

  function applyState(isUploaded: () => boolean): FormAuthorityIdentityProbeState {
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

  test("publishes the added binding through the declaration in exactly one upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-probe-transition-"));
    let uploaded = false;
    uploadedProbeDigest = null;
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
              refreshedVars: [],
              addedBindings: ["FORM_AUTHORITY"],
              addedSecrets: [],
              rotatedSecrets: [],
            },
          },
        },
        applyTarget,
        {
          run,
          state: applyState(() => uploaded),
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
