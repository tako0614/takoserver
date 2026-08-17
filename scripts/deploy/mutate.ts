import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { RemoteD1, sqlLiteral } from "./d1.ts";
import { mutationError } from "./errors.ts";
import type { PreflightReport } from "./preflight.ts";
import { REPOSITORY, runChecked, wranglerCommand } from "./process.ts";

export const PRIVATE_KEY_DIRECTORY = resolve(REPOSITORY, ".deploy/private");

export interface MutationResult {
  readonly versionId: string;
  readonly grantKeyProvisioned: boolean;
}

/**
 * Applies the forward-only schema, makes sure exactly one named verification
 * key is active, and publishes a new immutable Worker version. Everything from
 * here on may have touched the target.
 */
export async function mutate(report: PreflightReport): Promise<MutationResult> {
  await runChecked(
    "mutation",
    "D1 forward migration",
    wranglerCommand([
      "d1",
      "migrations",
      "apply",
      "STATE_DB",
      "--remote",
      "--yes",
      "--config",
      report.configPath,
    ]),
  );

  const grantKeyProvisioned = await ensureGrantKey(report);

  await runChecked(
    "mutation",
    "wrangler deploy",
    wranglerCommand(["deploy", "--config", report.configPath]),
  );

  const version = await servedVersionAfterPublish(report.configPath);
  return { versionId: version, grantKeyProvisioned };
}

/**
 * The durable slice refuses every request while no verification key is active,
 * so publication provisions one. The private half is written outside the
 * repository with owner-only permissions; it is the operator's custody until
 * the durable control plane owns grant issuance.
 */
async function ensureGrantKey(report: PreflightReport): Promise<boolean> {
  const keyId = report.target.grantKeyId;
  const privatePath = privateKeyPath(keyId);

  if (report.live.activeGrantKeyIds.includes(keyId)) {
    try {
      readFileSync(privatePath, "utf8");
    } catch {
      throw mutationError(
        `verification key ${keyId} is active on the target but its private half is not in ` +
          `${privatePath}`,
        "Publication refuses to continue without the custody it claims. Restore the private " +
          "JWK, or rotate `grantKeyId` in the deploy target to a new identity and re-run.",
      );
    }
    return false;
  }

  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);

  mkdirSync(PRIVATE_KEY_DIRECTORY, { recursive: true, mode: 0o700 });
  writeFileSync(privatePath, `${JSON.stringify(privateJwk)}\n`, { mode: 0o600 });
  chmodSync(privatePath, 0o600);

  const stored = JSON.stringify({
    kty: "OKP",
    crv: "Ed25519",
    x: publicJwk.x,
    key_ops: ["verify"],
  });
  const now = Math.floor(Date.now() / 1_000);
  await new RemoteD1(report.configPath).statement(
    "mutation",
    "verification key provisioning",
    "INSERT INTO runtime_grant_keys (key_id, public_jwk, created_at_epoch_seconds) VALUES (" +
      `${sqlLiteral(keyId)}, ${sqlLiteral(stored)}, ${now})`,
  );
  return true;
}

export function privateKeyPath(keyId: string): string {
  return resolve(PRIVATE_KEY_DIRECTORY, `${keyId}.jwk`);
}

export async function loadSigningKey(keyId: string): Promise<CryptoKey> {
  const raw = readFileSync(privateKeyPath(keyId), "utf8");
  const jwk = JSON.parse(raw) as JsonWebKey;
  return await crypto.subtle.importKey("jwk", jwk, "Ed25519", false, ["sign"]);
}

async function servedVersionAfterPublish(configPath: string): Promise<string> {
  const output = await runChecked(
    "mutation",
    "wrangler deployments status",
    wranglerCommand(["deployments", "status", "--config", configPath]),
  );
  const match = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/u.exec(output);
  if (!match) {
    throw mutationError(
      "the published Worker version could not be read back",
      "Bytes may be live. Run `bun run deploy -- --status` before any retry.",
    );
  }
  return match[0];
}
