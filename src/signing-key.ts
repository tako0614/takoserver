import type { SigningKey } from "./token.ts";

/**
 * The key this deployment signs data tokens with.
 *
 * Its public half lives in `runtime_grant_keys`, where any instance can verify
 * against it; the private half is a secret and exists only where tokens are
 * minted. Without it a deployment can verify tokens it will never issue, which
 * is how a data plane ends up refusing everybody with `no_active_keys` — true,
 * and unhelpful unless you already know what it means.
 *
 * Absent is a valid state and is not an error here: it becomes one at the
 * moment somebody asks for a token, which is the only place that can say what
 * was actually wanted.
 */
export async function loadSigningKey(
  keyId: string | undefined,
  privateJwk: string | undefined,
): Promise<SigningKey | undefined> {
  if (!keyId || !privateJwk) return undefined;
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(privateJwk) as JsonWebKey;
  } catch {
    throw new Error("TAKOSERVER_SIGNING_KEY is not valid JSON");
  }
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, [
    "sign",
  ]);
  return { keyId, privateKey };
}

/**
 * The signing key a self-hosted deployment uses, generating one if it has none.
 *
 * Data tokens are signed, so a deployment without a key can verify tokens it
 * will never issue — which surfaces as `no_active_keys` on the first request
 * that wanted one. Making the operator generate and register a key by hand
 * before anything works is a worse first five minutes than the product
 * deserves, and it is not a decision anybody makes differently.
 *
 * So the key is made once, written where the operator can see, replace, or back
 * it up, and its public half registered for verification. Only ever here: a
 * Worker has no filesystem, and a key generated per isolate would sign tokens
 * nothing else could check.
 */
export async function ensureSigningKey(input: {
  readonly keyId: string;
  readonly privateJwk?: string | undefined;
  readonly path: string;
  readonly sql: {
    query(sql: string, params?: readonly (string | number | null)[]): Promise<readonly unknown[]>;
    run(sql: string, params?: readonly (string | number | null)[]): Promise<unknown>;
  };
  readonly readFile: (path: string) => Promise<string | null>;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
}): Promise<SigningKey> {
  const configured = input.privateJwk ?? (await input.readFile(input.path));
  if (configured) {
    const loaded = await loadSigningKey(input.keyId, configured);
    if (!loaded) throw new Error("the configured signing key is unusable");
    await registerPublicHalf(input, JSON.parse(configured) as JsonWebKey);
    return loaded;
  }

  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  await input.writeFile(input.path, JSON.stringify(jwk));
  await registerPublicHalf(input, jwk);
  return { keyId: input.keyId, privateKey: pair.privateKey };
}

async function registerPublicHalf(
  input: {
    readonly keyId: string;
    readonly sql: {
      query(sql: string, params?: readonly (string | number | null)[]): Promise<readonly unknown[]>;
      run(sql: string, params?: readonly (string | number | null)[]): Promise<unknown>;
    };
  },
  jwk: JsonWebKey,
): Promise<void> {
  if (typeof jwk.x !== "string") throw new Error("the signing key has no public half");
  // Registered once and never overwritten: the public half is what every
  // outstanding token is checked against, and replacing it would invalidate
  // tokens this deployment has already handed out.
  await input.sql.run(
    `INSERT OR IGNORE INTO runtime_grant_keys (key_id, public_jwk, created_at_epoch_seconds)
     VALUES (?, ?, ?)`,
    [
      input.keyId,
      JSON.stringify({ kty: "OKP", crv: "Ed25519", x: jwk.x }),
      Math.floor(Date.now() / 1_000),
    ],
  );
}
