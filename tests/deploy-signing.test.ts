import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import {
  activePublicJwk,
  runSigning,
  type SigningDatabase,
  type SigningProcess,
  type SigningPublicKeyRow,
} from "../scripts/deploy/signing.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { type WorkerState, workerVersionAnnotationProfile } from "../scripts/deploy/worker-live.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";
import { normalizeGeneratedEd25519PrivateJwk } from "../src/ed25519-private-jwk.ts";

const COMMIT = "a".repeat(40);
const BUNDLE = "export default {fetch(){return new Response('ok')}};\n";
const BUNDLE_DIGEST = createHash("sha256").update(BUNDLE).digest("hex");
const VERSION_C = "11111111-1111-4111-8111-111111111111";
const VERSION_S = "33333333-3333-4333-8333-333333333333";

const baseTarget = {
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
} satisfies DeployTarget;

const integrationE2eTarget = {
  ...baseTarget,
  integrationE2eCredentialAuthority: {
    organizationId: "org_takosumi_hosted_staging",
    publicJwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) },
  },
} satisfies DeployTarget;

class FakeDatabase implements SigningDatabase {
  readonly rows = new Map<string, SigningPublicKeyRow>();
  readonly inserts: { keyId: string; publicJwk: string }[] = [];
  readonly reads: { keyId: string; phase: "preflight" | "mutation" | "verification" }[] = [];

  async readKey(
    keyId: string,
    phase: "preflight" | "mutation" | "verification",
  ): Promise<SigningPublicKeyRow | null> {
    this.reads.push({ keyId, phase });
    return this.rows.get(keyId) ?? null;
  }

  async insertPublicKey(keyId: string, publicJwk: string): Promise<void> {
    this.inserts.push({ keyId, publicJwk });
    if (this.rows.has(keyId)) throw new Error("duplicate");
    this.rows.set(keyId, {
      keyId,
      publicJwk,
      createdAtEpochSeconds: 1,
      revokedAtEpochSeconds: null,
    });
  }
}

async function keyPair(keyId: string) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateJwk = normalizeGeneratedEd25519PrivateJwk(
    await crypto.subtle.exportKey("jwk", pair.privateKey),
  );
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicJwk = JSON.stringify({ kty: "OKP", crv: "Ed25519", x: exported.x });
  return { keyId, pair, privateJwk, publicJwk };
}

function sponsoredTarget(input: {
  readonly credentialPublicJwk: string;
  readonly receiptPublicJwk: string;
  readonly signing?: DeployTarget["signing"];
}): DeployTarget {
  return {
    ...baseTarget,
    sponsorshipAuthority: {
      workerName: "takoserver-sponsorship-authority",
      organizationId: "org_hosted",
      credentialKeyId: "sponsorship-credential-key",
      credentialPublicJwk: JSON.parse(input.credentialPublicJwk),
      receiptKeyId: "sponsorship-receipt-key",
      receiptPublicJwk: JSON.parse(input.receiptPublicJwk),
    },
    signing: input.signing ?? baseTarget.signing,
  };
}

function processFixture(input: { readonly afterMessage?: () => string | null } = {}) {
  const calls: { command: string[]; input?: string }[] = [];
  const run: SigningProcess = async (command, options): Promise<CommandResult> => {
    calls.push({
      command: [...command],
      ...(options?.input === undefined ? {} : { input: options.input }),
    });
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (key === "git branch --show-current") return ok("feature/signing\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (command.includes("--dry-run")) {
      const out = command[command.indexOf("--outdir") + 1];
      if (!out) throw new Error("missing outdir");
      writeFileSync(join(out, "index.js"), BUNDLE);
      return ok("built\n");
    }
    if (command.includes("secret") && command.includes("put")) return ok("secret updated\n");
    if (command.includes("deploy") && command.includes("--secrets-file")) {
      return ok(input.afterMessage?.() ?? "uploaded\n");
    }
    throw new Error(`unexpected command: ${key}`);
  };
  return { run, calls };
}

function workerState(input: {
  readonly target: DeployTarget;
  readonly beforeSigning: string;
  readonly afterSigning?: string;
  readonly afterMessage?: () => string | null;
  readonly afterHasPredecessor?: boolean;
  readonly beforeMessage?: string;
  readonly beforeAnnotations?: Readonly<Record<string, string>>;
  readonly afterAnnotations?: Readonly<Record<string, string>>;
  readonly beforeScriptEtag?: string;
  readonly afterScriptEtag?: string;
  readonly afterWhen?: () => boolean;
  readonly deploymentMode?: "advance" | "before" | "after";
}): WorkerState {
  let historyReads = 0;
  return {
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: input.target.workerName }];
    },
    async workerDeployments() {
      historyReads += 1;
      const after =
        input.deploymentMode === "after" ||
        (input.afterWhen?.() ??
          ((input.deploymentMode ?? "advance") === "advance" && historyReads > 1));
      return !after
        ? [deployment("deployment-before", VERSION_C, "2026-08-28T01:00:00Z")]
        : [
            deployment("deployment-after", VERSION_S, "2026-08-28T02:00:00Z"),
            ...(input.afterHasPredecessor === false
              ? []
              : [deployment("deployment-before", VERSION_C, "2026-08-28T01:00:00Z")]),
          ];
    },
    async workerVersion(_worker, versionId) {
      const signing =
        versionId === VERSION_C ? input.beforeSigning : (input.afterSigning ?? input.beforeSigning);
      const message =
        versionId === VERSION_C
          ? (input.beforeMessage ?? `takoserver-worker:${COMMIT}:${BUNDLE_DIGEST}`)
          : (input.afterMessage?.() ?? `takoserver-worker:${COMMIT}:${BUNDLE_DIGEST}`);
      const scriptEtag =
        versionId === VERSION_C
          ? (input.beforeScriptEtag ?? "script-etag")
          : (input.afterScriptEtag ?? "script-etag");
      const current = workerVersion(input.target, signing, message, scriptEtag);
      if (versionId === VERSION_C && input.beforeAnnotations !== undefined) {
        return { ...current, annotations: input.beforeAnnotations };
      }
      if (versionId !== VERSION_C && input.afterAnnotations !== undefined) {
        return { ...current, annotations: input.afterAnnotations };
      }
      return current;
    },
    async workerSecrets() {
      return [{ name: "TAKOSERVER_SIGNING_KEY", type: "secret_text" as const }];
    },
  };
}

