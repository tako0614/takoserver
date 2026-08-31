import { expect, test } from "bun:test";
import {
  inspectCanonicalRuntimeInputSealKeyRing,
  parseRuntimeInputSealKeyRing,
} from "../src/runtime-input-seal-keyring.ts";

const KEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEY_B = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const COMMITMENT = "sha256:905db07db0c8aae9d27f3bfbe2f6513ac125428626c4ae3a70ec8a3b8c2b4376";
const CANONICAL = JSON.stringify({
  current: { id: "runtime-2026-08", key: KEY_A },
  previous: [{ id: "runtime-2026-07", key: KEY_B }],
});
const DESCRIPTOR = {
  currentKeyId: "runtime-2026-08",
  previousKeyIds: ["runtime-2026-07"],
  commitment: COMMITMENT,
} as const;

test("imports one closed runtime-input key ring as non-extractable AES-GCM keys", async () => {
  const ring = await parseRuntimeInputSealKeyRing(CANONICAL, DESCRIPTOR);

  expect(ring.current.keyId).toBe("runtime-2026-08");
  expect(ring.current.key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
  expect(ring.current.key.extractable).toBe(false);
  expect([...ring.current.key.usages].sort()).toEqual(["decrypt", "encrypt"]);
  expect(ring.previous?.map((key) => key.keyId)).toEqual(["runtime-2026-07"]);
  expect(await inspectCanonicalRuntimeInputSealKeyRing(CANONICAL)).toEqual(DESCRIPTOR);
});

test("rejects malformed, noncanonical, duplicated, open, and metadata-mismatched key rings", async () => {
  for (const raw of [
    "not-json",
    JSON.stringify({}),
    JSON.stringify({ current: { id: "runtime", key: `${KEY_A}=` } }),
    JSON.stringify({ current: { id: "runtime", key: KEY_A }, typo: true }),
    JSON.stringify({
      current: { id: "runtime", key: KEY_A },
      previous: [{ id: "runtime", key: KEY_B }],
    }),
    JSON.stringify({
      current: { id: "runtime", key: KEY_A },
      previous: [
        { id: "old-1", key: KEY_B },
        { id: "old-2", key: KEY_B },
        { id: "old-3", key: KEY_B },
      ],
    }),
    `${CANONICAL}\n`,
    JSON.stringify({
      previous: [{ id: "runtime-2026-07", key: KEY_B }],
      current: { id: "runtime-2026-08", key: KEY_A },
    }),
  ]) {
    await expect(parseRuntimeInputSealKeyRing(raw, DESCRIPTOR)).rejects.toThrow(
      "runtime input seal key ring is invalid",
    );
  }

  for (const descriptor of [
    { ...DESCRIPTOR, currentKeyId: "runtime-2026-09" },
    { ...DESCRIPTOR, previousKeyIds: [] },
    { ...DESCRIPTOR, commitment: `sha256:${"0".repeat(64)}` },
  ]) {
    await expect(parseRuntimeInputSealKeyRing(CANONICAL, descriptor)).rejects.toThrow(
      "runtime input seal key ring is invalid",
    );
  }
});
