import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type OperatorIdentityMigrationReader,
  runOperatorIdentity,
} from "../scripts/deploy/identity.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import type { DeployEnvironment } from "../scripts/deploy/qualification.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import type { WorkerState } from "../scripts/deploy/worker-live.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";

const COMMIT = "a".repeat(40);
const BUNDLE = "export default {fetch(){return new Response('ok')}};\n";
const BUNDLE_DIGEST = createHash("sha256").update(BUNDLE).digest("hex");
const ORGANIZATION = "org_operator_owner";
const VERSION_BEFORE = "11111111-1111-4111-8111-111111111111";
const VERSION_AFTER = "22222222-2222-4222-8222-222222222222";
const VERSION_RACED = "33333333-3333-4333-8333-333333333333";
const DEPLOYMENT_BEFORE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const DEPLOYMENT_AFTER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const DEPLOYMENT_ROLLBACK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const DEPLOYMENT_RACED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const IDENTITY = {
  kind: "takoserver.operator-sign-in-identity@v1",
  provider: "github",
  subject: "takoserver-owner",
  email: "owner@example.test",
  displayName: "Takoserver Owner",
} as const;

describe("operator identity authority", () => {
  test("status inspects integration, rehearsal and production with the same authority model", async () => {
    for (const environment of ["integration", "rehearsal", "production"] as const) {
      const selected = await authorityFixture(environment);
      try {
        const state = staticState(selected.target, versionFor(selected.target, null));
        const result = await runOperatorIdentity(
          invocation(environment, "status"),
          selected.target,
          {
            state,
            migrations: migrations(),
          },
        );
        expect(result).toMatchObject({
          kind: "takoserver.operator-identity-status@v1",
          surface: "takoserver-operator-identity",
          environment,
          state: "identity-change-required",
          selectedCommit: COMMIT,
          deployedCommit: COMMIT,
          configuredPublicJwkDigest: null,
          appliedMigrations: [],
          pendingMigrations: [],
          ownerProof: "not_performed",
          mutationApplied: false,
          ready: false,
          readyForApply: true,
        });
      } finally {
        rmSync(selected.root, { recursive: true, force: true });
      }
    }
  });

  test("keeps the legacy integration spelling integration-only", async () => {
    const integration = await authorityFixture("integration");
    try {
      await expect(
        runOperatorIdentity(
          invocation("integration", "status", "takoserver-integration-operator-identity"),
          integration.target,
          {
            state: staticState(integration.target, versionFor(integration.target, null)),
            migrations: migrations(),
          },
        ),
      ).resolves.toMatchObject({
        surface: "takoserver-integration-operator-identity",
        environment: "integration",
      });
    } finally {
      rmSync(integration.root, { recursive: true, force: true });
    }

    for (const environment of ["rehearsal", "production"] as const) {
      const selected = await authorityFixture(environment);
      try {
        await expect(
          runOperatorIdentity(
            invocation(environment, "status", "takoserver-integration-operator-identity"),
            selected.target,
            {
              state: staticState(selected.target, versionFor(selected.target, null)),
              migrations: migrations(),
            },
          ),
        ).rejects.toMatchObject({ phase: "preflight" });
      } finally {
        rmSync(selected.root, { recursive: true, force: true });
      }
    }
  });

  test("never presents provider-only production status as owner-ready", async () => {
    const selected = await authorityFixture("production");
    try {
      const status = await runOperatorIdentity(
        invocation("production", "status"),
        selected.target,
        {
          state: staticState(
            selected.target,
            versionFor(selected.target, selected.publicJwk),
            VERSION_BEFORE,
            VERSION_RACED,
          ),
          migrations: migrations(),
        },
      );
      expect(status).toMatchObject({
        state: "desired-current",
        ownerProof: "not_performed",
        configurationReady: true,
        ready: false,
        readyForApply: false,
        rollback: {
          kind: "takoserver.operator-identity-rollback-evidence@v1",
          environment: "production",
          workerName: selected.target.workerName,
          predecessorVersionId: VERSION_RACED,
          executable: false,
        },
      });
      expect(JSON.stringify(status.rollback)).not.toContain("wrangler");
    } finally {
      rmSync(selected.root, { recursive: true, force: true });
    }
  });

  test("requires UUID Worker Version identities on the authority-sensitive history", async () => {
    const selected = await authorityFixture("integration");
    try {
      await expect(
        runOperatorIdentity(invocation("integration", "status"), selected.target, {
          state: staticState(
            selected.target,
            versionFor(selected.target, null),
            "not-a-version-uuid",
          ),
          migrations: migrations(),
        }),
      ).rejects.toThrow("invalid Version ID");
    } finally {
      rmSync(selected.root, { recursive: true, force: true });
    }
  });

  test("adds only OPERATOR_IDENTITY_PUBLIC_JWK and proves the real owner identity", async () => {
    const selected = await authorityFixture("integration");
    try {
      const process = processFixture("integration");
      const state = transitionState(selected.target, null, process);
      const requests: Request[] = [];
      const result = await runOperatorIdentity(
        invocation("integration", "apply"),
        selected.target,
        {
          state,
          migrations: migrations(),
          run: process.run,
          privateJwkPath: selected.privateJwkPath,
          operatorIdentityPath: selected.identityPath,
          review: "independent-reviewer",
          outputDirectory: join(selected.root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "cloudflare-secret" },
          fetcher: ownerSessionFetcher(selected.publicKey, requests),
          now: () => new Date("2026-09-03T12:00:00.000Z"),
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.operator-identity-apply@v1",
        environment: "integration",
        organizationId: ORGANIZATION,
        transition: "add",
        predecessorVersionId: VERSION_BEFORE,
        successorVersionId: VERSION_AFTER,
        exactConfigDiff: {
          added: [{ name: "OPERATOR_IDENTITY_PUBLIC_JWK", valueDigest: expect.any(String) }],
          changed: [],
          removed: [],
        },
        ownerProof: {
          organizationId: ORGANIZATION,
          organizationRole: "owner",
          revokeStatus: 204,
          replayStatus: 401,
        },
        mutationApplied: true,
      });
      expect(result.rollback).toEqual({
        kind: "takoserver.operator-identity-rollback-evidence@v1",
        environment: "integration",
        workerName: selected.target.workerName,
        predecessorVersionId: VERSION_BEFORE,
        executable: false,
        recovery:
          "requires a freshly qualified product-owned exact-target recovery operation; no provider command is emitted",
      });
      expect(JSON.stringify(result.rollback)).not.toContain("wrangler");
      expect(process.uploads).toBe(1);
      expect(process.rollbacks).toBe(0);
      expect(
        requests.map((request) => `${request.method} ${new URL(request.url).pathname}`),
      ).toEqual([
        "POST /v1/operator-owner-proof",
        "POST /v1/sessions",
        "GET /v1/me",
        "DELETE /v1/session",
        "GET /v1/me",
      ]);
      const rendered = JSON.stringify(result);
      expect(rendered).not.toContain(selected.privateJwk.d);
      expect(rendered).not.toContain(selected.privateJwkPath);
      expect(rendered).not.toContain(selected.identityPath);
      expect(rendered).not.toContain("session-secret");
    } finally {
      rmSync(selected.root, { recursive: true, force: true });
    }
  });

  test("rotates a different valid operator JWK but refuses an exact no-op", async () => {
    const selected = await authorityFixture("rehearsal");
    const old = await publicKey();
    try {
      const process = processFixture("rehearsal");
      const result = await runOperatorIdentity(invocation("rehearsal", "apply"), selected.target, {
        state: transitionState(selected.target, old.publicJwk, process),
        migrations: migrations(),
        run: process.run,
        privateJwkPath: selected.privateJwkPath,
        operatorIdentityPath: selected.identityPath,
        review: "independent-reviewer",
        outputDirectory: join(selected.root, "change-work"),
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "cloudflare-secret" },
        fetcher: ownerSessionFetcher(selected.publicKey, []),
      });
      expect(result).toMatchObject({
        transition: "change",
        exactConfigDiff: {
          added: [],
          changed: [
            {
              name: "OPERATOR_IDENTITY_PUBLIC_JWK",
              previousValueDigest: sha256(JSON.stringify(old.publicJwk)),
              valueDigest: sha256(JSON.stringify(selected.target.operatorIdentity?.publicJwk)),
            },
          ],
          removed: [],
        },
      });

      const noOpProcess = processFixture("rehearsal");
      const failure = await runOperatorIdentity(invocation("rehearsal", "apply"), selected.target, {
        state: staticState(selected.target, versionFor(selected.target, selected.publicJwk)),
        migrations: migrations(),
        run: noOpProcess.run,
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "cloudflare-secret" },
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ phase: "preflight" });
      expect((failure as Error).message).toContain("already exact");
      expect(noOpProcess.calls).toEqual([]);
    } finally {
      rmSync(selected.root, { recursive: true, force: true });
    }
  });

  test("refuses pending migrations before qualification, proof or upload", async () => {
    const selected = await authorityFixture("production");
    try {
      const process = processFixture("production");
      const failure = await runOperatorIdentity(
        invocation("production", "apply"),
        selected.target,
        {
          state: staticState(selected.target, versionFor(selected.target, null)),
          migrations: migrations(["0043_pending.sql"]),
          run: process.run,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "cloudflare-secret" },
        },
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ phase: "preflight" });
      expect((failure as Error).message).toContain("pending D1 migrations");
      expect(process.calls).toEqual([]);
    } finally {
      rmSync(selected.root, { recursive: true, force: true });
    }
  });

  test("refuses owner mismatch after upload and rolls production back to the exact predecessor", async () => {
    const selected = await authorityFixture("production");
    const old = await publicKey();
    try {
      const process = processFixture("production");
      const state = transitionState(selected.target, old.publicJwk, process);
      const requests: Request[] = [];
      const failure = await runOperatorIdentity(
        invocation("production", "apply"),
        selected.target,
        {
          state,
          migrations: migrations(),
          run: process.run,
          privateJwkPath: selected.privateJwkPath,
          operatorIdentityPath: selected.identityPath,
          review: "independent-reviewer",
          outputDirectory: join(selected.root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "cloudflare-secret" },
          fetcher: ownerSessionFetcher(selected.publicKey, requests, { owner: false }),
        },
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ phase: "verification" });
      expect((failure as Error).message).toContain("rolled back");
      expect(String((failure as { detail?: string }).detail)).toContain(VERSION_BEFORE);
      expect(String((failure as { detail?: string }).detail)).toContain(VERSION_AFTER);
      expect(process.productionQualified).toBe(true);
      expect(process.uploads).toBe(1);
      expect(process.rollbacks).toBe(1);
      expect(state.stage()).toBe("rollback");
      expect(
        requests.map((request) => `${request.method} ${new URL(request.url).pathname}`),
      ).toEqual(["POST /v1/operator-owner-proof"]);
    } finally {
      rmSync(selected.root, { recursive: true, force: true });
    }
  });

  test("refuses rollback without mutation when the proved successor history drifts", async () => {
    const selected = await authorityFixture("production");
    const old = await publicKey();
    try {
      const process = processFixture("production");
      const state = transitionState(selected.target, old.publicJwk, process);
      const failure = await runOperatorIdentity(
        invocation("production", "apply"),
        selected.target,
        {
          state,
          migrations: migrations(),
          run: process.run,
          privateJwkPath: selected.privateJwkPath,
          operatorIdentityPath: selected.identityPath,
          review: "independent-reviewer",
          outputDirectory: join(selected.root, "drift-work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "cloudflare-secret" },
          fetcher: ownerSessionFetcher(selected.publicKey, [], {
            owner: false,
            onOwnerProof: state.advanceToDrift,
          }),
        },
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ phase: "verification" });
      expect((failure as Error).message).toContain("rollback was refused");
      expect((failure as Error).message).toContain("indeterminate");
      const detail = JSON.parse(String((failure as { detail?: string }).detail)) as Record<
        string,
        unknown
      >;
      expect(detail).toMatchObject({
        primary: {
          phase: "verification",
          message: expect.stringContaining("does not own"),
        },
        rollback: "not_performed",
        expectedSuccessorVersionId: VERSION_AFTER,
        observedVersionId: VERSION_AFTER,
        expectedHistoryDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        observedHistoryDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      });
      expect(detail.observedHistoryDigest).not.toBe(detail.expectedHistoryDigest);
      expect(process.uploads).toBe(1);
      expect(process.rollbacks).toBe(0);
      expect(state.stage()).toBe("drift");
      expect(JSON.stringify(failure)).not.toContain("cloudflare-secret");
      expect(JSON.stringify(failure)).not.toContain(selected.privateJwk.d);
    } finally {
      rmSync(selected.root, { recursive: true, force: true });
    }
  });

  test("refuses rollback when history advances during the rollback closure inspection", async () => {
    const selected = await authorityFixture("production");
    const old = await publicKey();
    try {
      const process = processFixture("production");
      const state = transitionState(selected.target, old.publicJwk, process);
      const failure = await runOperatorIdentity(
        invocation("production", "apply"),
        selected.target,
        {
          state,
          migrations: migrations(),
          run: process.run,
          privateJwkPath: selected.privateJwkPath,
          operatorIdentityPath: selected.identityPath,
          review: "independent-reviewer",
          outputDirectory: join(selected.root, "closure-race-work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "cloudflare-secret" },
          fetcher: ownerSessionFetcher(selected.publicKey, [], {
            owner: false,
            onOwnerProof: state.advanceDuringNextSuccessorClosure,
          }),
        },
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ phase: "verification" });
      expect((failure as Error).message).toContain("rollback was refused");
      expect((failure as Error).message).toContain("indeterminate");
      const detail = JSON.parse(String((failure as { detail?: string }).detail)) as Record<
        string,
        unknown
      >;
      expect(detail).toMatchObject({
        primary: {
          phase: "verification",
          message: expect.stringContaining("does not own"),
        },
        rollback: "not_performed",
        expectedSuccessorVersionId: VERSION_AFTER,
        observedVersionId: VERSION_AFTER,
        expectedHistoryDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        observedHistoryDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      });
      expect(detail.observedHistoryDigest).not.toBe(detail.expectedHistoryDigest);
      expect(process.uploads).toBe(1);
      expect(process.rollbacks).toBe(0);
      expect(state.stage()).toBe("drift");
      expect(JSON.stringify(failure)).not.toContain("cloudflare-secret");
      expect(JSON.stringify(failure)).not.toContain(selected.privateJwk.d);
    } finally {
      rmSync(selected.root, { recursive: true, force: true });
    }
  });

  test("refuses closure drift and closes the pre-upload Version race", async () => {
    const selected = await authorityFixture("integration");
    try {
      const drifted = structuredClone(versionFor(selected.target, null)) as {
        resources: { bindings: Record<string, unknown>[] };
      };
      drifted.resources.bindings.push({
        name: "UNRELATED_CONFIGURATION",
        type: "plain_text",
        text: "must-not-survive",
      });
      const drift = await runOperatorIdentity(
        invocation("integration", "status"),
        selected.target,
        {
          state: staticState(selected.target, drifted),
          migrations: migrations(),
        },
      ).catch((error: unknown) => error);
      expect(drift).toMatchObject({ phase: "preflight" });
      expect((drift as Error).message).toContain("exact selected target closure");

      const process = processFixture("integration");
      const race = await runOperatorIdentity(invocation("integration", "apply"), selected.target, {
        state: racingState(selected.target),
        migrations: migrations(),
        run: process.run,
        privateJwkPath: selected.privateJwkPath,
        operatorIdentityPath: selected.identityPath,
        review: "independent-reviewer",
        outputDirectory: join(selected.root, "race-work"),
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "cloudflare-secret" },
      }).catch((error: unknown) => error);
      expect(race).toMatchObject({ phase: "preflight" });
      expect((race as Error).message).toContain("changed during operator identity qualification");
      expect(process.uploads).toBe(0);
    } finally {
      rmSync(selected.root, { recursive: true, force: true });
    }
  });

  test("settles a lost upload acknowledgement through status without a blind retry", async () => {
    const selected = await authorityFixture("rehearsal");
    try {
      const process = processFixture("rehearsal", { uploadFails: true });
      const failure = await runOperatorIdentity(invocation("rehearsal", "apply"), selected.target, {
        state: staticState(selected.target, versionFor(selected.target, null)),
        migrations: migrations(),
        run: process.run,
        privateJwkPath: selected.privateJwkPath,
        operatorIdentityPath: selected.identityPath,
        review: "independent-reviewer",
        outputDirectory: join(selected.root, "work"),
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "cloudflare-secret" },
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ phase: "mutation" });
      expect((failure as Error).message).toContain("do not retry before --status");
      expect(String((failure as { detail?: string }).detail)).not.toContain("cloudflare-secret");
      expect(process.uploads).toBe(1);

      const status = await runOperatorIdentity(invocation("rehearsal", "status"), selected.target, {
        state: staticState(
          selected.target,
          versionFor(selected.target, selected.publicJwk),
          VERSION_AFTER,
          VERSION_BEFORE,
        ),
        migrations: migrations(),
      });
      expect(status).toMatchObject({
        state: "desired-current",
        successorVersionId: VERSION_AFTER,
        predecessorVersionId: VERSION_BEFORE,
        ownerProof: "not_performed",
        ready: true,
        readyForApply: false,
      });
      expect(process.uploads).toBe(1);
    } finally {
      rmSync(selected.root, { recursive: true, force: true });
    }
  });
});

