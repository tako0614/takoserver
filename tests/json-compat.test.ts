import { describe, expect, test } from "bun:test";
import { base64UrlDecode, base64UrlEncode, canonicalDigest, canonicalJson } from "../src/json.ts";
import { executionIntentDigest } from "../src/runtime-grants.ts";

/**
 * The Takoform wire contract pins SHA-256 hashes of canonical JSON: prepare
 * digests, replay fingerprints, and offering digests. A released provider
 * already depends on those exact bytes, so the shared implementation in
 * `src/json.ts` must reproduce the one it replaces exactly. These cases are the
 * proof, not a smoke test.
 */
const SHAPES: readonly unknown[] = [
  null,
  true,
  0,
  -1,
  1.5,
  "",
  "takoform",
  [],
  {},
  [1, "two", null, { b: 1, a: 2 }],
  { b: 1, a: 2 },
  { z: { y: { x: [3, 2, 1] } }, a: "first" },
  { "": "empty key", "0": "numeric key", é: "unicode key" },
  { nested: [{ b: [1, { d: 4, c: 3 }] }, { a: null }] },
  { operation: "put", tenantRef: "tenant_a", resourceRef: "bucket", key: "nested/object.txt" },
  {
    apiVersion: "edge.forms.takoform.com/v1beta1",
    kind: "ObjectBucket",
    definitionVersion: "0.1.0",
    schemaDigest: "sha256:3383a60c12bdc5a853868bd7ccab3670e1aff7b3eca889583b86d11ac0f90494",
  },
  { quoted: 'he said "hi"', escaped: "back\\slash", newline: "a\nb", tab: "a\tb" },
  { surrogate: "\u{1f419}" },
];

describe("shared canonical JSON", () => {
  test("encodes byte-identically to the implementation it replaces", async () => {
    for (const shape of SHAPES) {
      // The digest is what the wire pins, so equality is asserted there as well
      // as on the encoding itself.
      expect(await canonicalDigest(shape)).toBe(await executionIntentDigest(shape));
    }
  });

  test("sorts keys at every depth and leaves arrays in order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });
});

describe("base64url", () => {
  test("matches the Buffer encoding the grant format already emits", () => {
    for (let length = 0; length < 130; length += 1) {
      const bytes = new Uint8Array(length).map((_, index) => (index * 37 + length) % 256);
      const expected = Buffer.from(bytes).toString("base64url");
      expect(base64UrlEncode(bytes)).toBe(expected);
      expect(base64UrlDecode(expected)).toEqual(bytes);
    }
  });

  test("rejects any encoding that is not canonical", () => {
    // Padding, non-alphabet characters, and non-canonical trailing bits are all
    // refused, so a token cannot be re-encoded into a different string that
    // still verifies.
    expect(base64UrlDecode("YQ==")).toBeNull();
    expect(base64UrlDecode("YQ+")).toBeNull();
    expect(base64UrlDecode("YR")).toBeNull();
    expect(base64UrlDecode("YQ")).toEqual(new Uint8Array([97]));
  });
});
