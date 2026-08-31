import { expect, test } from "bun:test";
import { parseRuntimeInputSealKeyRing } from "../src/runtime-input-seal-keyring.ts";

const KEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEY_B = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

test("imports one closed runtime-input key ring as non-extractable AES-GCM keys", async () => {
  const ring = await parseRuntimeInputSealKeyRing(
    JSON.stringify({
      current: { id: "runtime-2026-08", key: KEY_A },
      previous: [{ id: "runtime-2026-07", key: KEY_B }],
    }),
  );

  expect(ring.current.keyId).toBe("runtime-2026-08");
  expect(ring.current.key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
  expect(ring.current.key.extractable).toBe(false);
  expect([...ring.current.key.usages].sort()).toEqual(["decrypt", "encrypt"]);
  expect(ring.previous?.map((key) => key.keyId)).toEqual(["runtime-2026-07"]);
});

test("rejects malformed, noncanonical, duplicated, and open key rings", async () => {
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
  ]) {
    await expect(parseRuntimeInputSealKeyRing(raw)).rejects.toThrow(
      "runtime input seal key ring is invalid",
    );
  }
});