function invocation(
  environment: DeployEnvironment,
  action: "status" | "apply",
  surface:
    | "takoserver-operator-identity"
    | "takoserver-integration-operator-identity" = "takoserver-operator-identity",
) {
  return {
    surface,
    action,
    environment,
    commit: COMMIT,
    organizationId: ORGANIZATION,
  };
}

async function authorityFixture(environment: DeployEnvironment) {
  const root = mkdtempSync(join(tmpdir(), `takoserver-identity-${environment}-`));
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey & {
    x: string;
    d: string;
  };
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & {
    x: string;
  };
  const exactPublicJwk = {
    kty: "OKP" as const,
    crv: "Ed25519" as const,
    x: publicJwk.x,
  };
  const privateJwkPath = join(root, "operator.jwk");
  writeFileSync(privateJwkPath, JSON.stringify(privateJwk), { mode: 0o600 });
  chmodSync(privateJwkPath, 0o600);
  const identityPath = join(root, "operator-identity.json");
  writeFileSync(identityPath, JSON.stringify(IDENTITY), { mode: 0o600 });
  chmodSync(identityPath, 0o600);
  const target = targetFor(environment, exactPublicJwk);
  return {
    root,
    target,
    privateJwk,
    privateJwkPath,
    identityPath,
    publicJwk: exactPublicJwk,
    publicKey: pair.publicKey,
  };
}

