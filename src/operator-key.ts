/**
 * The operator key a self-hosted deployment signs in with, generating one if
 * it has none.
 *
 * A deployment with no identity provider configured advertises no way in, and
 * every sign-in fails with "no identity provider is configured for that
 * method". That is a true sentence about a server nobody can enter, which is
 * not a product — and configuring Google before you can see anything is a poor
 * reason to abandon a first run.
 *
 * So a machine standing on its own mints an operator key, keeps the private
 * half under its data root, and offers operator assertions as its way in. The
 * operator is the only account that exists on a fresh machine, so vouching for
 * themselves by signature is exactly the right amount of authority.
 *
 * This never runs where an identity provider is configured: a real provider
 * answers who someone is, and a self-signed way past it would be a back door.
 */

export interface OperatorPublicKey {
  readonly kty: string;
  readonly crv: string;
  readonly x: string;
}

export interface EnsureOperatorKeyInput {
  /** Configured public half. When present it is used and nothing is generated. */
  readonly configured?: string | undefined;
  /** Set when a real identity provider is configured, which suppresses generation. */
  readonly hasIdentityProvider: boolean;
  readonly path: string;
  readonly readFile: (path: string) => Promise<string | null>;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
}

export async function ensureOperatorKey(
  input: EnsureOperatorKeyInput,
): Promise<OperatorPublicKey | undefined> {
  if (input.configured) return parsePublicKey(input.configured);
  // An existing key is honoured whatever else is configured: it may be the way
  // the operator gets in when the identity provider is the thing that broke.
  const stored = await input.readFile(input.path);
  if (stored) return await publicHalfOf(stored);
  if (input.hasIdentityProvider) return undefined;

  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  await input.writeFile(input.path, JSON.stringify(privateJwk));
  return await publicHalfOf(JSON.stringify(privateJwk));
}

/**
 * A sign-in assertion for the operator themselves.
 *
 * The same bytes `scripts/operator-key.ts sign-in` produces, minted in process
 * so that a first run does not require a second command to be usable. It is
 * printed once, on a machine whose operator is the person reading its output.
 */
export async function signOperatorAssertion(input: {
  readonly privateJwk: string;
  readonly claims: Record<string, unknown>;
  readonly nowSeconds: number;
  readonly lifetimeSeconds: number;
}): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(input.privateJwk) as JsonWebKey,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const payload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({
        ...input.claims,
        iat: input.nowSeconds,
        exp: input.nowSeconds + input.lifetimeSeconds,
      }),
    ),
  );
  const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(payload));
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

async function publicHalfOf(privateJwk: string): Promise<OperatorPublicKey> {
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(privateJwk) as JsonWebKey;
  } catch {
    throw new Error("the stored operator key is not valid JSON");
  }
  if (typeof jwk.x !== "string") throw new Error("the stored operator key has no public half");
  return { kty: "OKP", crv: "Ed25519", x: jwk.x };
}

function parsePublicKey(configured: string): OperatorPublicKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configured);
  } catch {
    throw new Error("TAKOSERVER_OPERATOR_PUBLIC_JWK is not valid JSON");
  }
  const jwk = parsed as Partial<OperatorPublicKey>;
  if (typeof jwk.x !== "string" || typeof jwk.kty !== "string" || typeof jwk.crv !== "string") {
    throw new Error("TAKOSERVER_OPERATOR_PUBLIC_JWK is not an Ed25519 public JWK");
  }
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
