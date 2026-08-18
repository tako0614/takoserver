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