function targetFor(
  environment: DeployEnvironment,
  publicJwk: { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string },
): DeployTarget {
  return {
    kind: "takoserver.deploy-target@v2",
    environment,
    accountId: "a".repeat(32),
    workerName: `takoserver-api-${environment}`,
    d1: {
      databaseName: `takoserver-runtime-${environment}`,
      databaseId: "00000000-0000-4000-8000-000000000000",
    },
    r2: { bucketName: `takoserver-objects-${environment}` },
    publicOrigin: `https://api.${environment}.example.test`,
    signing: { currentKeyId: "key-current" },
    operatorIdentity: { publicJwk },
  };
}

async function publicKey() {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & {
    x: string;
  };
  return {
    publicJwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: publicJwk.x },
  };
}

function migrations(pending: readonly string[] = []): OperatorIdentityMigrationReader {
  return {
    async read() {
      return { local: [...pending], applied: [] };
    },
  };
}

interface ProcessFixture {
  readonly calls: readonly string[][];
  readonly run: (command: readonly string[]) => Promise<CommandResult>;
  readonly uploads: number;
  readonly rollbacks: number;
  readonly productionQualified: boolean;
  onUpload?: () => void;
  onRollback?: () => void;
}

function processFixture(
  environment: DeployEnvironment,
  options: { readonly uploadFails?: boolean } = {},
): ProcessFixture {
  const calls: string[][] = [];
  let uploads = 0;
  let rollbacks = 0;
  let productionQualified = false;
  const fixture: ProcessFixture = {
    calls,
    get uploads() {
      return uploads;
    },
    get rollbacks() {
      return rollbacks;
    },
    get productionQualified() {
      return productionQualified;
    },
    async run(command) {
      calls.push([...command]);
      const key = command.join(" ");
      if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
      if (key === "git branch --show-current") return ok("feature/operator-identity\n");
      if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
      if (key === "git fetch --quiet --all --prune") {
        productionQualified = true;
        return ok("");
      }
      if (key === `git branch -r --contains ${COMMIT}`) return ok("  origin/main\n");
      if (key === "bun run check") return ok("checked\n");
      if (command.includes("--dry-run")) {
        const out = command[command.indexOf("--outdir") + 1];
        if (!out) throw new Error("missing build outdir");
        writeFileSync(join(out, "index.js"), BUNDLE);
        return ok("built\n");
      }
      if (command.includes("--no-bundle")) {
        uploads += 1;
        fixture.onUpload?.();
        return options.uploadFails
          ? { exitCode: 1, stdout: "", stderr: "cloudflare-secret acknowledgement lost" }
          : ok("uploaded\n");
      }
      if (command.includes("versions") && command.includes("deploy")) {
        rollbacks += 1;
        fixture.onRollback?.();
        return ok("rolled back\n");
      }
      throw new Error(`unexpected command for ${environment}: ${key}`);
    },
  };
  return fixture;
}

