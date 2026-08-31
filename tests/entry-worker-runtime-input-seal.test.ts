import { expect, test } from "bun:test";
import { workerRuntimeInputSealKeyRing } from "../src/entry-worker.ts";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RAW = JSON.stringify({ current: { id: "runtime-2026-08", key: KEY } });
const META = {
  TAKOSERVER_RUNTIME_INPUT_SEAL_CURRENT_KEY_ID: "runtime-2026-08",
  TAKOSERVER_RUNTIME_INPUT_SEAL_PREVIOUS_KEY_IDS: "[]",
  TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING_COMMITMENT:
    "sha256:4f3fc2df9c2b049f4dda8c8b479be0b93e776546c73f8797a555e85b32decf9e",
};

test("Worker runtime imports a seal key only with the exact edge metadata closure", async () => {
  const ring = await workerRuntimeInputSealKeyRing({
    TAKOSERVER_EDGE_SUPPLIES: "{}",
    TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING: RAW,
    ...META,
  });
  expect(ring?.current.keyId).toBe("runtime-2026-08");
  expect(ring?.current.key.extractable).toBe(false);
  expect(await workerRuntimeInputSealKeyRing({})).toBeUndefined();
});

test("Worker runtime fails closed on absent, partial, foreign, or mismatched seal metadata", async () => {
  for (const env of [
    { TAKOSERVER_EDGE_SUPPLIES: "{}" },
    { TAKOSERVER_EDGE_SUPPLIES: "{}", TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING: RAW },
    { TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING: RAW, ...META },
    {
      TAKOSERVER_EDGE_SUPPLIES: "{}",
      TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING: RAW,
      ...META,
      TAKOSERVER_RUNTIME_INPUT_SEAL_CURRENT_KEY_ID: "wrong-key-id",
    },
  ]) {
    const failure = await workerRuntimeInputSealKeyRing(env).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toBe("runtime input seal key ring configuration is invalid");
    expect((failure as Error).message).not.toContain(KEY);
  }
});
