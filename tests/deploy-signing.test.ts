import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import {
  runSigning,
  type SigningDatabase,
  type SigningProcess,
  type SigningPublicKeyRow,
} from "../scripts/deploy/signing.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import type { WorkerState } from "../scripts/deploy/worker-live.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";

const COMMIT = "a".repeat(40);
const BUNDLE = "export default {fetch(){return new Response('ok')}};\n";
const BUNDLE_DIGEST = createHash("sha256").update(BUNDLE).digest("hex");

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

class FakeDatabase implements SigningDatabase {
  readonly rows = new Map<string, SigningPublicKeyRow>();
  readonly inserts: { keyId: string; publicJwk: string }[] = [];

  async readKey(keyId: string): Promise<SigningPublicKeyRow | null> {
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
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicJwk = JSON.stringify({ kty: "OKP", crv: "Ed25519", x: exported.x });
  return { keyId, pair, privateJwk, publicJwk };
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
}): WorkerState {
  let historyReads = 0;
  return {
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: input.target.workerName }];
    },
    async workerDeployments() {
      historyReads += 1;
      return historyReads === 1
        ? [deployment("deployment-before", "version-before", "2026-08-28T01:00:00Z")]
        : [
            deployment("deployment-after", "version-after", "2026-08-28T02:00:00Z"),
            deployment("deployment-before", "version-before", "2026-08-28T01:00:00Z"),
          ];
    },
    async workerVersion(_worker, versionId) {
      const signing =
        versionId === "version-before"
          ? input.beforeSigning
          : (input.afterSigning ?? input.beforeSigning);
      const message =
        versionId === "version-before"
          ? `takoserver-worker:${COMMIT}:${BUNDLE_DIGEST}`
          : (input.afterMessage?.() ?? `takoserver-worker:${COMMIT}:${BUNDLE_DIGEST}`);
      return workerVersion(input.target, signing, message);
    },
    async workerSecrets() {
      return [{ name: "TAKOSERVER_SIGNING_KEY", type: "secret_text" }];
    },
  };
}

describe("split signing authority surfaces", () => {
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
          state: workerState({ target: baseTarget, beforeSigning: "key-current" }),
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
});

function row(keyId: string, publicJwk: string): SigningPublicKeyRow {
  return { keyId, publicJwk, createdAtEpochSeconds: 1, revokedAtEpochSeconds: null };
}

function deployment(id: string, versionId: string, created: string) {
  return { id, created_on: created, versions: [{ version_id: versionId, percentage: 100 }] };
}

function workerVersion(target: DeployTarget, signingKeyId: string, message: string) {
  const expected = expectedExactBindingClosure(target, {
    signingKeyId,
  });
  return {
    annotations: { "workers/message": message },
    resources: {
      bindings: Object.entries(expected).flatMap(([name, requirement]) =>
        requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
      ),
    },
  };
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}