interface TransitionState extends WorkerState {
  stage(): "before" | "successor" | "rollback" | "drift";
  advanceToDrift(): void;
  advanceDuringNextSuccessorClosure(): void;
}

function transitionState(
  target: DeployTarget,
  previous: NonNullable<DeployTarget["operatorIdentity"]>["publicJwk"] | null,
  process: ProcessFixture,
): TransitionState {
  let stage: "before" | "successor" | "rollback" | "drift" = "before";
  let advanceDuringNextSuccessorClosure = false;
  process.onUpload = () => {
    stage = "successor";
  };
  process.onRollback = () => {
    stage = "rollback";
  };
  return {
    stage: () => stage,
    advanceToDrift: () => {
      stage = "drift";
    },
    advanceDuringNextSuccessorClosure: () => {
      advanceDuringNextSuccessorClosure = true;
    },
    async workerDeployments() {
      if (stage === "successor") {
        return [
          deployment(DEPLOYMENT_AFTER, VERSION_AFTER, "2026-09-03T02:00:00Z"),
          deployment(DEPLOYMENT_BEFORE, VERSION_BEFORE, "2026-09-03T01:00:00Z"),
        ];
      }
      if (stage === "rollback") {
        return [
          deployment(DEPLOYMENT_ROLLBACK, VERSION_BEFORE, "2026-09-03T03:00:00Z"),
          deployment(DEPLOYMENT_AFTER, VERSION_AFTER, "2026-09-03T02:00:00Z"),
        ];
      }
      if (stage === "drift") {
        return [
          deployment(DEPLOYMENT_AFTER, VERSION_AFTER, "2026-09-03T02:00:00Z"),
          deployment(DEPLOYMENT_BEFORE, VERSION_BEFORE, "2026-09-03T01:00:00Z"),
          deployment(DEPLOYMENT_RACED, VERSION_RACED, "2026-09-03T00:30:00Z"),
        ];
      }
      return [deployment(DEPLOYMENT_BEFORE, VERSION_BEFORE, "2026-09-03T01:00:00Z")];
    },
    async workerVersion(_worker, versionId) {
      return versionFor(
        target,
        versionId === VERSION_AFTER || versionId === VERSION_RACED
          ? (target.operatorIdentity?.publicJwk ?? null)
          : previous,
      );
    },
    async workerSecrets() {
      if (advanceDuringNextSuccessorClosure && stage === "successor") {
        advanceDuringNextSuccessorClosure = false;
        stage = "drift";
      }
      return [{ name: "TAKOSERVER_SIGNING_KEY", type: "secret_text" }];
    },
    async workerDomains() {
      return [{ hostname: new URL(target.publicOrigin).hostname, service: target.workerName }];
    },
  };
}