describe("split signing authority surfaces", () => {
  test("canonical upload classification requires the exact version_upload profile", () => {
    const message = `takoserver-worker:${COMMIT}:${BUNDLE_DIGEST}`;
    expect(
      workerVersionAnnotationProfile({
        annotations: { "workers/message": message, "workers/triggered_by": "version_upload" },
      }),
    ).toBe("canonical");

    for (const annotations of [
      { "workers/message": message },
      {},
      { "workers/triggered_by": "version_upload" },
      { "workers/message": "unexpected", "workers/triggered_by": "version_upload" },
      { "workers/message": message, "workers/triggered_by": "secret" },
      {
        "workers/message": message,
        "workers/triggered_by": "version_upload",
        "workers/extra": "unexpected",
      },
    ]) {
      expect(workerVersionAnnotationProfile({ annotations })).toBe("other");
    }

    expect(
      workerVersionAnnotationProfile({ annotations: { "workers/triggered_by": "secret" } }),
    ).toBe("secret-created");
  });

  test("route-less sponsorship authority does not alter the public signing closure", () => {
    const target = {
      ...baseTarget,
      sponsorshipAuthority: {
        workerName: "takoserver-sponsorship-authority",
        organizationId: "org_hosted",
        credentialKeyId: "sponsorship-credential-key",
        credentialPublicJwk: { kty: "OKP", crv: "Ed25519", x: "B".repeat(42) + "A" },
        receiptKeyId: "receipt-key",
        receiptPublicJwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) },
      },
      signing: { currentKeyId: "key-current", nextKeyId: "key-next" },
    } satisfies DeployTarget;
    const shared = [
      { name: "AI", type: "ai" },
      { name: "WORKER_VERSION", type: "version_metadata" },
      { name: "STATE_DB", type: "d1", id: "00000000-0000-4000-8000-000000000000" },
      { name: "OBJECTS", type: "r2_bucket", bucket_name: "takoserver-objects-integration" },
      {
        name: "PUBLIC_ORIGIN",
        type: "plain_text",
        text: "https://api.integration.example.test",
      },
    ];
    const expectedC = [
      ...shared,
      { name: "TAKOSERVER_SIGNING_KEY_ID", type: "plain_text", text: "key-current" },
      { name: "TAKOSERVER_SIGNING_KEY", type: "secret_text" },
    ];
    const expectedS = [
      ...shared,
      { name: "TAKOSERVER_SIGNING_KEY_ID", type: "plain_text", text: "key-next" },
      { name: "TAKOSERVER_SIGNING_KEY", type: "secret_text" },
    ];

    expect(
      signingVersion(target, "key-current", `takoserver-worker:${COMMIT}:${BUNDLE_DIGEST}`)
        .resources.bindings,
    ).toEqual(expectedC);
    expect(
      signingVersion(target, "key-next", `takoserver-worker:${COMMIT}:${BUNDLE_DIGEST}`).resources
        .bindings,
    ).toEqual(expectedS);
  });

  test("register accepts a public-only JWK once and never overwrites its kid", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-register-"));
    try {
      const key = await keyPair("key-current");
      const publicPath = join(root, "public.jwk");
      writeFileSync(publicPath, `${key.publicJwk}\n`, { mode: 0o600 });
      const db = new FakeDatabase();
      const process = processFixture();
      const result = await runSigning(
        {
          surface: "takoserver-signing-key-register",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        baseTarget,
        {
          database: db,
          run: process.run,
          publicJwkPath: publicPath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.signing-key-register-apply@v2",
        keyId: "key-current",
        noOverwrite: true,
      });
      expect(db.inserts).toEqual([{ keyId: "key-current", publicJwk: key.publicJwk }]);
      expect(process.calls.some(({ command }) => command.includes("secret"))).toBe(false);

      const second = await runSigning(
        {
          surface: "takoserver-signing-key-register",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        baseTarget,
        {
          database: db,
          run: process.run,
          publicJwkPath: publicPath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "second-work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(second).toBeInstanceOf(DeployError);
      expect(second.message).toContain("no-overwrite");
      expect(db.inserts).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("register rejects any private member before D1 mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-register-private-"));
    try {
      const key = await keyPair("key-current");
      const path = join(root, "not-public.jwk");
      writeFileSync(path, JSON.stringify(key.privateJwk), { mode: 0o600 });
      const db = new FakeDatabase();
      const failure = await runSigning(
        {
          surface: "takoserver-signing-key-register",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        baseTarget,
        {
          database: db,
          run: processFixture().run,
          publicJwkPath: path,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.message).toContain("public-only");
      expect(db.inserts).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("registration status and apply reject both sponsorship public keys before mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-register-sponsorship-collision-"));
    try {
      const credential = await keyPair("sponsorship-credential-key");
      const receipt = await keyPair("sponsorship-receipt-key");
      const target = sponsoredTarget({
        credentialPublicJwk: credential.publicJwk,
        receiptPublicJwk: receipt.publicJwk,
      });

      for (const [name, authorityKey] of [
        ["credential", credential],
        ["receipt", receipt],
      ] as const) {
        const statusDatabase = new FakeDatabase();
        statusDatabase.rows.set("key-current", row("key-current", authorityKey.publicJwk));
        const statusProcess = processFixture();
        const statusFailure = await runSigning(
          {
            surface: "takoserver-signing-key-register",
            action: "status",
            environment: "integration",
            commit: COMMIT,
          },
          target,
          {
            database: statusDatabase,
            run: statusProcess.run,
            outputDirectory: join(root, `${name}-status`),
          },
        ).catch((error) => error);
        expect(statusFailure, `${name}/status`).toBeInstanceOf(DeployError);
        expect(statusFailure.phase, `${name}/status`).toBe("preflight");
        expect(statusDatabase.inserts, `${name}/status`).toHaveLength(0);
        expect(statusProcess.calls, `${name}/status`).toHaveLength(0);

        const publicPath = join(root, `${name}-public.jwk`);
        writeFileSync(publicPath, `${authorityKey.publicJwk}\n`, { mode: 0o600 });
        const applyDatabase = new FakeDatabase();
        const applyProcess = processFixture();
        const applyFailure = await runSigning(
          {
            surface: "takoserver-signing-key-register",
            action: "apply",
            environment: "integration",
            commit: COMMIT,
          },
          target,
          {
            database: applyDatabase,
            run: applyProcess.run,
            publicJwkPath: publicPath,
            review: "reviewer@example.test",
            outputDirectory: join(root, `${name}-apply`),
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          },
        ).catch((error) => error);
        expect(applyFailure, `${name}/apply`).toBeInstanceOf(DeployError);
        expect(applyFailure.phase, `${name}/apply`).toBe("preflight");
        expect(applyDatabase.inserts, `${name}/apply`).toHaveLength(0);
        expect(
          applyProcess.calls.some(
            ({ command }) => command.includes("secret") || command.includes("deploy"),
          ),
          `${name}/apply`,
        ).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repair proves the exact D1 keypair and changes only the existing secret", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-repair-"));
    try {
      const key = await keyPair("key-current");
      const privatePath = join(root, "private.jwk");
      const privateRaw = `${JSON.stringify(key.privateJwk)}\n`;
      writeFileSync(privatePath, privateRaw, { mode: 0o600 });
      chmodSync(privatePath, 0o600);
      const db = new FakeDatabase();
      db.rows.set("key-current", row("key-current", key.publicJwk));
      const process = processFixture();
      const result = await runSigning(
        {
          surface: "takoserver-signing-repair",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        baseTarget,
        {
          database: db,
          state: workerState({
            target: baseTarget,
            beforeSigning: "key-current",
            afterAnnotations: { "workers/triggered_by": "secret" },
            afterWhen: () =>
              process.calls.some(
                ({ command }) => command.includes("secret") && command.includes("put"),
              ),
          }),
          run: process.run,
          privateJwkPath: privatePath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.signing-repair-apply@v2",
        keyId: "key-current",
        keyPairProof: { keyId: "key-current" },
      });
      const mutations = process.calls.filter(
        ({ command }) => command.includes("secret") && command.includes("put"),
      );
      expect(mutations).toHaveLength(1);
      expect(mutations[0]?.input).toBe(privateRaw);
      expect(mutations[0]?.command.join(" ")).not.toContain(privateRaw.trim());
      expect(process.calls.some(({ command }) => command.includes("--secrets-file"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("JIT signing repair proves a secret-created provenance-bound successor", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-jit-repair-"));
    try {
      const key = await keyPair("key-current");
      const privatePath = join(root, "private.jwk");
      const privateRaw = `${JSON.stringify(key.privateJwk)}\n`;
      writeFileSync(privatePath, privateRaw, { mode: 0o600 });
      chmodSync(privatePath, 0o600);
      const db = new FakeDatabase();
      db.rows.set("key-current", row("key-current", key.publicJwk));
      const process = processFixture();
      const result = await runSigning(
        {
          surface: "takoserver-signing-repair",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        integrationE2eTarget,
        {
          database: db,
          state: workerState({
            target: integrationE2eTarget,
            beforeSigning: "key-current",
            afterAnnotations: { "workers/triggered_by": "secret" },
            afterWhen: () =>
              process.calls.some(
                ({ command }) => command.includes("secret") && command.includes("put"),
              ),
          }),
          run: process.run,
          privateJwkPath: privatePath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );

      expect(result).toMatchObject({
        kind: "takoserver.signing-repair-apply@v2",
        commit: COMMIT,
        keyId: "key-current",
      });
      const config = JSON.parse(
        readFileSync(join(root, "work/inspect-wrangler.jsonc"), "utf8"),
      ) as { vars: Record<string, string> };
      expect(config.vars).toMatchObject({
        TAKOSERVER_ENVIRONMENT: "integration",
        TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK: JSON.stringify(
          integrationE2eTarget.integrationE2eCredentialAuthority.publicJwk,
        ),
        TAKOSERVER_INTEGRATION_E2E_ORGANIZATION_ID:
          integrationE2eTarget.integrationE2eCredentialAuthority.organizationId,
        TAKOSERVER_SOURCE_COMMIT: COMMIT,
        TAKOSERVER_WORKER_ARTIFACT_DIGEST: `sha256:${BUNDLE_DIGEST}`,
      });
      expect(process.calls.filter(({ command }) => command.includes("secret"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("JIT signing repair status reconciles an acknowledged secret-created successor", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-jit-repair-status-"));
    try {
      const key = await keyPair("key-current");
      const db = new FakeDatabase();
      db.rows.set("key-current", row("key-current", key.publicJwk));
      const process = processFixture();
      const result = await runSigning(
        {
          surface: "takoserver-signing-repair",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        integrationE2eTarget,
        {
          database: db,
          state: workerState({
            target: integrationE2eTarget,
            beforeSigning: "key-current",
            deploymentMode: "after",
            afterAnnotations: { "workers/triggered_by": "secret" },
          }),
          run: process.run,
          outputDirectory: join(root, "work"),
        },
      );

      expect(result).toMatchObject({
        kind: "takoserver.signing-repair-status@v2",
        deployedCommit: COMMIT,
        versionId: VERSION_S,
        previousVersionId: VERSION_C,
        ready: true,
      });
      expect(process.calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("JIT canonical current-key rotation uses the provenance-bound profile for status and apply", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-jit-rotation-current-"));
    try {
      const current = await keyPair("key-current");
      const next = await keyPair("key-next");
      const target = {
        ...integrationE2eTarget,
        signing: { currentKeyId: "key-current", nextKeyId: "key-next" },
      } satisfies DeployTarget;

      const statusDatabase = new FakeDatabase();
      statusDatabase.rows.set("key-current", row("key-current", current.publicJwk));
      statusDatabase.rows.set("key-next", row("key-next", next.publicJwk));
      const statusProcess = processFixture();
      const status = await runSigning(
        {
          surface: "takoserver-signing-rotation",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          database: statusDatabase,
          state: workerState({ target, beforeSigning: "key-current", deploymentMode: "before" }),
          run: statusProcess.run,
          outputDirectory: join(root, "status"),
        },
      );
      expect(status).toMatchObject({
        cutoverState: "current-key-serving",
        servingKeyId: "key-current",
        versionId: VERSION_C,
        ready: true,
      });
      expect(statusProcess.calls).toHaveLength(0);

      const privatePath = join(root, "next-private.jwk");
      writeFileSync(privatePath, `${JSON.stringify(next.privateJwk)}\n`, { mode: 0o600 });
      const applyDatabase = new FakeDatabase();
      applyDatabase.rows.set("key-current", row("key-current", current.publicJwk));
      applyDatabase.rows.set("key-next", row("key-next", next.publicJwk));
      let uploadMessage: string | null = null;
      const applyProcess = processFixture({ afterMessage: () => uploadMessage });
      const wrapped: SigningProcess = async (command, options) => {
        if (command.includes("deploy") && command.includes("--secrets-file")) {
          uploadMessage = command[command.indexOf("--message") + 1] ?? null;
        }
        return await applyProcess.run(command, options);
      };
      const applied = await runSigning(
        {
          surface: "takoserver-signing-rotation",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          database: applyDatabase,
          state: workerState({
            target,
            beforeSigning: "key-current",
            afterSigning: "key-next",
            afterMessage: () => uploadMessage,
            afterWhen: () => uploadMessage !== null,
          }),
          run: wrapped,
          nextPrivateJwkPath: privatePath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "apply"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(applied).toMatchObject({
        kind: "takoserver.signing-rotation-apply@v2",
        previousVersionId: VERSION_C,
        versionId: VERSION_S,
      });
      expect(
        applyProcess.calls.filter(({ command }) => command.includes("--secrets-file")),
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rotation requires pre-registered current/next and uploads identical code once", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-rotation-"));
    try {
      const current = await keyPair("key-current");
      const next = await keyPair("key-next");
      const privatePath = join(root, "next-private.jwk");
      writeFileSync(privatePath, `${JSON.stringify(next.privateJwk)}\n`, { mode: 0o600 });
      const target = {
        ...baseTarget,
        signing: { currentKeyId: "key-current", nextKeyId: "key-next" },
      } satisfies DeployTarget;
      const db = new FakeDatabase();
      db.rows.set("key-current", row("key-current", current.publicJwk));
      db.rows.set("key-next", row("key-next", next.publicJwk));
      let uploadMessage: string | null = null;
      const process = processFixture({ afterMessage: () => uploadMessage });
      const state = workerState({
        target,
        beforeSigning: "key-current",
        afterSigning: "key-next",
        afterMessage: () => uploadMessage,
        afterWhen: () => uploadMessage !== null,
      });
      const wrapped: SigningProcess = async (command, options) => {
        if (command.includes("deploy") && command.includes("--secrets-file")) {
          uploadMessage = command[command.indexOf("--message") + 1] ?? null;
        }
        return await process.run(command, options);
      };
      const result = await runSigning(
        {
          surface: "takoserver-signing-rotation",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          database: db,
          state,
          run: wrapped,
          nextPrivateJwkPath: privatePath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.signing-rotation-apply@v2",
        currentKeyId: "key-current",
        nextKeyId: "key-next",
        noOverwrite: true,
        keyPairProof: { keyId: "key-next" },
      });
      expect(JSON.stringify(result)).not.toContain(JSON.parse(current.publicJwk).x);
      expect(JSON.stringify(result)).not.toContain(JSON.parse(next.publicJwk).x);
      expect(db.inserts).toHaveLength(0);
      const uploads = process.calls.filter(({ command }) => command.includes("--secrets-file"));
      expect(uploads).toHaveLength(1);
      expect(process.calls.filter(({ command }) => command.includes("--dry-run"))).toHaveLength(1);
      expect(
        process.calls.some(({ command }) => command.includes("secret") && command.includes("put")),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rotation status and apply reject sponsorship key reuse before a private half can enter the public closure", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-rotation-sponsorship-collision-"));
    try {
      const credential = await keyPair("sponsorship-credential-key");
      const receipt = await keyPair("sponsorship-receipt-key");
      const ordinaryCurrent = await keyPair("key-current");
      const ordinaryNext = await keyPair("key-next");
      const target = sponsoredTarget({
        credentialPublicJwk: credential.publicJwk,
        receiptPublicJwk: receipt.publicJwk,
        signing: { currentKeyId: "key-current", nextKeyId: "key-next" },
      });

      for (const [authorityName, authorityKey] of [
        ["credential", credential],
        ["receipt", receipt],
      ] as const) {
        for (const position of ["current", "next"] as const) {
          for (const action of ["status", "apply"] as const) {
            const nextKey = position === "next" ? authorityKey : ordinaryNext;
            const privateRaw = `${JSON.stringify(nextKey.privateJwk)}\n`;
            const privatePath = join(root, `${authorityName}-${position}-${action}.jwk`);
            writeFileSync(privatePath, privateRaw, { mode: 0o600 });
            const database = new FakeDatabase();
            database.rows.set(
              "key-current",
              row(
                "key-current",
                position === "current" ? authorityKey.publicJwk : ordinaryCurrent.publicJwk,
              ),
            );
            database.rows.set("key-next", row("key-next", nextKey.publicJwk));
            const process = processFixture();
            const uploadedSecrets: string[] = [];
            let uploaded = false;
            const run: SigningProcess = async (command, options) => {
              if (command.includes("deploy") && command.includes("--secrets-file")) {
                const secretsPath = command[command.indexOf("--secrets-file") + 1];
                if (secretsPath) uploadedSecrets.push(readFileSync(secretsPath, "utf8"));
                uploaded = true;
              }
              return await process.run(command, options);
            };
            const failure = await runSigning(
              {
                surface: "takoserver-signing-rotation",
                action,
                environment: "integration",
                commit: COMMIT,
              },
              target,
              {
                database,
                state: workerState({
                  target,
                  beforeSigning: "key-current",
                  afterSigning: "key-next",
                  afterWhen: () => uploaded,
                }),
                run,
                nextPrivateJwkPath: privatePath,
                review: "reviewer@example.test",
                outputDirectory: join(root, `${authorityName}-${position}-${action}-work`),
                cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
              },
            ).catch((error) => error);

            expect(failure, `${authorityName}/${position}/${action}`).toBeInstanceOf(DeployError);
            expect(failure.phase, `${authorityName}/${position}/${action}`).toBe("preflight");
            expect(database.inserts, `${authorityName}/${position}/${action}`).toHaveLength(0);
            expect(
              process.calls.filter(({ command }) => command.includes("--secrets-file")),
              `${authorityName}/${position}/${action}`,
            ).toHaveLength(0);
            expect(uploadedSecrets, `${authorityName}/${position}/${action}`).toHaveLength(0);
          }
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("integration rotation accepts the exact legacy current public row", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-legacy-rotation-"));
    try {
      const current = await keyPair("key-current");
      const next = await keyPair("key-next");
      const privatePath = join(root, "next-private.jwk");
      writeFileSync(privatePath, `${JSON.stringify(next.privateJwk)}\n`, { mode: 0o600 });
      const target = {
        ...baseTarget,
        signing: { currentKeyId: "key-current", nextKeyId: "key-next" },
      } satisfies DeployTarget;
      const legacyCurrent = JSON.stringify({
        kty: "OKP",
        x: JSON.parse(current.publicJwk).x,
        key_ops: ["verify"],
        crv: "Ed25519",
      });
      const db = new FakeDatabase();
      db.rows.set("key-current", row("key-current", legacyCurrent));
      db.rows.set("key-next", row("key-next", next.publicJwk));
      let uploadMessage: string | null = null;
      const process = processFixture({ afterMessage: () => uploadMessage });
      const state = workerState({
        target,
        beforeSigning: "key-current",
        afterSigning: "key-next",
        afterMessage: () => uploadMessage,
        afterWhen: () => uploadMessage !== null,
      });
      const wrapped: SigningProcess = async (command, options) => {
        if (command.includes("deploy") && command.includes("--secrets-file")) {
          uploadMessage = command[command.indexOf("--message") + 1] ?? null;
        }
        return await process.run(command, options);
      };

      const result = await runSigning(
        {
          surface: "takoserver-signing-rotation",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          database: db,
          state,
          run: wrapped,
          nextPrivateJwkPath: privatePath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );

      expect(result).toMatchObject({
        kind: "takoserver.signing-rotation-apply@v2",
        currentKeyId: "key-current",
        nextKeyId: "key-next",
        previousVersionId: VERSION_C,
        versionId: VERSION_S,
        keyPairProof: { keyId: "key-next" },
      });
      expect(db.inserts).toHaveLength(0);
      expect(db.rows.get("key-current")?.publicJwk).toBe(legacyCurrent);
      expect(db.rows.get("key-next")?.publicJwk).toBe(next.publicJwk);
      expect(db.reads.filter(({ keyId }) => keyId === "key-current")).toEqual([
        { keyId: "key-current", phase: "preflight" },
        { keyId: "key-current", phase: "preflight" },
        { keyId: "key-current", phase: "preflight" },
        { keyId: "key-current", phase: "verification" },
      ]);
      expect(db.reads.filter(({ keyId }) => keyId === "key-next")).toEqual([
        { keyId: "key-next", phase: "preflight" },
        { keyId: "key-next", phase: "preflight" },
        { keyId: "key-next", phase: "preflight" },
        { keyId: "key-next", phase: "verification" },
      ]);
      expect(
        process.calls.filter(({ command }) => command.includes("--secrets-file")),
      ).toHaveLength(1);
      expect(process.calls.filter(({ command }) => command.includes("--dry-run"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("canonical sponsored integration predecessors use the ordinary strict status and apply path", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-canonical-sponsored-rotation-"));
    try {
      const current = await keyPair("key-current");
      const next = await keyPair("key-next");
      const privatePath = join(root, "next-private.jwk");
      writeFileSync(privatePath, `${JSON.stringify(next.privateJwk)}\n`, { mode: 0o600 });
      const target = {
        ...baseTarget,
        sponsorshipAuthority: {
          workerName: "takoserver-sponsorship-authority",
          organizationId: "org_hosted",
          credentialKeyId: "sponsorship-credential-key",
          credentialPublicJwk: { kty: "OKP", crv: "Ed25519", x: "B".repeat(42) + "A" },
          receiptKeyId: "receipt-key",
          receiptPublicJwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) },
        },
        signing: { currentKeyId: "key-current", nextKeyId: "key-next" },
      } satisfies DeployTarget;

      const statusDatabase = new FakeDatabase();
      statusDatabase.rows.set("key-current", row("key-current", current.publicJwk));
      statusDatabase.rows.set("key-next", row("key-next", next.publicJwk));
      const statusProcess = processFixture();
      const status = await runSigning(
        {
          surface: "takoserver-signing-rotation",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          database: statusDatabase,
          state: workerState({
            target,
            beforeSigning: "key-current",
            deploymentMode: "before",
          }),
          run: statusProcess.run,
          outputDirectory: join(root, "status"),
        },
      );
      expect(status).toMatchObject({
        cutoverState: "current-key-serving",
        servingKeyId: "key-current",
        ready: true,
      });
      expect(status).not.toHaveProperty("hostedTransition");
      expect(statusProcess.calls).toHaveLength(0);

      const applyDatabase = new FakeDatabase();
      applyDatabase.rows.set("key-current", row("key-current", current.publicJwk));
      applyDatabase.rows.set("key-next", row("key-next", next.publicJwk));
      let uploadMessage: string | null = null;
      const applyProcess = processFixture({ afterMessage: () => uploadMessage });
      const wrapped: SigningProcess = async (command, options) => {
        if (command.includes("deploy") && command.includes("--secrets-file")) {
          uploadMessage = command[command.indexOf("--message") + 1] ?? null;
        }
        return await applyProcess.run(command, options);
      };
      const applied = await runSigning(
        {
          surface: "takoserver-signing-rotation",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          database: applyDatabase,
          state: workerState({
            target,
            beforeSigning: "key-current",
            afterSigning: "key-next",
            afterMessage: () => uploadMessage,
            afterWhen: () => uploadMessage !== null,
          }),
          run: wrapped,
          nextPrivateJwkPath: privatePath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "apply"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      );
      expect(applied).toMatchObject({
        kind: "takoserver.signing-rotation-apply@v2",
        previousVersionId: VERSION_C,
        versionId: VERSION_S,
      });
      expect(applied).not.toHaveProperty("hostedTransition");
      expect(
        applyProcess.calls.filter(({ command }) => command.includes("--secrets-file")),
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rotation status and apply reject mixed current annotation inventories before upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-mixed-rotation-annotations-"));
    try {
      const current = await keyPair("key-current");
      const next = await keyPair("key-next");
      const privatePath = join(root, "next-private.jwk");
      writeFileSync(privatePath, `${JSON.stringify(next.privateJwk)}\n`, { mode: 0o600 });
      const target = {
        ...baseTarget,
        sponsorshipAuthority: {
          workerName: "takoserver-sponsorship-authority",
          organizationId: "org_hosted",
          credentialKeyId: "sponsorship-credential-key",
          credentialPublicJwk: { kty: "OKP", crv: "Ed25519", x: "B".repeat(42) + "A" },
          receiptKeyId: "receipt-key",
          receiptPublicJwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) },
        },
        signing: { currentKeyId: "key-current", nextKeyId: "key-next" },
      } satisfies DeployTarget;
      const canonicalMessage = `takoserver-worker:${COMMIT}:${BUNDLE_DIGEST}`;
      const variants = [
        {
          name: "message-only",
          annotations: { "workers/message": canonicalMessage },
        },
        {
          name: "extra",
          annotations: { "workers/message": canonicalMessage, "workers/extra": "unexpected" },
        },
        {
          name: "secret-trigger",
          annotations: {
            "workers/message": canonicalMessage,
            "workers/triggered_by": "secret",
          },
        },
      ] as const;

      for (const variant of variants) {
        for (const action of ["status", "apply"] as const) {
          const db = new FakeDatabase();
          db.rows.set("key-current", row("key-current", current.publicJwk));
          db.rows.set("key-next", row("key-next", next.publicJwk));
          const process = processFixture();
          let uploaded = false;
          const run: SigningProcess = async (command, options) => {
            if (command.includes("deploy") && command.includes("--secrets-file")) uploaded = true;
            return await process.run(command, options);
          };
          const failure = await runSigning(
            {
              surface: "takoserver-signing-rotation",
              action,
              environment: "integration",
              commit: COMMIT,
            },
            target,
            {
              database: db,
              state: workerState({
                target,
                beforeSigning: "key-current",
                beforeAnnotations: variant.annotations,
                afterSigning: "key-next",
                afterWhen: () => uploaded,
              }),
              run,
              nextPrivateJwkPath: privatePath,
              review: "reviewer@example.test",
              outputDirectory: join(root, `${variant.name}-${action}`),
              cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
            },
          ).catch((error) => error);

          expect(failure, `${variant.name}/${action}`).toBeInstanceOf(DeployError);
          expect(failure.phase, `${variant.name}/${action}`).toBe("preflight");
          expect(process.calls, `${variant.name}/${action}`).toHaveLength(0);
          expect(
            process.calls.filter(({ command }) => command.includes("--secrets-file")),
            `${variant.name}/${action}`,
          ).toHaveLength(0);
          expect(db.inserts, `${variant.name}/${action}`).toHaveLength(0);
          expect(
            `${failure.message}\n${failure.detail ?? ""}`,
            `${variant.name}/${action}`,
          ).not.toContain(JSON.parse(current.publicJwk).x);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rotation status distinguishes the current predecessor from its exact next successor", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-rotation-status-"));
    try {
      const current = await keyPair("key-current");
      const next = await keyPair("key-next");
      const target = {
        ...baseTarget,
        signing: { currentKeyId: "key-current", nextKeyId: "key-next" },
      } satisfies DeployTarget;
      const legacyCurrent = JSON.stringify({
        key_ops: ["verify"],
        x: JSON.parse(current.publicJwk).x,
        crv: "Ed25519",
        kty: "OKP",
      });

      for (const expected of [
        {
          deploymentMode: "after" as const,
          cutoverState: "next-key-direct-successor",
          directSuccessor: true,
          servingKeyId: "key-next",
          versionId: VERSION_S,
          previousVersionId: VERSION_C,
        },
        {
          deploymentMode: "before" as const,
          cutoverState: "current-key-serving",
          directSuccessor: false,
          servingKeyId: "key-current",
          versionId: VERSION_C,
          previousVersionId: null,
        },
      ]) {
        const db = new FakeDatabase();
        db.rows.set("key-current", row("key-current", legacyCurrent));
        db.rows.set("key-next", row("key-next", next.publicJwk));
        const process = processFixture();
        const result = await runSigning(
          {
            surface: "takoserver-signing-rotation",
            action: "status",
            environment: "integration",
            commit: COMMIT,
          },
          target,
          {
            database: db,
            state: workerState({
              target,
              beforeSigning: "key-current",
              afterSigning: "key-next",
              deploymentMode: expected.deploymentMode,
            }),
            run: process.run,
            outputDirectory: join(root, expected.deploymentMode),
          },
        );

        expect(result).toMatchObject({
          kind: "takoserver.signing-rotation-status@v2",
          cutoverState: expected.cutoverState,
          servingKeyId: expected.servingKeyId,
          directSuccessor: expected.directSuccessor,
          deployedCommit: COMMIT,
          versionId: expected.versionId,
          previousVersionId: expected.previousVersionId,
          ready: true,
        });
        expect(process.calls).toHaveLength(0);
        expect(db.inserts).toHaveLength(0);
        expect(JSON.stringify(result)).not.toContain(JSON.parse(current.publicJwk).x);
        expect(JSON.stringify(result)).not.toContain(JSON.parse(next.publicJwk).x);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rotation status rejects a next closure without its exact current direct predecessor", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-invalid-rotation-status-"));
    try {
      const current = await keyPair("key-current");
      const next = await keyPair("key-next");
      const target = {
        ...baseTarget,
        signing: { currentKeyId: "key-current", nextKeyId: "key-next" },
      } satisfies DeployTarget;
      const db = new FakeDatabase();
      db.rows.set("key-current", row("key-current", current.publicJwk));
      db.rows.set("key-next", row("key-next", next.publicJwk));

      for (const [name, state] of [
        [
          "missing-predecessor",
          workerState({
            target,
            beforeSigning: "key-current",
            afterSigning: "key-next",
            afterHasPredecessor: false,
            deploymentMode: "after",
          }),
        ],
        [
          "wrong-predecessor-closure",
          workerState({
            target,
            beforeSigning: "key-next",
            afterSigning: "key-next",
            deploymentMode: "after",
          }),
        ],
        [
          "different-predecessor-code",
          workerState({
            target,
            beforeSigning: "key-current",
            afterSigning: "key-next",
            beforeMessage: `takoserver-worker:${"b".repeat(40)}:${BUNDLE_DIGEST}`,
            deploymentMode: "after",
          }),
        ],
        [
          "different-predecessor-script",
          workerState({
            target,
            beforeSigning: "key-current",
            afterSigning: "key-next",
            beforeScriptEtag: "script-etag-before",
            afterScriptEtag: "script-etag-after",
            deploymentMode: "after",
          }),
        ],
        [
          "history-advanced",
          workerState({
            target,
            beforeSigning: "key-current",
            afterSigning: "key-next",
            deploymentMode: "advance",
          }),
        ],
      ] as const) {
        const process = processFixture();
        const failure = await runSigning(
          {
            surface: "takoserver-signing-rotation",
            action: "status",
            environment: "integration",
            commit: COMMIT,
          },
          target,
          {
            database: db,
            state,
            run: process.run,
            outputDirectory: join(root, name),
          },
        ).catch((error) => error);

        expect(failure).toBeInstanceOf(DeployError);
        expect(failure.phase).toBe("preflight");
        expect(process.calls).toHaveLength(0);
        expect(`${failure.message}\n${failure.detail ?? ""}`).not.toContain(
          JSON.parse(current.publicJwk).x,
        );
        expect(`${failure.message}\n${failure.detail ?? ""}`).not.toContain(
          JSON.parse(next.publicJwk).x,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rotation apply refuses an already advanced next closure before upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-already-rotated-"));
    try {
      const current = await keyPair("key-current");
      const next = await keyPair("key-next");
      const target = {
        ...baseTarget,
        signing: { currentKeyId: "key-current", nextKeyId: "key-next" },
      } satisfies DeployTarget;
      const db = new FakeDatabase();
      db.rows.set("key-current", row("key-current", current.publicJwk));
      db.rows.set("key-next", row("key-next", next.publicJwk));
      const process = processFixture();

      const failure = await runSigning(
        {
          surface: "takoserver-signing-rotation",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          database: db,
          state: workerState({
            target,
            beforeSigning: "key-current",
            afterSigning: "key-next",
            deploymentMode: "after",
          }),
          run: process.run,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);

      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("preflight");
      expect(process.calls).toHaveLength(0);
      expect(db.inserts).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rotation apply requalifies the current Version after build and refuses a race", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-rotation-build-race-"));
    try {
      const current = await keyPair("key-current");
      const next = await keyPair("key-next");
      const privatePath = join(root, "next-private.jwk");
      writeFileSync(privatePath, `${JSON.stringify(next.privateJwk)}\n`, { mode: 0o600 });
      const target = {
        ...baseTarget,
        signing: { currentKeyId: "key-current", nextKeyId: "key-next" },
      } satisfies DeployTarget;
      const db = new FakeDatabase();
      db.rows.set("key-current", row("key-current", current.publicJwk));
      db.rows.set("key-next", row("key-next", next.publicJwk));
      const process = processFixture();
      let buildComplete = false;
      const wrapped: SigningProcess = async (command, options) => {
        const result = await process.run(command, options);
        if (command.includes("--dry-run")) buildComplete = true;
        return result;
      };

      const failure = await runSigning(
        {
          surface: "takoserver-signing-rotation",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          database: db,
          state: workerState({
            target,
            beforeSigning: "key-current",
            afterSigning: "key-next",
            afterWhen: () => buildComplete,
          }),
          run: wrapped,
          nextPrivateJwkPath: privatePath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);

      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("preflight");
      expect(process.calls.filter(({ command }) => command.includes("--dry-run"))).toHaveLength(1);
      expect(
        process.calls.filter(({ command }) => command.includes("--secrets-file")),
      ).toHaveLength(0);
      expect(db.inserts).toHaveLength(0);
      expect(db.reads.filter(({ keyId }) => keyId === "key-current")).toEqual([
        { keyId: "key-current", phase: "preflight" },
        { keyId: "key-current", phase: "preflight" },
        { keyId: "key-current", phase: "preflight" },
      ]);
      expect(db.reads.filter(({ keyId }) => keyId === "key-next")).toEqual([
        { keyId: "key-next", phase: "preflight" },
        { keyId: "key-next", phase: "preflight" },
        { keyId: "key-next", phase: "preflight" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("integration rotation rejects inexact legacy current rows before upload", async () => {
    const current = await keyPair("key-current");
    const next = await keyPair("key-next");
    const x = JSON.parse(current.publicJwk).x as string;
    const variants = [
      JSON.stringify({ crv: "Ed25519", key_ops: ["sign"], kty: "OKP", x }),
      JSON.stringify({ crv: "Ed25519", ext: true, key_ops: ["verify"], kty: "OKP", x }),
      JSON.stringify({ crv: "Ed25519", key_ops: ["verify"], kty: "OKP", x }, null, 2),
      JSON.stringify({
        crv: "Ed25519",
        key_ops: ["verify"],
        kty: "OKP",
        x: `${"A".repeat(42)}B`,
      }),
    ];

    for (const publicJwk of variants) {
      const sensitiveX = String(JSON.parse(publicJwk).x);
      const { failure, calls } = await rejectedRotation({
        currentPublicJwk: publicJwk,
        nextPublicJwk: next.publicJwk,
      });
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("preflight");
      expect(calls).toHaveLength(0);
      expect(calls.some(({ command }) => command.includes("--secrets-file"))).toBe(false);
      expect(`${failure.message}\n${failure.detail ?? ""}`).not.toContain(publicJwk);
      expect(`${failure.message}\n${failure.detail ?? ""}`).not.toContain(sensitiveX);
    }
  });

  test("integration rotation rejects a legacy next row before upload", async () => {
    const current = await keyPair("key-current");
    const next = await keyPair("key-next");
    const nextX = JSON.parse(next.publicJwk).x as string;
    const legacyNext = JSON.stringify({
      crv: "Ed25519",
      key_ops: ["verify"],
      kty: "OKP",
      x: nextX,
    });

    const { failure, calls } = await rejectedRotation({
      currentPublicJwk: current.publicJwk,
      nextPublicJwk: legacyNext,
    });

    expect(failure).toBeInstanceOf(DeployError);
    expect(failure.phase).toBe("preflight");
    expect(calls).toHaveLength(0);
    expect(calls.some(({ command }) => command.includes("--secrets-file"))).toBe(false);
    expect(`${failure.message}\n${failure.detail ?? ""}`).not.toContain(legacyNext);
    expect(`${failure.message}\n${failure.detail ?? ""}`).not.toContain(nextX);
  });

  test("rehearsal and production rotation reject a legacy current row before upload", async () => {
    const current = await keyPair("key-current");
    const next = await keyPair("key-next");
    const currentX = JSON.parse(current.publicJwk).x as string;
    const legacyCurrent = JSON.stringify({
      crv: "Ed25519",
      key_ops: ["verify"],
      kty: "OKP",
      x: currentX,
    });

    for (const environment of ["rehearsal", "production"] as const) {
      const { failure, calls } = await rejectedRotation({
        currentPublicJwk: legacyCurrent,
        nextPublicJwk: next.publicJwk,
        environment,
      });
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("preflight");
      expect(calls).toHaveLength(0);
      expect(calls.some(({ command }) => command.includes("--secrets-file"))).toBe(false);
      expect(`${failure.message}\n${failure.detail ?? ""}`).not.toContain(legacyCurrent);
      expect(`${failure.message}\n${failure.detail ?? ""}`).not.toContain(currentX);
    }
  });

  test("repair and the general active public-key parser reject a legacy row", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-legacy-repair-"));
    try {
      const current = await keyPair("key-current");
      const currentX = JSON.parse(current.publicJwk).x as string;
      const legacyCurrent = JSON.stringify({
        crv: "Ed25519",
        key_ops: ["verify"],
        kty: "OKP",
        x: currentX,
      });
      const db = new FakeDatabase();
      const legacyRow = row("key-current", legacyCurrent);
      db.rows.set("key-current", legacyRow);
      const process = processFixture();

      const failure = await runSigning(
        {
          surface: "takoserver-signing-repair",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        baseTarget,
        {
          database: db,
          state: workerState({ target: baseTarget, beforeSigning: "key-current" }),
          run: process.run,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);

      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.phase).toBe("preflight");
      expect(process.calls.some(({ command }) => command.includes("secret"))).toBe(false);
      expect(() => activePublicJwk(legacyRow, "key-current")).toThrow(DeployError);
      expect(`${failure.message}\n${failure.detail ?? ""}`).not.toContain(legacyCurrent);
      expect(`${failure.message}\n${failure.detail ?? ""}`).not.toContain(currentX);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function rejectedRotation(input: {
  readonly currentPublicJwk: string;
  readonly nextPublicJwk: string;
  readonly environment?: "integration" | "rehearsal" | "production";
}) {
  const root = mkdtempSync(join(tmpdir(), "takoserver-rejected-rotation-"));
  try {
    const environment = input.environment ?? "integration";
    const target = {
      ...baseTarget,
      environment,
      signing: { currentKeyId: "key-current", nextKeyId: "key-next" },
    } satisfies DeployTarget;
    const db = new FakeDatabase();
    db.rows.set("key-current", row("key-current", input.currentPublicJwk));
    db.rows.set("key-next", row("key-next", input.nextPublicJwk));
    const process = processFixture();
    const failure = await runSigning(
      {
        surface: "takoserver-signing-rotation",
        action: "apply",
        environment,
        commit: COMMIT,
      },
      target,
      {
        database: db,
        state: workerState({
          target,
          beforeSigning: "key-current",
          deploymentMode: "before",
        }),
        run: process.run,
        review: "reviewer@example.test",
        outputDirectory: join(root, "work"),
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
      },
    ).catch((error) => error);
    return { failure, calls: process.calls };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function row(keyId: string, publicJwk: string): SigningPublicKeyRow {
  return { keyId, publicJwk, createdAtEpochSeconds: 1, revokedAtEpochSeconds: null };
}

function deployment(id: string, versionId: string, created: string) {
  return { id, created_on: created, versions: [{ version_id: versionId, percentage: 100 }] };
}

function workerVersion(
  target: DeployTarget,
  signingKeyId: string,
  message: string,
  scriptEtag: string,
) {
  const match = /^takoserver-worker:([0-9a-f]{40}):([0-9a-f]{64})$/u.exec(message);
  if (!match?.[1] || !match[2]) throw new Error("invalid test Worker annotation");
  const expected = expectedExactBindingClosure(target, {
    signingKeyId,
    ...(target.integrationE2eCredentialAuthority === undefined
      ? {}
      : {
          authorityProfile: {
            kind: "provenance-bound-jit" as const,
            provenance: {
              sourceCommit: match[1],
              artifactDigest: `sha256:${match[2]}` as const,
            },
          },
        }),
  });
  return {
    annotations: { "workers/message": message, "workers/triggered_by": "version_upload" },
    resources: {
      script: { etag: scriptEtag },
      bindings: Object.entries(expected).flatMap(([name, requirement]) =>
        requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
      ),
    },
  };
}

function signingVersion(
  target: DeployTarget,
  signingKeyId: string,
  message: string,
  authorityProfile?:
    | { readonly kind: "historical-pre-jit" }
    | {
        readonly kind: "provenance-bound-jit";
        readonly provenance: {
          readonly sourceCommit: string;
          readonly artifactDigest: `sha256:${string}`;
        };
      },
) {
  const match = /^takoserver-worker:([0-9a-f]{40}):([0-9a-f]{64})$/u.exec(message);
  if (!match?.[1] || !match[2]) throw new Error("invalid test Worker annotation");
  const closure = expectedExactBindingClosure(target, {
    signingKeyId,
    ...(target.integrationE2eCredentialAuthority === undefined
      ? {}
      : {
          authorityProfile: authorityProfile ?? {
            kind: "provenance-bound-jit" as const,
            provenance: {
              sourceCommit: match[1],
              artifactDigest: `sha256:${match[2]}` as const,
            },
          },
        }),
  });
  return {
    annotations: { "workers/message": message, "workers/triggered_by": "version_upload" },
    resources: {
      script: { etag: "script-etag" },
      bindings: Object.entries(closure).flatMap(([name, requirement]) =>
        requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
      ),
    },
  };
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}
