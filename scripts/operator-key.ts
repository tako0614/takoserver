import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The operator's own key, and the assertions it signs.
 *
 * Takoserver cannot know who a caller is or how much money arrived. Until an
 * identity provider and a payment provider are wired up, the operator answers
 * both questions with a signature this tool produces and the server checks.
 *
 *   bun scripts/operator-key.ts init
 *   bun scripts/operator-key.ts sign-in  <provider> <subject> <email> <name>
 *   bun scripts/operator-key.ts funding  <organizationId> <fundingRef> <amountMinor>
 *
 * The private half never leaves `.deploy/private/`, which is gitignored. `init`
 * prints the public JWK to configure as `OPERATOR_PUBLIC_JWK`.
 */

// A self-hosted deployment generates its own key under its data root, so the
// tool has to be able to sign with that one. Without this it would only ever
// reach the repository's key, and signing with a key the server never heard of
// fails as an invalid signature — which reads like the key is wrong rather than
// like it is the wrong key.
const PRIVATE_PATH = process.env.TAKOSERVER_OPERATOR_KEY
  ? resolve(process.env.TAKOSERVER_OPERATOR_KEY)
  : resolve(import.meta.dir, "../.deploy/private/operator.jwk");
const PRIVATE_DIRECTORY = dirname(PRIVATE_PATH);
const LIFETIME_SECONDS = 600;

const [command, ...args] = process.argv.slice(2);

if (command === "init") {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  mkdirSync(PRIVATE_DIRECTORY, { recursive: true, mode: 0o700 });
  writeFileSync(PRIVATE_PATH, `${JSON.stringify(privateJwk)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ kty: "OKP", crv: "Ed25519", x: publicJwk.x })}\n`);
} else if (command === "sign-in" || command === "funding") {
  const claims = command === "sign-in" ? signInClaims(args) : fundingClaims(args);
  process.stdout.write(`${await sign(claims)}\n`);
} else {
  process.stderr.write(
    "usage: operator-key.ts init | sign-in <provider> <subject> <email> <name> |" +
      " funding <organizationId> <fundingRef> <amountMinor>\n",
  );
  process.exit(2);
}

function signInClaims(input: readonly string[]): Record<string, unknown> {
  const [provider, subject, email, displayName] = input;
  if (!provider || !subject || !email || !displayName) {
    process.stderr.write("sign-in needs <provider> <subject> <email> <name>\n");
    process.exit(2);
  }
  return { purpose: "sign-in", provider, subject, email, displayName };
}

function fundingClaims(input: readonly string[]): Record<string, unknown> {
  const [organizationId, fundingRef, amount] = input;
  const amountMinor = Number(amount);
  if (!organizationId || !fundingRef || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    process.stderr.write("funding needs <organizationId> <fundingRef> <amountMinor>\n");
    process.exit(2);
  }
  return { purpose: "funding", organizationId, fundingRef, amountMinor, currency: "USD" };
}

async function sign(claims: Record<string, unknown>): Promise<string> {
  const jwk = JSON.parse(readFileSync(PRIVATE_PATH, "utf8")) as JsonWebKey;
  const key = await crypto.subtle.importKey("jwk", jwk, "Ed25519", false, ["sign"]);
  const issuedAt = Math.floor(Date.now() / 1_000);
  const payload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({ ...claims, iat: issuedAt, exp: issuedAt + LIFETIME_SECONDS }),
    ),
  );
  const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(payload));
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