function racingState(target: DeployTarget): WorkerState {
  let reads = 0;
  return {
    async workerDeployments() {
      reads += 1;
      return reads === 1
        ? [deployment(DEPLOYMENT_BEFORE, VERSION_BEFORE, "2026-09-03T01:00:00Z")]
        : [
            deployment(DEPLOYMENT_RACED, VERSION_RACED, "2026-09-03T01:30:00Z"),
            deployment(DEPLOYMENT_BEFORE, VERSION_BEFORE, "2026-09-03T01:00:00Z"),
          ];
    },
    async workerVersion() {
      return versionFor(target, null);
    },
    async workerSecrets() {
      return [{ name: "TAKOSERVER_SIGNING_KEY", type: "secret_text" }];
    },
    async workerDomains() {
      return [{ hostname: new URL(target.publicOrigin).hostname, service: target.workerName }];
    },
  };
}

function staticState(
  target: DeployTarget,
  workerVersion: unknown,
  versionId = VERSION_BEFORE,
  previousVersionId: string | null = null,
): WorkerState {
  return {
    async workerDeployments() {
      return [
        deployment(DEPLOYMENT_AFTER, versionId, "2026-09-03T02:00:00Z"),
        ...(previousVersionId === null
          ? []
          : [deployment(DEPLOYMENT_BEFORE, previousVersionId, "2026-09-03T01:00:00Z")]),
      ];
    },
    async workerVersion() {
      return workerVersion;
    },
    async workerSecrets() {
      return [{ name: "TAKOSERVER_SIGNING_KEY", type: "secret_text" }];
    },
    async workerDomains() {
      return [{ hostname: new URL(target.publicOrigin).hostname, service: target.workerName }];
    },
  };
}

