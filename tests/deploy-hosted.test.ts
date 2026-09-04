import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import { type HostedDatabase, type HostedProcess, runHosted } from "../scripts/deploy/hosted.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import type { SigningPublicKeyRow } from "../scripts/deploy/signing.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import {
  inspectCanonicalWorkerVersionWithScriptIdentity,
  inspectSecretCreatedDirectSuccessor,
  type WorkerState,
} from "../scripts/deploy/worker-live.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";

const COMMIT = "a".repeat(40);
const TOKEN = "hosted-token-exact";
const VERSION_C = "11111111-1111-4111-8111-111111111111";
const VERSION_H = "22222222-2222-4222-8222-222222222222";
const VERSION_INTERMEDIATE = "33333333-3333-4333-8333-333333333333";
const VERSION_RACE = "44444444-4444-4444-8444-444444444444";

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
  sponsorship: true,
} satisfies DeployTarget;

const integrationE2eTarget = {
  ...target,
  integrationE2eCredentialAuthority: {
    organizationId: "org_takosumi_hosted_staging",
    publicJwk: { kty: "OKP", crv: "Ed25519", x: `${"A".repeat(42)}A` },
  },
} satisfies DeployTarget;

async function key() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicJwk = JSON.stringify({ kty: "OKP", crv: "Ed25519", x: jwk.x });
  return { pair, publicJwk };
}

function database(
  publicJwk: string,
  overrides: Partial<SigningPublicKeyRow> = {},
): HostedDatabase & { readonly reads: number; readonly tenantReads: number } {
  let reads = 0;
  let tenantReads = 0;
  return {
    get reads() {
      return reads;
    },
    get tenantReads() {
      return tenantReads;
    },
    async readSigningKey(): Promise<SigningPublicKeyRow> {
      reads += 1;
      return {
        keyId: "key-current",
        publicJwk,
        createdAtEpochSeconds: 1,
        revokedAtEpochSeconds: null,
        ...overrides,
      };
    },
    async proofTenant() {
      tenantReads += 1;
      return "tenant-proof";
    },
  };
}

function processFixture() {
  const calls: { command: string[]; input?: string }[] = [];
  let secretPut = false;
  const run: HostedProcess = async (command, options): Promise<CommandResult> => {
    calls.push({
      command: [...command],
      ...(options?.input === undefined ? {} : { input: options.input }),
    });
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (key === "git branch --show-current") return ok("main\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (key === "git fetch --quiet origin main") return ok("");
    if (key === "git rev-parse origin/main") return ok(`${COMMIT}\n`);
    if (key === "git fetch --quiet --all --prune") return ok("");
    if (key === `git branch -r --contains ${COMMIT}`) {
      return ok("  origin/integrate/TASK-0042-takoserver-token-cutover\n");
    }
    if (command.includes("secret") && command.includes("put")) {
      secretPut = true;
      return ok("secret updated\n");
    }
    throw new Error(`unexpected command: ${key}`);
  };
  return { run, calls, mutated: () => secretPut };
}

function state(
  input: {
    readonly beforeHostedSecret: boolean;
    readonly afterHostedSecret: boolean;
  },
  mutated: () => boolean,
): WorkerState {
  return {
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: target.workerName }];
    },
    async workerDeployments() {
      return !mutated()
        ? [deployment("deployment-before", VERSION_C, "2026-08-28T01:00:00Z")]
        : [
            deployment("deployment-after", VERSION_H, "2026-08-28T02:00:00Z"),
            deployment("deployment-before", VERSION_C, "2026-08-28T01:00:00Z"),
          ];
    },
    async workerVersion(_worker, versionId) {
      const after = versionId === VERSION_H;
      const hosted = after ? input.afterHostedSecret : input.beforeHostedSecret;
      return version(
        after
          ? input.afterHostedSecret
            ? hostedSecrets()
            : baseSecrets()
          : input.beforeHostedSecret
            ? hostedSecrets()
            : baseSecrets(),
        hosted ? undefined : `takoserver-worker:${COMMIT}:${"b".repeat(64)}`,
      );
    },
    async workerSecrets() {
      const present = mutated() ? input.afterHostedSecret : input.beforeHostedSecret;
      return (present ? hostedSecrets() : baseSecrets()).map((name) => ({
        name,
        type: "secret_text",
      }));
    },
  };
}

function recoveryState(): WorkerState {
  return {
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: target.workerName }];
    },
    async workerDeployments() {
      return [
        deployment("deployment-after", VERSION_H, "2026-08-28T02:00:00Z"),
        deployment("deployment-before", VERSION_C, "2026-08-28T01:00:00Z"),
      ];
    },
    async workerVersion(_worker, versionId) {
      return version(
        versionId === VERSION_H ? hostedSecrets() : baseSecrets(),
        versionId === VERSION_H ? undefined : `takoserver-worker:${COMMIT}:${"b".repeat(64)}`,
      );
    },
    async workerSecrets() {
      return hostedSecrets().map((name) => ({ name, type: "secret_text" }));
    },
  };
}

function canonicalTokenState(selectedTarget: DeployTarget): WorkerState {
  return {
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: selectedTarget.workerName }];
    },
    async workerDeployments() {
      return [deployment("deployment-canonical-token", VERSION_H, "2026-08-28T02:00:00Z")];
    },
    async workerVersion() {
      return version(
        hostedSecrets(),
        `takoserver-worker:${COMMIT}:${"b".repeat(64)}`,
        selectedTarget,
      );
    },
    async workerSecrets() {
      return hostedSecrets().map((name) => ({ name, type: "secret_text" }));
    },
  };
}

function driftingCanonicalTokenState(
  selectedTarget: DeployTarget,
  drifted: () => boolean,
  field: "binding" | "commit" | "digest" | "domain" | "history" | "script" | "secret",
): WorkerState {
  return {
    async workerDomains() {
      return [
        {
          hostname:
            drifted() && field === "domain"
              ? "drifted.integration.example.test"
              : "api.integration.example.test",
          service: selectedTarget.workerName,
        },
      ];
    },
    async workerDeployments() {
      const raced = drifted() && field === "history";
      return [
        deployment(
          raced ? "deployment-canonical-raced" : "deployment-canonical-token",
          raced ? VERSION_RACE : VERSION_H,
          "2026-08-28T02:00:00Z",
        ),
      ];
    },
    async workerVersion() {
      const raced = drifted();
      const commit = raced && field === "commit" ? "c".repeat(40) : COMMIT;
      const digest = raced && field === "digest" ? "d".repeat(64) : "b".repeat(64);
      const current = version(
        hostedSecrets(),
        `takoserver-worker:${commit}:${digest}`,
        selectedTarget,
      );
      return {
        ...current,
        resources: {
          ...current.resources,
          script: { etag: raced && field === "script" ? "script-etag-raced" : "script-etag" },
          bindings: [
            ...current.resources.bindings,
            ...(raced && field === "binding"
              ? [{ name: "UNEXPECTED", type: "plain_text", text: "x" }]
              : []),
          ],
        },
      };
    },
    async workerSecrets() {
      return [
        ...hostedSecrets(),
        ...(drifted() && field === "secret" ? ["UNEXPECTED_SECRET"] : []),
      ].map((name) => ({ name, type: "secret_text" }));
    },
  };
}

