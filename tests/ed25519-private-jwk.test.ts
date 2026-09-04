import { expect, test } from "bun:test";
import { normalizeGeneratedEd25519PrivateJwk } from "../src/ed25519-private-jwk.ts";

test("Bun-exported private JWK normalization retains only the six-member secret contract", () => {
  const runtimeExport = {
    alg: "Ed25519",
    crv: "Ed25519",
    d: "A".repeat(43),
    ext: true,
    key_ops: ["sign"],
    kid: "must-not-persist",
    kty: "OKP",
    x: "E".repeat(43),
  } as JsonWebKey & { readonly alg: string; readonly kid: string };

  const normalized = normalizeGeneratedEd25519PrivateJwk(runtimeExport);

  expect(normalized).toEqual({
    crv: "Ed25519",
    d: "A".repeat(43),
    ext: true,
    key_ops: ["sign"],
    kty: "OKP",
    x: "E".repeat(43),
  });
  expect(Object.keys(normalized)).toEqual(["crv", "d", "ext", "key_ops", "kty", "x"]);
});