function versionFor(
  target: DeployTarget,
  publicJwk: NonNullable<DeployTarget["operatorIdentity"]>["publicJwk"] | null,
) {
  const selected =
    publicJwk === null
      ? withoutOperatorIdentity(target)
      : { ...target, operatorIdentity: { publicJwk } };
  const expected = expectedExactBindingClosure(selected, {
    signingKeyId: target.signing.currentKeyId,
  });
  return {
    annotations: {
      "workers/message": `takoserver-worker:${COMMIT}:${BUNDLE_DIGEST}`,
      "workers/triggered_by": "version_upload",
    },
    resources: {
      bindings: Object.entries(expected).flatMap(([name, requirement]) =>
        requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
      ),
    },
  };
}

function withoutOperatorIdentity(target: DeployTarget): DeployTarget {
  const { operatorIdentity: _operatorIdentity, ...without } = target;
  return without;
}

function ownerSessionFetcher(
  publicKey: CryptoKey,
  requests: Request[],
  options: { readonly owner?: boolean; readonly onOwnerProof?: () => void } = {},
) {
  let revoked = false;
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const path = new URL(request.url).pathname;
    if (
      request.method === "POST" &&
      (path === "/v1/operator-owner-proof" || path === "/v1/sessions")
    ) {
      const body = (await request.json()) as Record<string, unknown>;
      const assertion = String(body.assertion ?? "");
      const [payload, signature] = assertion.split(".");
      if (!payload || !signature) return new Response(null, { status: 401 });
      const valid = await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        Buffer.from(signature, "base64url"),
        new TextEncoder().encode(payload),
      );
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
        string,
        unknown
      >;
      if (
        !valid ||
        body.provider !== IDENTITY.provider ||
        body.method !== "operator-assertion" ||
        claims.aud !== new URL(request.url).origin ||
        claims.provider !== IDENTITY.provider ||
        claims.subject !== IDENTITY.subject ||
        claims.email !== IDENTITY.email ||
        claims.displayName !== IDENTITY.displayName ||
        Number(claims.exp) - Number(claims.iat) !== 60
      ) {
        return new Response(null, { status: 401 });
      }
      if (path === "/v1/operator-owner-proof") {
        options.onOwnerProof?.();
        if (options.owner === false) {
          return Response.json({ error: { code: "not_found" } }, { status: 404 });
        }
        return Response.json({
          principal: principal(),
          organization: {
            id: ORGANIZATION,
            name: "Operator organization",
            ownerPrincipalId: "prn_operator_owner",
            createdAt: "2026-09-03T11:00:00.000Z",
          },
        });
      }
      return Response.json({ principal: principal(), sessionToken: "session-secret" });
    }
    if (request.method === "GET" && path === "/v1/me") {
      if (revoked) return new Response(null, { status: 401 });
      return Response.json({
        principal: principal(),
        organizations: [
          {
            id: ORGANIZATION,
            name: "Operator organization",
            ownerPrincipalId: options.owner === false ? "prn_somebody_else" : "prn_operator_owner",
            createdAt: "2026-09-03T11:00:00.000Z",
          },
        ],
      });
    }
    if (request.method === "DELETE" && path === "/v1/session") {
      revoked = true;
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  };
}

function principal() {
  return {
    id: "prn_operator_owner",
    provider: IDENTITY.provider,
    providerSubject: IDENTITY.subject,
    email: IDENTITY.email,
    displayName: IDENTITY.displayName,
  };
}

function deployment(id: string, versionId: string, created: string) {
  return { id, created_on: created, versions: [{ version_id: versionId, percentage: 100 }] };
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