function successorProofState(
  input: {
    readonly selectedTarget?: DeployTarget;
    readonly successorScriptEtag?: string;
    readonly successorAnnotations?: Record<string, string>;
    readonly successorExtraBinding?: Record<string, string>;
    readonly inventory?: readonly string[];
    readonly historyBefore?: readonly unknown[];
    readonly historyAfter?: readonly unknown[];
  } = {},
): WorkerState {
  let deploymentReads = 0;
  const initialHistory = input.historyBefore ?? [
    deployment("deployment-after", VERSION_H, "2026-08-28T02:00:00Z"),
    deployment("deployment-before", VERSION_C, "2026-08-28T01:00:00Z"),
  ];
  return {
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: target.workerName }];
    },
    async workerDeployments() {
      deploymentReads += 1;
      return deploymentReads === 1 ? initialHistory : (input.historyAfter ?? initialHistory);
    },
    async workerVersion(_worker, versionId) {
      if (versionId === VERSION_C) {
        return version(
          baseSecrets(),
          `takoserver-worker:${COMMIT}:${"b".repeat(64)}`,
          input.selectedTarget,
        );
      }
      const current = version(hostedSecrets(), undefined, input.selectedTarget);
      return {
        ...current,
        ...(input.successorAnnotations === undefined
          ? {}
          : { annotations: input.successorAnnotations }),
        resources: {
          ...current.resources,
          script: { etag: input.successorScriptEtag ?? "script-etag" },
          bindings: [
            ...current.resources.bindings,
            ...(input.successorExtraBinding === undefined ? [] : [input.successorExtraBinding]),
          ],
        },
      };
    },
    async workerSecrets() {
      return (input.inventory ?? hostedSecrets()).map((name) => ({ name, type: "secret_text" }));
    },
  };
}

function canonicalRaceState(raced: () => boolean): WorkerState {
  return {
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: target.workerName }];
    },
    async workerDeployments() {
      return raced()
        ? [
            deployment("deployment-raced", VERSION_RACE, "2026-08-28T02:00:00Z"),
            deployment("deployment-before", VERSION_C, "2026-08-28T01:00:00Z"),
          ]
        : [deployment("deployment-before", VERSION_C, "2026-08-28T01:00:00Z")];
    },
    async workerVersion() {
      return version(baseSecrets(), `takoserver-worker:${COMMIT}:${"b".repeat(64)}`);
    },
    async workerSecrets() {
      return baseSecrets().map((name) => ({ name, type: "secret_text" }));
    },
  };
}

function canonicalScriptRaceState(raced: () => boolean): WorkerState {
  return {
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: target.workerName }];
    },
    async workerDeployments() {
      return [deployment("deployment-before", VERSION_C, "2026-08-28T01:00:00Z")];
    },
    async workerVersion() {
      const current = version(baseSecrets(), `takoserver-worker:${COMMIT}:${"b".repeat(64)}`);
      return {
        ...current,
        resources: {
          ...current.resources,
          script: { etag: raced() ? "script-etag-raced" : "script-etag" },
        },
      };
    },
    async workerSecrets() {
      return baseSecrets().map((name) => ({ name, type: "secret_text" }));
    },
  };
}

function postProofRaceState(mutated: () => boolean, proofCompleted: () => boolean): WorkerState {
  return {
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: target.workerName }];
    },
    async workerDeployments() {
      if (!mutated()) {
        return [deployment("deployment-before", VERSION_C, "2026-08-28T01:00:00Z")];
      }
      return proofCompleted()
        ? [
            deployment("deployment-raced", VERSION_RACE, "2026-08-28T03:00:00Z"),
            deployment("deployment-after", VERSION_H, "2026-08-28T02:00:00Z"),
            deployment("deployment-before", VERSION_C, "2026-08-28T01:00:00Z"),
          ]
        : [
            deployment("deployment-after", VERSION_H, "2026-08-28T02:00:00Z"),
            deployment("deployment-before", VERSION_C, "2026-08-28T01:00:00Z"),
          ];
    },
    async workerVersion(_worker, versionId) {
      if (versionId === VERSION_C) {
        return version(baseSecrets(), `takoserver-worker:${COMMIT}:${"b".repeat(64)}`);
      }
      return version(hostedSecrets(), undefined);
    },
    async workerSecrets() {
      return (mutated() ? hostedSecrets() : baseSecrets()).map((name) => ({
        name,
        type: "secret_text",
      }));
    },
  };
}

