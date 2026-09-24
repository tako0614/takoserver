import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takoformCoreVerifierArtifactDigest } from "../scripts/deploy/form-authority.ts";
import type { SigningDatabase } from "../scripts/deploy/signing.ts";
import {
  assertDedicatedSponsorshipKeys,
  inspectSponsorshipAuthority,
  registerSponsorshipCredentialPublicKey,
  runSponsorshipAuthority,
  type SponsorshipAuthorityDeployState,
  sponsorshipAuthorityBindingClosure,
  writeSponsorshipAuthorityConfig,
} from "../scripts/deploy/sponsorship-authority.ts";
import { type DeployTarget, managedSpaceAdmissionPolicyDigest } from "../scripts/deploy/target.ts";
import { normalizeGeneratedEd25519PrivateJwk } from "../src/ed25519-private-jwk.ts";
import { canonicalJson } from "../src/json.ts";
import { publicFormCapabilityManifest } from "../src/public-worker-implementation.ts";

const COMMIT = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}` as const;
const VERSION = "11111111-1111-4111-8111-111111111111";
const FORM_VERSION = "22222222-2222-4222-8222-222222222222";
const PUBLIC_VERSION = "33333333-3333-4333-8333-333333333333";
const PUBLIC_DIGEST = `sha256:${"c".repeat(64)}` as const;
const FORM_DIGEST = `sha256:${"d".repeat(64)}` as const;

const managedSpaceAdmissionPolicy = {
  kind: "takoserver.space-form-admission-policy@v1",
  organizationId: "org_hosted",
  forms: [
    {
      formRef: {
        apiVersion: "edge.forms.takoform.com",
        kind: "Alpha",
        definitionVersion: "1.0.0",
        schemaDigest: `sha256:${"a".repeat(64)}`,
      },
      packageDigest: `sha256:${"b".repeat(64)}`,
    },
  ],
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
  signing: { currentKeyId: "key-current" },
  sponsorshipAuthority: {
    workerName: "takoserver-sponsorship-authority-integration",
    organizationId: "org_hosted",
    credentialKeyId: "sponsorship-credential-key",
    credentialPublicJwk: { kty: "OKP", crv: "Ed25519", x: `${"B".repeat(42)}A` },
    receiptKeyId: "receipt-key",
    receiptPublicJwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) },
  },
} satisfies DeployTarget;

const targetWithNextSigningKey = {
  ...target,
  signing: { currentKeyId: target.signing.currentKeyId, nextKeyId: "key-next" },
} satisfies DeployTarget;

const managedTarget = {
  ...target,
  formAuthority: {
    workerName: "takoserver-form-authority-integration",
    identityProbeWorkerName: "takoserver-form-identity-probe-integration",
    identityProbeOrigin: "https://takoserver-form-identity-probe-integration.example.test",
    integrationWorkerName: "takoserver-form-authority-fixture-integration",
    hostId: "https://form-authority.integration.example.test",
    managedSpaceAdmissionPolicy,
  },
} satisfies DeployTarget;

describe("route-less sponsorship authority deploy", () => {
  test("requires three distinct signing identities and public keys", () => {
    expect(() =>
      assertDedicatedSponsorshipKeys(
        target,
        {
          keyId: target.signing.currentKeyId,
          publicJwk: JSON.stringify(target.sponsorshipAuthority.receiptPublicJwk),
          createdAtEpochSeconds: 1,
          revokedAtEpochSeconds: null,
        },
        null,
      ),
    ).toThrow("must all differ");
    expect(() =>
      assertDedicatedSponsorshipKeys(target, ordinarySigningRow(), {
        keyId: target.sponsorshipAuthority.credentialKeyId,
        publicJwk: JSON.stringify({
          ...target.sponsorshipAuthority.credentialPublicJwk,
          x: `${"D".repeat(42)}A`,
        }),
        createdAtEpochSeconds: 1,
        revokedAtEpochSeconds: null,
      }),
    ).toThrow("does not match");
  });

  test("realizes only deploy-pinned D1 and signing authority with no public topology", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-sponsorship-authority-config-"));
    try {
      const path = writeSponsorshipAuthorityConfig({
        path: join(root, "wrangler.jsonc"),
        main: "worker.js",
        target,
        commit: COMMIT,
        artifactDigest: DIGEST,
      });
      const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(config).toMatchObject({
        name: target.sponsorshipAuthority.workerName,
        main: "worker.js",
        account_id: target.accountId,
        workers_dev: false,
        preview_urls: false,
        vars: {
          TAKOSERVER_SPONSORSHIP_ORGANIZATION_ID: target.sponsorshipAuthority.organizationId,
          TAKOSERVER_SPONSORSHIP_TOKEN_ISSUER: target.publicOrigin,
          TAKOSERVER_SPONSORSHIP_CREDENTIAL_KEY_ID: target.sponsorshipAuthority.credentialKeyId,
          TAKOSERVER_SPONSORSHIP_CREDENTIAL_PUBLIC_JWK: JSON.stringify(
            target.sponsorshipAuthority.credentialPublicJwk,
          ),
          TAKOSERVER_SPONSORSHIP_RECEIPT_KEY_ID: target.sponsorshipAuthority.receiptKeyId,
          TAKOSERVER_SPONSORSHIP_AUTHORITY_WORKER_NAME: target.sponsorshipAuthority.workerName,
          TAKOSERVER_SPONSORSHIP_AUTHORITY_SOURCE_COMMIT: COMMIT,
          TAKOSERVER_SPONSORSHIP_AUTHORITY_ARTIFACT_SHA256: DIGEST,
        },
        secrets: {
          required: [
            "TAKOSERVER_SPONSORSHIP_CREDENTIAL_SIGNING_KEY",
            "TAKOSERVER_SPONSORSHIP_RECEIPT_SIGNING_KEY",
          ],
        },
        version_metadata: { binding: "WORKER_VERSION" },
        d1_databases: [
          {
            binding: "STATE_DB",
            database_name: target.d1.databaseName,
            database_id: target.d1.databaseId,
          },
        ],
      });
      expect(config).not.toHaveProperty("routes");
      expect(config).not.toHaveProperty("services");
      expect(config).not.toHaveProperty("r2_buckets");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("emits the exact managed policy digest and narrow Form service binding", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-sponsorship-managed-policy-"));
    try {
      const path = writeSponsorshipAuthorityConfig({
        path: join(root, "wrangler.jsonc"),
        main: "worker.js",
        target: managedTarget,
        commit: COMMIT,
        artifactDigest: DIGEST,
      });
      const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(config).toMatchObject({
        vars: {
          TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY_DIGEST: managedSpaceAdmissionPolicyDigest(
            managedSpaceAdmissionPolicy,
          ),
        },
        services: [
          {
            binding: "TENANT_SPACE_ADMISSION",
            service: managedTarget.formAuthority.workerName,
            entrypoint: "TenantSpaceAdmissionEntrypoint",
          },
        ],
      });
      expect(config).not.toHaveProperty("services.0.entrypoint", "FormAuthorityEntrypoint");

      const closure = sponsorshipAuthorityBindingClosure(managedTarget, {
        commit: COMMIT,
        artifactDigest: DIGEST,
      });
      expect(closure).toMatchObject({
        TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY_DIGEST: {
          type: "plain_text",
          fields: {
            text: managedSpaceAdmissionPolicyDigest(managedSpaceAdmissionPolicy),
          },
        },
        TENANT_SPACE_ADMISSION: {
          type: "service",
          fields: {
            service: managedTarget.formAuthority.workerName,
            entrypoint: "TenantSpaceAdmissionEntrypoint",
          },
        },
      });
      expect(closure).not.toHaveProperty("FORM_AUTHORITY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts only the explicit managed closure transition for an existing sponsor", async () => {
    const transition = {
      predecessorVersionId: VERSION,
      delta: {
        retiredVars: [],
        addedVars: ["TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY_DIGEST"],
        refreshedVars: [],
        addedBindings: ["TENANT_SPACE_ADMISSION"],
        addedSecrets: [],
        rotatedSecrets: [],
      },
    } as const;
    await expect(
      inspectSponsorshipAuthority(
        "preflight",
        managedTarget,
        managedAuthorityState({
          sponsorshipBindings: versionBindings(),
        }),
        transition,
      ),
    ).resolves.toMatchObject({
      history: { versionId: VERSION },
      bindingTransitionProfile: "declared-delta-predecessor",
    });
    await expect(
      inspectSponsorshipAuthority(
        "preflight",
        managedTarget,
        managedAuthorityState({
          sponsorshipBindings: versionBindings(),
        }),
        {
          ...transition,
          delta: { ...transition.delta, addedVars: ["FOREIGN_BINDING"] },
        },
      ),
    ).rejects.toThrow("must add exactly its policy digest");
  });

  test("refuses a managed dependency with policy or named-entrypoint drift", async () => {
    await expect(
      inspectSponsorshipAuthority(
        "preflight",
        managedTarget,
        managedAuthorityState({
          formPolicy: { ...managedSpaceAdmissionPolicy, forms: [] },
        }),
      ),
    ).rejects.toThrow("exact target closure");
    await expect(
      inspectSponsorshipAuthority(
        "preflight",
        managedTarget,
        managedAuthorityState({ namedHandlers: ["FormAuthorityEntrypoint"] }),
      ),
    ).rejects.toThrow("named narrow admission entrypoint");
  });

  test("checks the managed dependency even before the sponsorship Worker exists", async () => {
    await expect(
      inspectSponsorshipAuthority(
        "preflight",
        managedTarget,
        managedAuthorityState({ sponsorshipPresent: false }),
      ),
    ).resolves.toBeNull();
    await expect(
      inspectSponsorshipAuthority(
        "preflight",
        managedTarget,
        managedAuthorityState({
          sponsorshipPresent: false,
          namedHandlers: ["FormAuthorityEntrypoint"],
        }),
      ),
    ).rejects.toThrow("named narrow admission entrypoint");
  });

  test("registers and reads back the exact target-pinned credential public key", async () => {
    let credentialRow: Awaited<ReturnType<SigningDatabase["readKey"]>> = null;
    let inserts = 0;
    const database: SigningDatabase = {
      async readKey(keyId) {
        if (keyId === target.signing.currentKeyId) return ordinarySigningRow();
        return keyId === target.sponsorshipAuthority.credentialKeyId ? credentialRow : null;
      },
      async insertPublicKey(keyId, publicJwk) {
        inserts += 1;
        credentialRow = {
          keyId,
          publicJwk,
          createdAtEpochSeconds: 2,
          revokedAtEpochSeconds: null,
        };
      },
    };

    const registered = await registerSponsorshipCredentialPublicKey(target, database);
    expect(registered.inserted).toBe(true);
    expect(registered.row).toEqual({
      keyId: target.sponsorshipAuthority.credentialKeyId,
      publicJwk: JSON.stringify(target.sponsorshipAuthority.credentialPublicJwk),
      createdAtEpochSeconds: 2,
      revokedAtEpochSeconds: null,
    });
    expect(inserts).toBe(1);
    await expect(registerSponsorshipCredentialPublicKey(target, database)).resolves.toMatchObject({
      inserted: false,
    });
    expect(inserts).toBe(1);
  });

  test("registration rejects an active next ordinary key matching either sponsorship key before insert", async () => {
    for (const [name, publicJwk] of [
      ["credential", target.sponsorshipAuthority.credentialPublicJwk],
      ["receipt", target.sponsorshipAuthority.receiptPublicJwk],
    ] as const) {
      let inserts = 0;
      const database: SigningDatabase = {
        async readKey(keyId) {
          if (keyId === targetWithNextSigningKey.signing.currentKeyId) {
            return ordinarySigningRow();
          }
          if (keyId === targetWithNextSigningKey.signing.nextKeyId) {
            return ordinarySigningRow(keyId, publicJwk);
          }
          return null;
        },
        async insertPublicKey() {
          inserts += 1;
        },
      };

      const failure = await registerSponsorshipCredentialPublicKey(
        targetWithNextSigningKey,
        database,
      ).catch((error) => error);
      expect(failure, name).toBeInstanceOf(Error);
      expect(failure.message, name).toContain("must all differ");
      expect(inserts, name).toBe(0);
    }
  });

  test("reports exact static closure but never claims rollout readiness before Hosted E2E", async () => {
    const status = await runSponsorshipAuthority(
      {
        surface: "takoserver-sponsorship-authority-worker",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      target,
      { state: authorityState(), database: sponsorshipDatabase() },
    );

    expect(status).toMatchObject({
      kind: "takoserver.sponsorship-authority-worker-status@v1",
      organizationPinned: true,
      deployedCommit: COMMIT,
      commitMatches: true,
      artifactDigest: DIGEST,
      scriptEtag: "authority-script-etag",
      method: "issueTenantRunCredential",
      maximumCredentialLifetimeSeconds: 300,
      routeMode: "service-binding-rpc-only",
      bindingClosure: "exact-d1-and-dedicated-sponsorship-keys",
      credentialKeyId: target.sponsorshipAuthority.credentialKeyId,
      credentialPublicJwk: target.sponsorshipAuthority.credentialPublicJwk,
      credentialPublicKeyRegistered: true,
      closureReady: true,
      functionalProofPending: true,
      rolloutReady: false,
    });
  });

  test("status rejects an active next ordinary key matching either sponsorship key without mutation", async () => {
    for (const [name, publicJwk] of [
      ["credential", target.sponsorshipAuthority.credentialPublicJwk],
      ["receipt", target.sponsorshipAuthority.receiptPublicJwk],
    ] as const) {
      let inserts = 0;
      const commands: string[][] = [];
      const database: SigningDatabase = {
        async readKey(keyId) {
          if (keyId === targetWithNextSigningKey.signing.currentKeyId) {
            return ordinarySigningRow();
          }
          if (keyId === targetWithNextSigningKey.signing.nextKeyId) {
            return ordinarySigningRow(keyId, publicJwk);
          }
          if (keyId === target.sponsorshipAuthority.credentialKeyId) {
            return sponsorshipCredentialRow();
          }
          return null;
        },
        async insertPublicKey() {
          inserts += 1;
        },
      };

      const failure = await runSponsorshipAuthority(
        {
          surface: "takoserver-sponsorship-authority-worker",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        targetWithNextSigningKey,
        {
          state: authorityState(),
          database,
          run: async (command) => {
            commands.push([...command]);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
      ).catch((error) => error);

      expect(failure, name).toBeInstanceOf(Error);
      expect(failure.message, name).toContain("must all differ");
      expect(inserts, name).toBe(0);
      expect(commands, name).toHaveLength(0);
    }
  });

  test("apply rejects an active next ordinary key matching either sponsorship key before insert or secret upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-sponsorship-next-key-collision-"));
    try {
      for (const [name, publicJwk] of [
        ["credential", target.sponsorshipAuthority.credentialPublicJwk],
        ["receipt", target.sponsorshipAuthority.receiptPublicJwk],
      ] as const) {
        let inserts = 0;
        const database: SigningDatabase = {
          async readKey(keyId) {
            if (keyId === targetWithNextSigningKey.signing.currentKeyId) {
              return ordinarySigningRow();
            }
            if (keyId === targetWithNextSigningKey.signing.nextKeyId) {
              return ordinarySigningRow(keyId, publicJwk);
            }
            return null;
          },
          async insertPublicKey() {
            inserts += 1;
          },
        };
        const commands: string[][] = [];
        const failure = await runSponsorshipAuthority(
          {
            surface: "takoserver-sponsorship-authority-worker",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
          },
          targetWithNextSigningKey,
          {
            state: authorityState(),
            database,
            run: async (command) => {
              commands.push([...command]);
              if (command.join(" ") === "git rev-parse HEAD") {
                return { exitCode: 0, stdout: `${COMMIT}\n`, stderr: "" };
              }
              if (command.join(" ") === "git branch --show-current") {
                return { exitCode: 0, stdout: "feature/sponsorship-authority\n", stderr: "" };
              }
              if (command.join(" ") === "git status --porcelain=v1 -z --untracked-files=all") {
                return { exitCode: 0, stdout: "", stderr: "" };
              }
              if (command.join(" ") === "bun run check") {
                return { exitCode: 0, stdout: "checked\n", stderr: "" };
              }
              if (command.includes("--dry-run")) {
                const outdir = command[command.indexOf("--outdir") + 1];
                if (!outdir) throw new Error("missing dry-run outdir");
                writeFileSync(join(outdir, "index.js"), "export default {};\n");
                return { exitCode: 0, stdout: "built\n", stderr: "" };
              }
              throw new Error(`unexpected mutation command: ${command.join(" ")}`);
            },
            review: "reviewer@example.test",
            outputDirectory: join(root, name),
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        ).catch((error) => error);

        expect(failure, name).toBeInstanceOf(Error);
        expect(failure.message, name).toContain("must all differ");
        expect(inserts, name).toBe(0);
        expect(
          commands.filter(
            (command) => command.includes("--secrets-file") && !command.includes("--dry-run"),
          ),
          name,
        ).toHaveLength(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid credential and receipt JWKs before the owner gate, build, or upload", async () => {
    const fixture = await sponsorshipSigningFixture();
    const root = mkdtempSync(join(tmpdir(), "takoserver-sponsorship-invalid-input-"));
    try {
      const credentialPath = join(root, "credential.jwk");
      const receiptPath = join(root, "receipt.jwk");
      const validCredential = `${JSON.stringify(fixture.credentialPrivateJwk)}\n`;
      const validReceipt = `${JSON.stringify(fixture.receiptPrivateJwk)}\n`;

      for (const invalid of ["credential", "receipt"] as const) {
        writeFileSync(
          credentialPath,
          invalid === "credential" ? '{"kty":"OKP"}\n' : validCredential,
          {
            mode: 0o600,
          },
        );
        writeFileSync(receiptPath, invalid === "receipt" ? '{"kty":"OKP"}\n' : validReceipt, {
          mode: 0o600,
        });
        const commands: string[][] = [];
        const failure = await runSponsorshipAuthority(
          {
            surface: "takoserver-sponsorship-authority-worker",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
          },
          fixture.target,
          {
            state: authorityState({ inspectedTarget: fixture.target }),
            database: sponsorshipDatabase(fixture.target),
            privateJwkPath: credentialPath,
            receiptPrivateJwkPath: receiptPath,
            outputDirectory: join(root, invalid),
            review: "reviewer@example.test",
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
            run: async (command) => {
              commands.push([...command]);
              const rendered = command.join(" ");
              if (rendered === "git rev-parse HEAD") {
                return { exitCode: 0, stdout: `${COMMIT}\n`, stderr: "" };
              }
              if (rendered === "git branch --show-current") {
                return { exitCode: 0, stdout: "candidate/sponsorship-authority\n", stderr: "" };
              }
              if (rendered === "git status --porcelain=v1 -z --untracked-files=all") {
                return { exitCode: 0, stdout: "", stderr: "" };
              }
              if (rendered === "bun run check") {
                return { exitCode: 0, stdout: "checked\n", stderr: "" };
              }
              if (command.includes("--dry-run")) {
                const outdirIndex = command.indexOf("--outdir");
                const outdir = outdirIndex < 0 ? undefined : command[outdirIndex + 1];
                if (outdir === undefined) throw new Error("missing dry-run outdir");
                writeFileSync(join(outdir, "index.js"), "export default {};\n");
                return { exitCode: 0, stdout: "built\n", stderr: "" };
              }
              throw new Error(`unexpected command: ${rendered}`);
            },
          },
        ).catch((error) => error);

        expect(failure, invalid).toBeInstanceOf(Error);
        expect(failure.message, invalid).toContain("private signing JWK");
        expect(
          commands.some((command) => command.join(" ") === "bun run check"),
          invalid,
        ).toBe(false);
        expect(
          commands.some((command) => command.includes("--dry-run")),
          invalid,
        ).toBe(false);
        expect(
          commands.some(
            (command) =>
              command.includes("--secrets-file") ||
              (command.includes("wrangler") && command.includes("deploy")),
          ),
          invalid,
        ).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed on every public topology or authority-closure expansion", async () => {
    const variants: readonly {
      readonly name: string;
      readonly state: SponsorshipAuthorityDeployState;
    }[] = [
      {
        name: "custom domain",
        state: authorityState({
          domains: [
            {
              hostname: "authority.example.test",
              service: target.sponsorshipAuthority.workerName,
            },
          ],
        }),
      },
      {
        name: "route",
        state: authorityState({
          routes: [
            {
              zoneId: "zone",
              id: "route",
              pattern: "authority.example.test/*",
              script: target.sponsorshipAuthority.workerName,
            },
          ],
        }),
      },
      {
        name: "workers.dev",
        state: authorityState({ subdomain: { enabled: true, previewsEnabled: false } }),
      },
      {
        name: "extra binding",
        state: authorityState({
          bindings: [
            ...versionBindings(),
            { name: "FOREIGN_AUTHORITY", type: "plain_text", text: "forbidden" },
          ],
        }),
      },
      {
        name: "extra secret",
        state: authorityState({
          secrets: [
            { name: "TAKOSERVER_SPONSORSHIP_CREDENTIAL_SIGNING_KEY", type: "secret_text" },
            { name: "FOREIGN_SECRET", type: "secret_text" },
          ],
        }),
      },
      {
        name: "non-canonical annotation",
        state: authorityState({
          annotations: {
            "workers/message": `sponsorship-authority:${COMMIT}:${DIGEST}`,
            "workers/triggered_by": "secret",
          },
        }),
      },
    ];

    for (const variant of variants) {
      await expect(
        runSponsorshipAuthority(
          {
            surface: "takoserver-sponsorship-authority-worker",
            action: "status",
            environment: "integration",
            commit: COMMIT,
          },
          target,
          { state: variant.state, database: sponsorshipDatabase() },
        ),
        variant.name,
      ).rejects.toBeInstanceOf(Error);
    }
  });
});

function managedAuthorityState(
  input: {
    readonly sponsorshipPresent?: boolean;
    readonly sponsorshipBindings?: readonly Record<string, unknown>[];
    readonly formPolicy?: unknown;
    readonly namedHandlers?: readonly string[];
  } = {},
): SponsorshipAuthorityDeployState {
  const formAuthority = managedTarget.formAuthority;
  if (formAuthority === undefined) throw new Error("managed test target has no Form authority");
  const sponsorshipPresent = input.sponsorshipPresent ?? true;
  const formVersion = managedFormVersion(
    input.formPolicy ?? managedSpaceAdmissionPolicy,
    input.namedHandlers ?? ["ensureTenantSpaceAdmission"],
  );
  return {
    async workerScripts() {
      return [
        managedTarget.workerName,
        formAuthority.identityProbeWorkerName,
        formAuthority.workerName,
        ...(sponsorshipPresent ? [managedTarget.sponsorshipAuthority.workerName] : []),
      ];
    },
    async workerDeployments(workerName) {
      if (workerName === managedTarget.workerName) {
        return [
          {
            id: "public-deployment",
            created_on: "2026-09-04T00:00:00Z",
            versions: [{ version_id: PUBLIC_VERSION, percentage: 100 }],
          },
        ];
      }
      if (workerName === formAuthority.workerName) {
        return [
          {
            id: "form-deployment",
            created_on: "2026-09-04T01:00:00Z",
            versions: [{ version_id: FORM_VERSION, percentage: 100 }],
          },
        ];
      }
      if (!sponsorshipPresent) return [];
      return [
        {
          id: "sponsorship-deployment",
          created_on: "2026-09-04T02:00:00Z",
          versions: [{ version_id: VERSION, percentage: 100 }],
        },
      ];
    },
    async workerVersion(workerName) {
      if (workerName === managedTarget.workerName) return managedPublicVersion();
      if (workerName === formAuthority.workerName) return formVersion;
      return {
        annotations: {
          "workers/message": `sponsorship-authority:${COMMIT}:${DIGEST}`,
          "workers/triggered_by": "version_upload",
        },
        resources: {
          script: { etag: "authority-script-etag" },
          bindings: input.sponsorshipBindings ?? versionBindings(managedTarget),
        },
      };
    },
    async workerSecrets(workerName) {
      if (workerName === managedTarget.sponsorshipAuthority.workerName) {
        return [
          { name: "TAKOSERVER_SPONSORSHIP_CREDENTIAL_SIGNING_KEY", type: "secret_text" },
          { name: "TAKOSERVER_SPONSORSHIP_RECEIPT_SIGNING_KEY", type: "secret_text" },
        ];
      }
      if (workerName === managedTarget.workerName) {
        return [{ name: "TAKOSERVER_SIGNING_KEY", type: "secret_text" }];
      }
      return [];
    },
    async workerDomains() {
      return [
        {
          hostname: new URL(managedTarget.publicOrigin).hostname,
          service: managedTarget.workerName,
        },
      ];
    },
    async workerRoutes() {
      return [];
    },
    async workerSubdomain() {
      return { enabled: false, previewsEnabled: false };
    },
    async workerTopologyAudit() {
      return {
        deploymentTokenIdSha256: DIGEST,
        deploymentTokenPolicySha256: PUBLIC_DIGEST,
        allZoneResourceSha256: FORM_DIGEST,
      };
    },
  };
}

function managedPublicVersion(): Record<string, unknown> {
  return {
    annotations: {
      "workers/message": `takoserver-worker:${COMMIT}:${PUBLIC_DIGEST.slice("sha256:".length)}`,
      "workers/triggered_by": "version_upload",
    },
    resources: {
      bindings: [
        { type: "ai", name: "AI" },
        { type: "version_metadata", name: "WORKER_VERSION" },
        { type: "d1", name: "STATE_DB", id: managedTarget.d1.databaseId },
        {
          type: "r2_bucket",
          name: "OBJECTS",
          bucket_name: managedTarget.r2.bucketName,
        },
        { type: "plain_text", name: "PUBLIC_ORIGIN", text: managedTarget.publicOrigin },
        {
          type: "plain_text",
          name: "TAKOSERVER_SIGNING_KEY_ID",
          text: managedTarget.signing.currentKeyId,
        },
        {
          type: "plain_text",
          name: "TAKOSERVER_WORKER_ARTIFACT_DIGEST",
          text: PUBLIC_DIGEST,
        },
        { type: "secret_text", name: "TAKOSERVER_SIGNING_KEY" },
      ],
    },
  };
}

function managedFormVersion(
  policy: unknown,
  namedHandlers: readonly string[],
): Record<string, unknown> {
  const formAuthority = managedTarget.formAuthority;
  if (formAuthority === undefined) throw new Error("managed test target has no Form authority");
  return {
    annotations: {
      "workers/message": `form-authority:takoserver-form-authority-worker:${COMMIT}:${FORM_DIGEST}`,
    },
    resources: {
      script: {
        named_handlers: [{ name: "TenantSpaceAdmissionEntrypoint", handlers: namedHandlers }],
      },
      bindings: [
        { type: "d1", name: "STATE_DB", id: managedTarget.d1.databaseId },
        {
          type: "r2_bucket",
          name: "OBJECTS",
          bucket_name: managedTarget.r2.bucketName,
        },
        {
          type: "service",
          name: "PUBLIC_HOST_IDENTITY",
          service: managedTarget.workerName,
          entrypoint: "PublicHostIdentityEntrypoint",
        },
        { type: "plain_text", name: "TAKOSERVER_ENVIRONMENT", text: managedTarget.environment },
        {
          type: "plain_text",
          name: "TAKOSERVER_FORM_AUTHORITY_HOST_ID",
          text: formAuthority.hostId,
        },
        {
          type: "plain_text",
          name: "TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST",
          text: canonicalJson(publicFormCapabilityManifest()),
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
        {
          type: "plain_text",
          name: "TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY",
          text: canonicalJson(policy),
        },
      ],
    },
  };
}

function authorityState(
  input: {
    readonly inspectedTarget?: DeployTarget;
    readonly domains?: readonly { readonly hostname: string; readonly service: string }[];
    readonly routes?: readonly {
      readonly zoneId: string;
      readonly id: string;
      readonly pattern: string;
      readonly script: string | null;
    }[];
    readonly subdomain?: { readonly enabled: boolean; readonly previewsEnabled: boolean };
    readonly bindings?: readonly Record<string, unknown>[];
    readonly secrets?: readonly unknown[];
    readonly annotations?: Readonly<Record<string, string>>;
  } = {},
): SponsorshipAuthorityDeployState {
  const inspectedTarget = input.inspectedTarget ?? target;
  const selected = inspectedTarget.sponsorshipAuthority;
  if (selected === undefined) throw new Error("test target has no sponsorship authority");
  return {
    async workerScripts() {
      return [selected.workerName];
    },
    async workerDeployments() {
      return [
        {
          id: "deployment-current",
          created_on: "2026-09-04T00:00:00Z",
          versions: [{ version_id: VERSION, percentage: 100 }],
        },
      ];
    },
    async workerVersion() {
      return {
        annotations: input.annotations ?? {
          "workers/message": `sponsorship-authority:${COMMIT}:${DIGEST}`,
          "workers/triggered_by": "version_upload",
        },
        resources: {
          script: { etag: "authority-script-etag" },
          bindings: input.bindings ?? versionBindings(inspectedTarget),
        },
      };
    },
    async workerSecrets() {
      return (
        input.secrets ?? [
          { name: "TAKOSERVER_SPONSORSHIP_CREDENTIAL_SIGNING_KEY", type: "secret_text" },
          { name: "TAKOSERVER_SPONSORSHIP_RECEIPT_SIGNING_KEY", type: "secret_text" },
        ]
      );
    },
    async workerDomains() {
      return input.domains ?? [];
    },
    async workerRoutes() {
      return input.routes ?? [];
    },
    async workerSubdomain() {
      return input.subdomain ?? { enabled: false, previewsEnabled: false };
    },
    async workerTopologyAudit() {
      return {
        deploymentTokenIdSha256: `sha256:${"a".repeat(64)}`,
        deploymentTokenPolicySha256: `sha256:${"b".repeat(64)}`,
        allZoneResourceSha256: `sha256:${"c".repeat(64)}`,
      };
    },
  };
}

function versionBindings(
  inspectedTarget: DeployTarget = target,
): readonly Record<string, unknown>[] {
  return Object.entries(
    sponsorshipAuthorityBindingClosure(inspectedTarget, { commit: COMMIT, artifactDigest: DIGEST }),
  ).flatMap(([name, requirement]) =>
    requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
  );
}

function ordinarySigningRow(
  keyId = target.signing.currentKeyId,
  publicJwk: Readonly<{ readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string }> = {
    kty: "OKP",
    crv: "Ed25519",
    x: `${"C".repeat(42)}A`,
  },
) {
  return {
    keyId,
    publicJwk: JSON.stringify(publicJwk),
    createdAtEpochSeconds: 1,
    revokedAtEpochSeconds: null,
  } as const;
}

function sponsorshipCredentialRow(inspectedTarget: DeployTarget = target) {
  const selected = inspectedTarget.sponsorshipAuthority;
  if (selected === undefined) throw new Error("test target has no sponsorship authority");
  return {
    keyId: selected.credentialKeyId,
    publicJwk: JSON.stringify(selected.credentialPublicJwk),
    createdAtEpochSeconds: 2,
    revokedAtEpochSeconds: null,
  } as const;
}

function sponsorshipDatabase(inspectedTarget: DeployTarget = target): SigningDatabase {
  const selected = inspectedTarget.sponsorshipAuthority;
  if (selected === undefined) throw new Error("test target has no sponsorship authority");
  return {
    async readKey(keyId) {
      if (keyId === target.signing.currentKeyId) return ordinarySigningRow();
      if (keyId === selected.credentialKeyId) {
        return sponsorshipCredentialRow(inspectedTarget);
      }
      return null;
    },
    async insertPublicKey() {
      throw new Error("status must not mutate the signing registry");
    },
  };
}

async function sponsorshipSigningFixture() {
  const credentialPair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const receiptPair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const credentialPrivateJwk = normalizeGeneratedEd25519PrivateJwk(
    await crypto.subtle.exportKey("jwk", credentialPair.privateKey),
  );
  const receiptPrivateJwk = normalizeGeneratedEd25519PrivateJwk(
    await crypto.subtle.exportKey("jwk", receiptPair.privateKey),
  );
  const fixtureTarget = {
    ...target,
    sponsorshipAuthority: {
      ...target.sponsorshipAuthority,
      credentialPublicJwk: {
        kty: "OKP",
        crv: "Ed25519",
        x: credentialPrivateJwk.x,
      },
      receiptPublicJwk: {
        kty: "OKP",
        crv: "Ed25519",
        x: receiptPrivateJwk.x,
      },
    },
  } satisfies DeployTarget;
  return { target: fixtureTarget, credentialPrivateJwk, receiptPrivateJwk };
}
