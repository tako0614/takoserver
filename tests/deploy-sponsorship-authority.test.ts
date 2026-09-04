import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SigningDatabase } from "../scripts/deploy/signing.ts";
import {
  assertDedicatedSponsorshipKeys,
  registerSponsorshipCredentialPublicKey,
  runSponsorshipAuthority,
  type SponsorshipAuthorityDeployState,
  sponsorshipAuthorityBindingClosure,
  writeSponsorshipAuthorityConfig,
} from "../scripts/deploy/sponsorship-authority.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";

const COMMIT = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}` as const;
const VERSION = "11111111-1111-4111-8111-111111111111";

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
    credentialPublicJwk: { kty: "OKP", crv: "Ed25519", x: "B".repeat(42) + "A" },
    receiptKeyId: "receipt-key",
    receiptPublicJwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) },
  },
} satisfies DeployTarget;

const targetWithNextSigningKey = {
  ...target,
  signing: { currentKeyId: target.signing.currentKeyId, nextKeyId: "key-next" },
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
          x: "D".repeat(42) + "A",
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

function authorityState(
  input: {
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
  return {
    async workerScripts() {
      return [target.sponsorshipAuthority.workerName];
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
          bindings: input.bindings ?? versionBindings(),
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

function versionBindings(): readonly Record<string, unknown>[] {
  return Object.entries(
    sponsorshipAuthorityBindingClosure(target, { commit: COMMIT, artifactDigest: DIGEST }),
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

function sponsorshipCredentialRow() {
  return {
    keyId: target.sponsorshipAuthority.credentialKeyId,
    publicJwk: JSON.stringify(target.sponsorshipAuthority.credentialPublicJwk),
    createdAtEpochSeconds: 2,
    revokedAtEpochSeconds: null,
  } as const;
}

function sponsorshipDatabase(): SigningDatabase {
  return {
    async readKey(keyId) {
      if (keyId === target.signing.currentKeyId) return ordinarySigningRow();
      if (keyId === target.sponsorshipAuthority.credentialKeyId) {
        return sponsorshipCredentialRow();
      }
      return null;
    },
    async insertPublicKey() {
      throw new Error("status must not mutate the signing registry");
    },
  };
}