describe("Hosted sponsorship token cutover", () => {
  test("token cutover changes only the secret, then proves the exact bearer and current signature", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-hosted-token-"));
    try {
      const signing = await key();
      const tokenPath = join(root, "hosted-token");
      writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
      const process = processFixture();
      const signingDatabase = database(signing.publicJwk);
      const requests: Request[] = [];
      const result = await runHosted(
        {
          surface: "takoserver-hosted-token-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          database: signingDatabase,
          state: state(
            {
              beforeHostedSecret: false,
              afterHostedSecret: true,
            },
            process.mutated,
          ),
          run: process.run,
          tokenPath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: sponsorshipFetcher(signing.pair.privateKey, requests),
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.hosted-token-cutover-apply@v2",
        proof: { keyId: "key-current", tenantRef: "tenant-proof" },
      });
      const mutations = process.calls.filter(
        ({ command }) => command.includes("secret") && command.includes("put"),
      );
      expect(mutations).toHaveLength(1);
      expect(mutations[0]?.input).toBe(TOKEN);
      expect(mutations[0]?.command.join(" ")).not.toContain(TOKEN);
      expect(process.calls.some(({ command }) => command.includes("--no-bundle"))).toBe(false);
      expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(signingDatabase.reads).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("integration cutover proves the bearer with the exact legacy current signing row", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-hosted-token-legacy-"));
    try {
      const signing = await key();
      const { x } = JSON.parse(signing.publicJwk) as { readonly x: string };
      const legacyPublicJwk = JSON.stringify({
        key_ops: ["verify"],
        x,
        crv: "Ed25519",
        kty: "OKP",
      });
      const tokenPath = join(root, "hosted-token");
      writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
      const process = processFixture();
      const signingDatabase = database(legacyPublicJwk);
      const requests: Request[] = [];
      const result = await runHosted(
        {
          surface: "takoserver-hosted-token-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          database: signingDatabase,
          state: state(
            {
              beforeHostedSecret: false,
              afterHostedSecret: true,
            },
            process.mutated,
          ),
          run: process.run,
          tokenPath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: sponsorshipFetcher(signing.pair.privateKey, requests),
        },
      );

      expect(result).toMatchObject({
        kind: "takoserver.hosted-token-cutover-apply@v2",
        proof: { keyId: "key-current", tenantRef: "tenant-proof" },
      });
      expect(
        process.calls.filter(
          ({ command }) => command.includes("secret") && command.includes("put"),
        ),
      ).toHaveLength(1);
      expect(requests).toHaveLength(1);
      expect(signingDatabase.reads).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cutover requalifies Worker, signing row, and proof tenant immediately before the first mutation", async () => {
    const signing = await key();
    const canonicalRow = {
      keyId: "key-current",
      publicJwk: signing.publicJwk,
      createdAtEpochSeconds: 1,
      revokedAtEpochSeconds: null,
    } satisfies SigningPublicKeyRow;

    for (const candidate of [
      "worker-history",
      "worker-script-etag",
      "signing-row",
      "proof-tenant",
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), `takoserver-hosted-requalification-${candidate}-`));
      try {
        const tokenPath = join(root, "hosted-token");
        writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
        const process = processFixture();
        let sourceQualified = false;
        let rowReads = 0;
        let tenantReads = 0;
        const run: HostedProcess = async (command, options) => {
          const result = await process.run(command, options);
          if (command.join(" ") === "git status --porcelain=v1 -z --untracked-files=all") {
            sourceQualified = true;
          }
          return result;
        };
        const signingDatabase: HostedDatabase = {
          async readSigningKey() {
            rowReads += 1;
            return candidate === "signing-row" && rowReads > 1
              ? { ...canonicalRow, createdAtEpochSeconds: 2 }
              : canonicalRow;
          },
          async proofTenant() {
            tenantReads += 1;
            return candidate === "proof-tenant" && tenantReads > 1
              ? "tenant-raced"
              : "tenant-proof";
          },
        };
        const requests: Request[] = [];
        const failure = await runHosted(
          {
            surface: "takoserver-hosted-token-cutover",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
          },
          target,
          {
            database: signingDatabase,
            state:
              candidate === "worker-history"
                ? canonicalRaceState(() => sourceQualified)
                : candidate === "worker-script-etag"
                  ? canonicalScriptRaceState(() => sourceQualified)
                  : state({ beforeHostedSecret: false, afterHostedSecret: true }, process.mutated),
            run,
            tokenPath,
            review: "reviewer@example.test",
            outputDirectory: join(root, "work"),
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
            fetcher: sponsorshipFetcher(signing.pair.privateKey, requests),
          },
        ).catch((error) => error);

        expect(failure, candidate).toBeInstanceOf(DeployError);
        expect(failure.phase, candidate).toBe("preflight");
        expect(
          process.calls.filter(
            ({ command }) => command.includes("secret") && command.includes("put"),
          ),
          candidate,
        ).toHaveLength(0);
        expect(requests, candidate).toHaveLength(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("cutover performs a final exact Hosted closure read after functional proof", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-hosted-final-read-"));
    try {
      const signing = await key();
      const tokenPath = join(root, "hosted-token");
      writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
      const process = processFixture();
      const requests: Request[] = [];
      let proofCompleted = false;
      const prove = sponsorshipFetcher(signing.pair.privateKey, requests);
      const failure = await runHosted(
        {
          surface: "takoserver-hosted-token-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          database: database(signing.publicJwk),
          state: postProofRaceState(process.mutated, () => proofCompleted),
          run: process.run,
          tokenPath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: async (input, init) => {
            const response = await prove(input, init);
            proofCompleted = true;
            return response;
          },
        },
      ).catch((error) => error);

      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("verification");
      expect(
        process.calls.filter(
          ({ command }) => command.includes("secret") && command.includes("put"),
        ),
      ).toHaveLength(1);
      expect(requests).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("integration refuses malformed legacy signing rows before putting the token", async () => {
    const signing = await key();
    const { x } = JSON.parse(signing.publicJwk) as { readonly x: string };
    const exact = { key_ops: ["verify"], x, crv: "Ed25519", kty: "OKP" };
    const exactRaw = JSON.stringify(exact);
    const candidates = [
      { name: "wrong key_ops", raw: JSON.stringify({ ...exact, key_ops: ["sign"] }) },
      { name: "extra member", raw: JSON.stringify({ ...exact, alg: "EdDSA" }) },
      { name: "noncanonical JSON", raw: JSON.stringify(exact, null, 2) },
      { name: "invalid x", raw: JSON.stringify({ ...exact, x: `${"A".repeat(42)}B` }) },
      { name: "wrong key id", raw: exactRaw, row: { keyId: "key-other" } },
      { name: "revoked row", raw: exactRaw, row: { revokedAtEpochSeconds: 2 } },
    ];

    for (const candidate of candidates) {
      const root = mkdtempSync(join(tmpdir(), "takoserver-hosted-token-refusal-"));
      try {
        const tokenPath = join(root, "hosted-token");
        writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
        const process = processFixture();
        const signingDatabase = database(candidate.raw, candidate.row);
        const requests: Request[] = [];
        let failure: unknown;
        try {
          await runHosted(
            {
              surface: "takoserver-hosted-token-cutover",
              action: "apply",
              environment: "integration",
              commit: COMMIT,
            },
            target,
            {
              database: signingDatabase,
              state: state(
                {
                  beforeHostedSecret: false,
                  afterHostedSecret: true,
                },
                process.mutated,
              ),
              run: process.run,
              tokenPath,
              review: "reviewer@example.test",
              outputDirectory: join(root, "work"),
              cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
              fetcher: sponsorshipFetcher(signing.pair.privateKey, requests),
            },
          );
        } catch (error) {
          failure = error;
        }

        expect(failure, candidate.name).toBeInstanceOf(DeployError);
        const deployError = failure as DeployError;
        expect(deployError.phase, candidate.name).toBe("preflight");
        expect(
          process.calls.filter(
            ({ command }) => command.includes("secret") && command.includes("put"),
          ),
          candidate.name,
        ).toHaveLength(0);
        expect(requests, candidate.name).toHaveLength(0);
        expect(signingDatabase.reads, candidate.name).toBe(1);
        const diagnostic = `${deployError.message}\n${deployError.detail ?? ""}`;
        expect(diagnostic, candidate.name).not.toContain(candidate.raw);
        expect(diagnostic, candidate.name).not.toContain(x);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("rehearsal and production report but cannot apply a fresh canonical C-to-H cutover", async () => {
    const signing = await key();

    for (const environment of ["rehearsal", "production"] as const) {
      const selectedTarget = { ...target, environment } satisfies DeployTarget;
      const root = mkdtempSync(join(tmpdir(), `takoserver-hosted-token-${environment}-`));
      try {
        const process = processFixture();
        const signingDatabase = database(signing.publicJwk);
        const requests: Request[] = [];
        const worker = state(
          {
            beforeHostedSecret: false,
            afterHostedSecret: true,
          },
          process.mutated,
        );
        const status = await runHosted(
          {
            surface: "takoserver-hosted-token-cutover",
            action: "status",
            environment,
            commit: COMMIT,
          },
          selectedTarget,
          {
            database: signingDatabase,
            state: worker,
            run: process.run,
            outputDirectory: join(root, "status"),
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        );
        expect(status, environment).toMatchObject({
          state: "canonical-pre-token",
          hostedTokenPresent: false,
          cutoverApplyReady: false,
          ready: false,
        });

        const failure = await runHosted(
          {
            surface: "takoserver-hosted-token-cutover",
            action: "apply",
            environment,
            commit: COMMIT,
          },
          selectedTarget,
          {
            database: signingDatabase,
            state: worker,
            run: process.run,
            tokenPath: join(root, "must-not-be-read"),
            review: "reviewer@example.test",
            outputDirectory: join(root, "apply"),
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
            fetcher: sponsorshipFetcher(signing.pair.privateKey, requests),
          },
        ).catch((error) => error);

        expect(failure, environment).toBeInstanceOf(DeployError);
        const deployError = failure as DeployError;
        expect(deployError.phase, environment).toBe("preflight");
        expect(deployError.message, environment).toContain("integration-only");
        expect(
          process.calls.filter(
            ({ command }) => command.includes("secret") && command.includes("put"),
          ),
          environment,
        ).toHaveLength(0);
        expect(requests, environment).toHaveLength(0);
        expect(process.calls, environment).toHaveLength(0);
        expect(signingDatabase.reads, environment).toBe(0);
        expect(signingDatabase.tenantReads, environment).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("rehearsal and production refuse an exact canonical-row Hosted successor for status and apply", async () => {
    const signing = await key();
    for (const environment of ["rehearsal", "production"] as const) {
      for (const action of ["status", "apply"] as const) {
        const selectedTarget = { ...target, environment } satisfies DeployTarget;
        const root = mkdtempSync(
          join(tmpdir(), `takoserver-hosted-successor-${environment}-${action}-`),
        );
        try {
          const tokenPath = join(root, "hosted-token");
          writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
          const process = processFixture();
          const signingDatabase = database(signing.publicJwk);
          const requests: Request[] = [];
          const failure = await runHosted(
            {
              surface: "takoserver-hosted-token-cutover",
              action,
              environment,
              commit: COMMIT,
            },
            selectedTarget,
            {
              database: signingDatabase,
              state: recoveryState(),
              run: process.run,
              tokenPath,
              review: "reviewer@example.test",
              outputDirectory: join(root, "work"),
              cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
              fetcher: sponsorshipFetcher(signing.pair.privateKey, requests),
            },
          ).catch((error) => error);

          expect(failure, `${environment}/${action}`).toBeInstanceOf(DeployError);
          expect(failure.phase, `${environment}/${action}`).toBe("preflight");
          expect(
            process.calls.filter(
              ({ command }) => command.includes("secret") && command.includes("put"),
            ),
            `${environment}/${action}`,
          ).toHaveLength(0);
          expect(requests, `${environment}/${action}`).toHaveLength(0);
          expect(signingDatabase.reads, `${environment}/${action}`).toBe(0);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  });

  test("rehearsal and production retain the ordinary canonical token-present status path", async () => {
    const signing = await key();
    for (const environment of ["rehearsal", "production"] as const) {
      const selectedTarget = { ...target, environment } satisfies DeployTarget;
      const result = await runHosted(
        {
          surface: "takoserver-hosted-token-cutover",
          action: "status",
          environment,
          commit: COMMIT,
        },
        selectedTarget,
        {
          database: database(signing.publicJwk),
          state: canonicalTokenState(selectedTarget),
          run: processFixture().run,
          outputDirectory: join(tmpdir(), `takoserver-canonical-token-${environment}`),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(result, environment).toMatchObject({
        state: "canonical-token-present",
        deployedCommit: COMMIT,
        hostedTokenPresent: true,
        functionalProofPending: true,
        proofApplyReady: true,
        repairRequired: false,
        ready: false,
      });
    }
  });

  test("canonical Hosted inspector passes the exact JIT provenance profile", async () => {
    const result = await inspectCanonicalWorkerVersionWithScriptIdentity(
      "preflight",
      integrationE2eTarget,
      canonicalTokenState(integrationE2eTarget),
      {
        signingKeyId: integrationE2eTarget.signing.currentKeyId,
        expectedSecrets: hostedSecrets(),
        selectedCommit: COMMIT,
        authorityProfile: {
          kind: "provenance-bound-jit",
          provenance: {
            sourceCommit: COMMIT,
            artifactDigest: `sha256:${"b".repeat(64)}`,
          },
        },
      },
    );

    expect(result).toMatchObject({
      commit: COMMIT,
      bundleDigestHex: "b".repeat(64),
      scriptEtag: "script-etag",
      history: { versionId: VERSION_H },
    });
  });

  test("canonical Hosted inspector binds a caller-selected JIT shape to canonical annotation provenance", async () => {
    const result = await inspectCanonicalWorkerVersionWithScriptIdentity(
      "preflight",
      integrationE2eTarget,
      canonicalTokenState(integrationE2eTarget),
      {
        signingKeyId: integrationE2eTarget.signing.currentKeyId,
        expectedSecrets: hostedSecrets(),
        selectedCommit: COMMIT,
        authorityProfile: { kind: "provenance-bound-jit" },
      },
    );

    expect(result).toMatchObject({
      commit: COMMIT,
      bundleDigestHex: "b".repeat(64),
      scriptEtag: "script-etag",
    });
  });

  test("Hosted status accepts a canonical Version with the target JIT authority", async () => {
    const result = await runHosted(
      {
        surface: "takoserver-hosted-token-cutover",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      integrationE2eTarget,
      {
        database: database(JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "A".repeat(43) })),
        state: canonicalTokenState(integrationE2eTarget),
        run: processFixture().run,
        outputDirectory: join(tmpdir(), "takoserver-canonical-jit-status"),
      },
    );

    expect(result).toMatchObject({
      state: "canonical-token-present",
      deployedCommit: COMMIT,
      hostedTokenPresent: true,
      proofApplyReady: true,
      repairRequired: false,
      ready: false,
    });
  });

  test("canonical token status keeps readiness pending and derives proof apply readiness only from live state", async () => {
    const signing = await key();
    for (const environment of ["integration", "rehearsal", "production"] as const) {
      const selectedTarget = { ...target, environment } satisfies DeployTarget;
      for (const [selectedCommit, proofApplyReady] of [
        [COMMIT, true],
        ["c".repeat(40), false],
      ] as const) {
        const process = processFixture();
        const signingDatabase = database(signing.publicJwk);
        const result = await runHosted(
          {
            surface: "takoserver-hosted-token-cutover",
            action: "status",
            environment,
            commit: selectedCommit,
          },
          selectedTarget,
          {
            database: signingDatabase,
            state: canonicalTokenState(selectedTarget),
            run: process.run,
            outputDirectory: join(
              tmpdir(),
              `takoserver-canonical-token-status-${environment}-${proofApplyReady}`,
            ),
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        );

        expect(result, `${environment}/${proofApplyReady}`).toMatchObject({
          state: "canonical-token-present",
          functionalProofPending: true,
          repairRequired: false,
          proofApplyReady,
          ready: false,
        });
        expect(process.calls, `${environment}/${proofApplyReady}`).toHaveLength(0);
        expect(signingDatabase.reads, `${environment}/${proofApplyReady}`).toBe(0);
        expect(signingDatabase.tenantReads, `${environment}/${proofApplyReady}`).toBe(0);
      }
    }
  });

  test("JIT-enabled Hosted recovery explicitly proves a historical pre-JIT C-to-H bridge", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-hosted-jit-recovery-"));
    try {
      const signing = await key();
      const tokenPath = join(root, "hosted-token");
      writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
      const process = processFixture();
      const requests: Request[] = [];
      const result = await runHosted(
        {
          surface: "takoserver-hosted-token-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        integrationE2eTarget,
        {
          database: database(signing.publicJwk),
          state: recoveryState(),
          run: process.run,
          tokenPath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: sponsorshipFetcher(signing.pair.privateKey, requests),
        },
      );

      expect(result).toMatchObject({
        state: "hosted-token-added-unattributed-successor",
        mutationApplied: false,
        repairRequired: true,
        previousVersionId: VERSION_C,
        versionId: VERSION_H,
      });
      expect(process.calls.filter(({ command }) => command.includes("secret"))).toHaveLength(0);
      expect(requests).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("canonical token-present proof-only apply is available in every deploy environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-canonical-token-proof-"));
    try {
      const signing = await key();
      const tokenPath = join(root, "hosted-token");
      writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
      for (const environment of ["integration", "rehearsal", "production"] as const) {
        const selectedTarget = { ...target, environment } satisfies DeployTarget;
        const process = processFixture();
        const signingDatabase = database(signing.publicJwk);
        const requests: Request[] = [];
        const result = await runHosted(
          {
            surface: "takoserver-hosted-token-cutover",
            action: "apply",
            environment,
            commit: COMMIT,
          },
          selectedTarget,
          {
            database: signingDatabase,
            state: canonicalTokenState(selectedTarget),
            run: process.run,
            tokenPath,
            review: "reviewer@example.test",
            outputDirectory: join(root, `work-${environment}`),
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
            fetcher: sponsorshipFetcher(signing.pair.privateKey, requests),
          },
        );

        expect(result, environment).toMatchObject({
          kind: "takoserver.hosted-token-cutover-apply@v2",
          state: "canonical-token-present",
          mutationApplied: false,
          functionalProofPending: false,
          repairRequired: false,
          ready: true,
          commit: COMMIT,
          reviewer: "reviewer@example.test",
          versionId: VERSION_H,
          artifactDigest: `sha256:${"b".repeat(64)}`,
          scriptContentIdentity: "script-etag",
          proof: {
            keyId: "key-current",
            publicJwkDigest: `sha256:${createHash("sha256").update(signing.publicJwk).digest("hex")}`,
            tenantRef: "tenant-proof",
            lifetimeSeconds: 60,
          },
        });
        expect(signingDatabase.reads, environment).toBe(3);
        expect(signingDatabase.tenantReads, environment).toBe(2);
        expect(requests, environment).toHaveLength(1);
        expect(
          process.calls.filter(({ command }) =>
            command.some((part) =>
              ["build", "delete", "deploy", "dry-run", "put", "upload"].includes(part),
            ),
          ),
          environment,
        ).toHaveLength(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("canonical proof uses production-strength source qualification outside integration", async () => {
    const signing = await key();
    for (const environment of ["integration", "rehearsal", "production"] as const) {
      const root = mkdtempSync(join(tmpdir(), `takoserver-canonical-source-${environment}-`));
      try {
        const tokenPath = join(root, "hosted-token");
        writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
        const process = processFixture();
        const run: HostedProcess = async (command, options) => {
          if (command.join(" ") === "git status --porcelain=v1 -z --untracked-files=all") {
            return ok(" M docs/deploy.md\0");
          }
          return await process.run(command, options);
        };
        const signingDatabase = database(signing.publicJwk);
        const requests: Request[] = [];
        const outcome = await runHosted(
          {
            surface: "takoserver-hosted-token-cutover",
            action: "apply",
            environment,
            commit: COMMIT,
          },
          { ...target, environment },
          {
            database: signingDatabase,
            state: canonicalTokenState({ ...target, environment }),
            run,
            tokenPath,
            review: "reviewer@example.test",
            outputDirectory: join(root, "work"),
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
            fetcher: sponsorshipFetcher(signing.pair.privateKey, requests),
          },
        ).catch((error) => error);

        if (environment === "integration") {
          expect(outcome, environment).toMatchObject({ ready: true, mutationApplied: false });
          expect(requests, environment).toHaveLength(1);
          expect(signingDatabase.reads, environment).toBe(3);
        } else {
          expect(outcome, environment).toBeInstanceOf(DeployError);
          expect(outcome.phase, environment).toBe("preflight");
          expect(requests, environment).toHaveLength(0);
          expect(signingDatabase.reads, environment).toBe(0);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("canonical proof refuses unqualified source, reviewer, token, D1 row, or tenant before HTTP", async () => {
    const signing = await key();
    const cases = [
      "wrong-local-source",
      "missing-remote-source",
      "deployed-source-mismatch",
      "missing-reviewer",
      "missing-token",
      "unsafe-token",
      "missing-d1-row",
      "wrong-d1-row",
      "missing-tenant",
      "wrong-tenant",
      "changed-tenant",
    ] as const;

    for (const candidate of cases) {
      const root = mkdtempSync(join(tmpdir(), `takoserver-canonical-proof-${candidate}-`));
      try {
        const tokenPath = join(root, "hosted-token");
        writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
        if (candidate === "unsafe-token") chmodSync(tokenPath, 0o644);
        const process = processFixture();
        const selectedCommit = candidate === "deployed-source-mismatch" ? "c".repeat(40) : COMMIT;
        const run: HostedProcess = async (command, options) => {
          const key = command.join(" ");
          if (candidate === "wrong-local-source" && key === "git rev-parse HEAD") {
            return ok(`${"c".repeat(40)}\n`);
          }
          if (candidate === "missing-remote-source" && command.includes("--contains")) {
            return ok("");
          }
          if (candidate === "deployed-source-mismatch") {
            if (key === "git rev-parse HEAD") return ok(`${selectedCommit}\n`);
            if (key === `git branch -r --contains ${selectedCommit}`) {
              return ok("  origin/integrate/TASK-0042-other-source\n");
            }
          }
          return await process.run(command, options);
        };
        let tenantReads = 0;
        const signingDatabase: HostedDatabase =
          candidate === "missing-d1-row"
            ? {
                async readSigningKey() {
                  return null;
                },
                async proofTenant() {
                  return "tenant-proof";
                },
              }
            : candidate === "wrong-d1-row"
              ? database(signing.publicJwk, { keyId: "key-other" })
              : {
                  async readSigningKey() {
                    return {
                      keyId: "key-current",
                      publicJwk: signing.publicJwk,
                      createdAtEpochSeconds: 1,
                      revokedAtEpochSeconds: null,
                    };
                  },
                  async proofTenant() {
                    tenantReads += 1;
                    if (candidate === "missing-tenant") return "";
                    if (candidate === "wrong-tenant") return "bad tenant";
                    if (candidate === "changed-tenant" && tenantReads > 1) return "tenant-raced";
                    return "tenant-proof";
                  },
                };
        const requests: Request[] = [];
        const failure = await runHosted(
          {
            surface: "takoserver-hosted-token-cutover",
            action: "apply",
            environment: "integration",
            commit: selectedCommit,
          },
          target,
          {
            database: signingDatabase,
            state: canonicalTokenState(target),
            run,
            tokenPath: candidate === "missing-token" ? join(root, "absent-token") : tokenPath,
            review: candidate === "missing-reviewer" ? "" : "reviewer@example.test",
            outputDirectory: join(root, "work"),
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
            fetcher: sponsorshipFetcher(signing.pair.privateKey, requests),
          },
        ).catch((error) => error);

        expect(failure, candidate).toBeInstanceOf(DeployError);
        expect(failure.phase, candidate).toBe("preflight");
        expect(requests, candidate).toHaveLength(0);
        expect(
          process.calls.filter(({ command }) =>
            command.some((part) => ["delete", "deploy", "put", "upload"].includes(part)),
          ),
          candidate,
        ).toHaveLength(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("canonical proof rejects the wrong bearer, kid, signature, claims, lifetime, status, or malformed response", async () => {
    const signing = await key();
    const otherSigning = await key();
    const cases = [
      "wrong-token",
      "wrong-kid",
      "wrong-signature",
      "wrong-claims",
      "malformed-organization",
      "malformed-jti",
      "wrong-lifetime",
      "wrong-status",
      "malformed-jwt",
      "malformed-body",
    ] as const;

    for (const candidate of cases) {
      const root = mkdtempSync(join(tmpdir(), `takoserver-canonical-jwt-${candidate}-`));
      try {
        const tokenPath = join(root, "hosted-token");
        const token = candidate === "wrong-token" ? "wrong-hosted-token" : TOKEN;
        writeFileSync(tokenPath, token, { mode: 0o600 });
        const process = processFixture();
        const requests: Request[] = [];
        const fetcher = sponsorshipFetcher(
          candidate === "wrong-signature" ? otherSigning.pair.privateKey : signing.pair.privateKey,
          requests,
          {
            ...(candidate === "wrong-kid" ? { header: { kid: "key-other" } } : {}),
            ...(candidate === "wrong-claims" ? { claims: { aud: "wrong-audience" } } : {}),
            ...(candidate === "malformed-organization" ? { claims: { organizationId: "" } } : {}),
            ...(candidate === "malformed-jti" ? { claims: { jti: "x" } } : {}),
            ...(candidate === "wrong-lifetime" ? { lifetimeSeconds: 59 } : {}),
            ...(candidate === "wrong-status" ? { status: 200 } : {}),
            ...(candidate === "malformed-jwt" ? { token: "not-a-jwt" } : {}),
            ...(candidate === "malformed-body" ? { malformedBody: true } : {}),
          },
        );
        const failure = await runHosted(
          {
            surface: "takoserver-hosted-token-cutover",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
          },
          target,
          {
            database: database(signing.publicJwk),
            state: canonicalTokenState(target),
            run: process.run,
            tokenPath,
            review: "reviewer@example.test",
            outputDirectory: join(root, "work"),
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
            fetcher,
          },
        ).catch((error) => error);

        expect(failure, candidate).toBeInstanceOf(DeployError);
        expect(failure.phase, candidate).toBe("verification");
        expect(requests, candidate).toHaveLength(1);
        expect(`${failure.message}\n${failure.detail ?? ""}`, candidate).not.toContain(token);
        expect(
          process.calls.filter(({ command }) =>
            command.some((part) => ["delete", "deploy", "put", "upload"].includes(part)),
          ),
          candidate,
        ).toHaveLength(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("canonical proof requalifies exact Worker, D1 row, and tenant immediately before HTTP", async () => {
    const signing = await key();
    const cases = [
      "history",
      "commit",
      "digest",
      "script",
      "binding",
      "secret",
      "domain",
      "d1-row",
      "tenant",
    ] as const;

    for (const candidate of cases) {
      const root = mkdtempSync(join(tmpdir(), `takoserver-canonical-pre-http-${candidate}-`));
      try {
        const tokenPath = join(root, "hosted-token");
        writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
        const process = processFixture();
        let sourceQualified = false;
        const run: HostedProcess = async (command, options) => {
          const result = await process.run(command, options);
          if (command.includes("--contains")) sourceQualified = true;
          return result;
        };
        let rowReads = 0;
        let tenantReads = 0;
        const signingDatabase: HostedDatabase = {
          async readSigningKey() {
            rowReads += 1;
            return {
              keyId: "key-current",
              publicJwk: signing.publicJwk,
              createdAtEpochSeconds: candidate === "d1-row" && rowReads > 1 ? 2 : 1,
              revokedAtEpochSeconds: null,
            };
          },
          async proofTenant() {
            tenantReads += 1;
            return candidate === "tenant" && tenantReads > 1 ? "tenant-raced" : "tenant-proof";
          },
        };
        const requests: Request[] = [];
        const failure = await runHosted(
          {
            surface: "takoserver-hosted-token-cutover",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
          },
          target,
          {
            database: signingDatabase,
            state:
              candidate === "d1-row" || candidate === "tenant"
                ? canonicalTokenState(target)
                : driftingCanonicalTokenState(target, () => sourceQualified, candidate),
            run,
            tokenPath,
            review: "reviewer@example.test",
            outputDirectory: join(root, "work"),
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
            fetcher: sponsorshipFetcher(signing.pair.privateKey, requests),
          },
        ).catch((error) => error);

        expect(failure, candidate).toBeInstanceOf(DeployError);
        expect(failure.phase, candidate).toBe("preflight");
        expect(requests, candidate).toHaveLength(0);
        expect(
          process.calls.filter(({ command }) =>
            command.some((part) => ["delete", "deploy", "put", "upload"].includes(part)),
          ),
          candidate,
        ).toHaveLength(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("canonical proof fails when final Worker closure or exact D1 row drifts after HTTP", async () => {
    const signing = await key();
    const cases = [
      "history",
      "commit",
      "digest",
      "script",
      "binding",
      "secret",
      "domain",
      "d1-row",
    ] as const;

    for (const candidate of cases) {
      const root = mkdtempSync(join(tmpdir(), `takoserver-canonical-post-http-${candidate}-`));
      try {
        const tokenPath = join(root, "hosted-token");
        writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
        const process = processFixture();
        let proofCompleted = false;
        let rowReads = 0;
        const signingDatabase: HostedDatabase = {
          async readSigningKey() {
            rowReads += 1;
            return {
              keyId: "key-current",
              publicJwk: signing.publicJwk,
              createdAtEpochSeconds: candidate === "d1-row" && rowReads > 2 ? 2 : 1,
              revokedAtEpochSeconds: null,
            };
          },
          async proofTenant() {
            return "tenant-proof";
          },
        };
        const requests: Request[] = [];
        const prove = sponsorshipFetcher(signing.pair.privateKey, requests);
        const failure = await runHosted(
          {
            surface: "takoserver-hosted-token-cutover",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
          },
          target,
          {
            database: signingDatabase,
            state:
              candidate === "d1-row"
                ? canonicalTokenState(target)
                : driftingCanonicalTokenState(target, () => proofCompleted, candidate),
            run: process.run,
            tokenPath,
            review: "reviewer@example.test",
            outputDirectory: join(root, "work"),
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
            fetcher: async (input, init) => {
              const response = await prove(input, init);
              proofCompleted = true;
              return response;
            },
          },
        ).catch((error) => error);

        expect(failure, candidate).toBeInstanceOf(DeployError);
        expect(failure.phase, candidate).toBe("verification");
        expect(requests, candidate).toHaveLength(1);
        expect(`${failure.message}\n${failure.detail ?? ""}`, candidate).not.toContain(TOKEN);
        expect(
          process.calls.filter(({ command }) =>
            command.some((part) => ["delete", "deploy", "put", "upload"].includes(part)),
          ),
          candidate,
        ).toHaveLength(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("status classifies the exact unannotated Hosted successor without mutating", async () => {
    const signing = await key();
    const process = processFixture();
    const result = await runHosted(
      {
        surface: "takoserver-hosted-token-cutover",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      target,
      {
        database: database(signing.publicJwk),
        state: recoveryState(),
        run: process.run,
        outputDirectory: join(tmpdir(), "takoserver-hosted-status-work"),
      },
    );

    expect(result).toMatchObject({
      state: "hosted-token-added-unattributed-successor",
      mutationApplied: true,
      functionalProofPending: true,
      repairRequired: true,
      ready: false,
      hostedTokenPresent: true,
      previousVersionId: VERSION_C,
      versionId: VERSION_H,
      deployedCommit: COMMIT,
      provenance: "exact-secret-created-direct-successor",
    });
    expect(process.calls).toHaveLength(0);
  });

  test("recovery proves an exact Hosted successor without putting the token again", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-hosted-token-recovery-"));
    try {
      const signing = await key();
      const tokenPath = join(root, "hosted-token");
      writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
      const process = processFixture();
      const requests: Request[] = [];
      const result = await runHosted(
        {
          surface: "takoserver-hosted-token-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          database: database(signing.publicJwk),
          state: recoveryState(),
          run: process.run,
          tokenPath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: sponsorshipFetcher(signing.pair.privateKey, requests),
        },
      );

      expect(result).toMatchObject({
        state: "hosted-token-added-unattributed-successor",
        mutationApplied: false,
        functionalProofPending: false,
        repairRequired: true,
        ready: false,
        proof: { keyId: "key-current", tenantRef: "tenant-proof" },
        reviewer: "reviewer@example.test",
      });
      expect(
        process.calls.filter(
          ({ command }) => command.includes("secret") && command.includes("put"),
        ),
      ).toHaveLength(0);
      expect(requests).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovery requires the exact source and an independent reviewer before HTTP proof", async () => {
    const signing = await key();
    for (const candidate of [
      { name: "missing reviewer", wrongHead: false, wrongRemote: false, review: undefined },
      {
        name: "wrong local source",
        wrongHead: true,
        wrongRemote: false,
        review: "reviewer@example.test",
      },
      {
        name: "missing remote source",
        wrongHead: false,
        wrongRemote: true,
        review: "reviewer@example.test",
      },
    ] as const) {
      const root = mkdtempSync(join(tmpdir(), "takoserver-hosted-recovery-qualification-"));
      try {
        const tokenPath = join(root, "hosted-token");
        writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
        const process = processFixture();
        const run: HostedProcess = async (command, options) => {
          if (candidate.wrongHead && command.join(" ") === "git rev-parse HEAD") {
            return ok(`${"c".repeat(40)}\n`);
          }
          if (candidate.wrongRemote && command.includes("--contains")) return ok("");
          return await process.run(command, options);
        };
        const requests: Request[] = [];
        const failure = await runHosted(
          {
            surface: "takoserver-hosted-token-cutover",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
          },
          target,
          {
            database: database(signing.publicJwk),
            state: recoveryState(),
            run,
            tokenPath,
            ...(candidate.review === undefined ? {} : { review: candidate.review }),
            outputDirectory: join(root, "work"),
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
            fetcher: sponsorshipFetcher(signing.pair.privateKey, requests),
          },
        ).catch((error) => error);

        expect(failure, candidate.name).toBeInstanceOf(DeployError);
        expect(failure.phase, candidate.name).toBe("preflight");
        expect(requests, candidate.name).toHaveLength(0);
        expect(
          process.calls.filter(
            ({ command }) => command.includes("secret") && command.includes("put"),
          ),
          candidate.name,
        ).toHaveLength(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("secret-created successor proof rejects changed identity, annotation, closure, inventory, and history", async () => {
    const cases = [
      {
        name: "script etag mismatch",
        state: successorProofState({ successorScriptEtag: "different-script-etag" }),
      },
      {
        name: "wrong annotation",
        state: successorProofState({ successorAnnotations: { "workers/message": "unexpected" } }),
      },
      {
        name: "extra binding",
        state: successorProofState({
          successorExtraBinding: { name: "UNEXPECTED", type: "plain_text", text: "x" },
        }),
      },
      {
        name: "extra secret",
        state: successorProofState({ inventory: [...hostedSecrets(), "UNEXPECTED_SECRET"] }),
      },
      {
        name: "non-direct predecessor",
        state: successorProofState({
          historyBefore: [
            deployment("deployment-after", VERSION_H, "2026-08-28T02:00:00Z"),
            deployment("deployment-intermediate", VERSION_INTERMEDIATE, "2026-08-28T01:30:00Z"),
            deployment("deployment-before", VERSION_C, "2026-08-28T01:00:00Z"),
          ],
        }),
      },
      {
        name: "history race",
        state: successorProofState({
          historyAfter: [
            deployment("deployment-raced", VERSION_RACE, "2026-08-28T03:00:00Z"),
            deployment("deployment-after", VERSION_H, "2026-08-28T02:00:00Z"),
            deployment("deployment-before", VERSION_C, "2026-08-28T01:00:00Z"),
          ],
        }),
      },
    ] as const;

    for (const candidate of cases) {
      const failure = await inspectSecretCreatedDirectSuccessor(
        "preflight",
        target,
        candidate.state,
        {
          addedSecret: HOSTED_SECRET,
          signingKeyId: "key-current",
          selectedCommit: COMMIT,
          expectedPredecessorVersionId: VERSION_C,
          expectedSuccessorVersionId: VERSION_H,
        },
      ).catch((error) => error);
      expect(failure, candidate.name).toBeInstanceOf(DeployError);
      const diagnostic = `${failure.message}\n${failure.detail ?? ""}`;
      expect(diagnostic, candidate.name).not.toContain(TOKEN);
    }
  });

  test("secret-created C-to-H proof passes the exact JIT provenance profile", async () => {
    const result = await inspectSecretCreatedDirectSuccessor(
      "preflight",
      integrationE2eTarget,
      successorProofState({ selectedTarget: integrationE2eTarget }),
      {
        addedSecret: HOSTED_SECRET,
        signingKeyId: integrationE2eTarget.signing.currentKeyId,
        selectedCommit: COMMIT,
        expectedPredecessorVersionId: VERSION_C,
        expectedSuccessorVersionId: VERSION_H,
        authorityProfile: {
          kind: "provenance-bound-jit",
          provenance: {
            sourceCommit: COMMIT,
            artifactDigest: `sha256:${"b".repeat(64)}`,
          },
        },
      },
    );

    expect(result).toMatchObject({
      predecessorVersionId: VERSION_C,
      successorVersionId: VERSION_H,
      predecessorCommit: COMMIT,
      predecessorBundleDigestHex: "b".repeat(64),
    });
  });

  test("secret-created C-to-H proof accepts only an explicitly pre-JIT historical profile", async () => {
    const result = await inspectSecretCreatedDirectSuccessor(
      "preflight",
      integrationE2eTarget,
      successorProofState(),
      {
        addedSecret: HOSTED_SECRET,
        signingKeyId: integrationE2eTarget.signing.currentKeyId,
        selectedCommit: COMMIT,
        expectedPredecessorVersionId: VERSION_C,
        expectedSuccessorVersionId: VERSION_H,
        authorityProfile: { kind: "historical-pre-jit" },
      },
    );

    expect(result).toMatchObject({
      predecessorVersionId: VERSION_C,
      successorVersionId: VERSION_H,
    });
  });

  test("JIT-enabled secret-created inspection refuses an omitted authority profile", async () => {
    const failure = await inspectSecretCreatedDirectSuccessor(
      "preflight",
      integrationE2eTarget,
      successorProofState({ selectedTarget: integrationE2eTarget }),
      {
        addedSecret: HOSTED_SECRET,
        signingKeyId: integrationE2eTarget.signing.currentKeyId,
        selectedCommit: COMMIT,
        expectedPredecessorVersionId: VERSION_C,
        expectedSuccessorVersionId: VERSION_H,
      },
    ).catch((error) => error);

    expect(failure).toBeInstanceOf(DeployError);
    expect(failure.message).toContain("requires an explicit authority binding profile");
  });

  test("secret transition history accepts an older rollback repeat outside the C-to-H prefix", async () => {
    const history = [
      deployment("deployment-hosted", VERSION_H, "2026-08-28T04:00:00Z"),
      deployment("deployment-canonical", VERSION_C, "2026-08-28T03:00:00Z"),
      deployment("deployment-older", VERSION_INTERMEDIATE, "2026-08-28T02:00:00Z"),
      deployment("deployment-rollback", VERSION_C, "2026-08-28T01:00:00Z"),
    ];
    const result = await inspectSecretCreatedDirectSuccessor(
      "preflight",
      target,
      successorProofState({ historyBefore: history, historyAfter: history }),
      {
        addedSecret: "TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN",
        signingKeyId: "key-current",
        selectedCommit: COMMIT,
        expectedSuccessorVersionId: VERSION_H,
      },
    );

    expect(result).toMatchObject({
      successorVersionId: VERSION_H,
      predecessorVersionId: VERSION_C,
      provenance: "exact-secret-created-direct-successor",
    });
  });

  test("secret transition history rejects a duplicate Version inside the C-to-H prefix", async () => {
    const duplicatePrefix = [
      deployment("deployment-hosted", VERSION_H, "2026-08-28T03:00:00Z"),
      deployment("deployment-duplicate", VERSION_H, "2026-08-28T02:00:00Z"),
      deployment("deployment-older", VERSION_C, "2026-08-28T01:00:00Z"),
    ];
    const failure = await inspectSecretCreatedDirectSuccessor(
      "preflight",
      target,
      successorProofState({ historyBefore: duplicatePrefix, historyAfter: duplicatePrefix }),
      {
        addedSecret: "TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN",
        signingKeyId: "key-current",
        selectedCommit: COMMIT,
        expectedSuccessorVersionId: VERSION_H,
      },
    ).catch((error) => error);

    expect(failure).toBeInstanceOf(DeployError);
    expect(failure.phase).toBe("preflight");
    expect(failure.message).toContain("C-to-H prefix contains duplicate Version IDs");
  });
});

function baseSecrets(): string[] {
  return ["TAKOSERVER_SIGNING_KEY"];
}

function hostedSecrets(): string[] {
  return ["TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN", "TAKOSERVER_SIGNING_KEY"];
}

const HOSTED_SECRET = "TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN";

function version(
  secrets: readonly string[],
  message: string | undefined,
  selectedTarget: DeployTarget = target,
) {
  const provenance =
    selectedTarget.integrationE2eCredentialAuthority === undefined
      ? {}
      : {
          authorityProfile: {
            kind: "provenance-bound-jit" as const,
            provenance: {
              sourceCommit: COMMIT,
              artifactDigest: `sha256:${"b".repeat(64)}` as const,
            },
          },
        };
  const expected = expectedExactBindingClosure(selectedTarget, {
    signingKeyId: "key-current",
    expectedSecrets: secrets,
    ...provenance,
  });
  return {
    annotations:
      message === undefined
        ? { "workers/triggered_by": "secret" }
        : { "workers/message": message, "workers/triggered_by": "version_upload" },
    resources: {
      script: { etag: "script-etag" },
      bindings: Object.entries(expected).flatMap(([name, requirement]) =>
        requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
      ),
    },
  };
}

function sponsorshipFetcher(
  privateKey: CryptoKey,
  requests: Request[],
  options: {
    readonly header?: Readonly<Record<string, unknown>>;
    readonly claims?: Readonly<Record<string, unknown>>;
    readonly status?: number;
    readonly token?: string;
    readonly malformedBody?: boolean;
    readonly lifetimeSeconds?: number;
  } = {},
) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    requests.push(request.clone());
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const issuedAt = Math.floor(Date.now() / 1_000);
    const header = encode({
      alg: "EdDSA",
      kid: "key-current",
      typ: "takoserver-token+jwt",
      ...options.header,
    });
    const payload = encode({
      aud: "takoform.run",
      exp: issuedAt + (options.lifetimeSeconds ?? 60),
      iat: issuedAt,
      iss: target.publicOrigin,
      jti: "tok_hosted-proof",
      mode: "tenant-run",
      nbf: issuedAt,
      organizationId: "org-proof",
      runRef: "deploy-hosted-proof",
      spaceRef: "deploy-hosted-proof",
      tenantRef: "tenant-proof",
      ...options.claims,
    });
    const signingInput = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(
      "Ed25519",
      privateKey,
      new TextEncoder().encode(signingInput),
    );
    if (options.malformedBody === true) {
      return new Response("{", {
        status: options.status ?? 201,
        headers: { "content-type": "application/json" },
      });
    }
    return Response.json(
      {
        takoformRunCredential: {
          token: options.token ?? `${signingInput}.${Buffer.from(signature).toString("base64url")}`,
          expiresAt: new Date((issuedAt + 60) * 1_000).toISOString(),
        },
      },
      { status: options.status ?? 201 },
    );
  };
}

function deployment(id: string, versionId: string, created: string) {
  return { id, created_on: created, versions: [{ version_id: versionId, percentage: 100 }] };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}
