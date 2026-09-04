export type ExactEd25519PrivateJwk = JsonWebKey & {
  readonly crv: "Ed25519";
  readonly d: string;
  readonly ext: true;
  readonly key_ops: ["sign"];
  readonly kty: "OKP";
  readonly x: string;
};

const BASE64URL_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

/**
 * Projects a private JWK produced by this process onto Takoserver's exact
 * persisted secret contract. Runtime-specific export metadata never becomes
 * stored authority or an accepted input member.
 */
export function normalizeGeneratedEd25519PrivateJwk(value: unknown): ExactEd25519PrivateJwk {
  const jwk =
    typeof value === "object" && value !== null ? (value as Partial<JsonWebKey>) : undefined;
  if (
    jwk?.kty !== "OKP" ||
    jwk.crv !== "Ed25519" ||
    jwk.ext !== true ||
    !Array.isArray(jwk.key_ops) ||
    jwk.key_ops.length !== 1 ||
    jwk.key_ops[0] !== "sign" ||
    typeof jwk.x !== "string" ||
    typeof jwk.d !== "string" ||
    !BASE64URL_32.test(jwk.x) ||
    !BASE64URL_32.test(jwk.d)
  ) {
    throw new TypeError("generated private JWK is not one Ed25519 signing key");
  }
  return {
    crv: "Ed25519",
    d: jwk.d,
    ext: true,
    key_ops: ["sign"],
    kty: "OKP",
    x: jwk.x,
  };
}
