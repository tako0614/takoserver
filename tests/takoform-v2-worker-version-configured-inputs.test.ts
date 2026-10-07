import { expect, test } from "bun:test";
import { WORKER_VERSION_FORM_URL } from "../src/takoform-v2/forms/worker-specs.ts";
import {
  createV2WorkerVersionConfiguredInputSealer,
  type V2WorkerVersionPrivateIdentity,
} from "../src/takoform-v2/worker-version-configured-inputs.ts";

const identity: V2WorkerVersionPrivateIdentity = {
  principal: "org:owner",
  space: "owner",
  name: "version-a",
  form: WORKER_VERSION_FORM_URL,
  resourceUid: "version-uid",
  spec: {
    worker: { resourceUid: "worker-uid" },
    bundle: { resourceUid: "bundle-uid" },
    handlers: ["fetch"],
    requiredSensitiveVars: ["TOKEN"],
  },
};

function nonextractableKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

test("configured input sealing binds exact Resource identity and normalized immutable spec", async () => {
  const key = await nonextractableKey();
  const sealer = createV2WorkerVersionConfiguredInputSealer({
    current: { keyId: "fixture-key-1", key },
    keyForDecryption: (keyId) => (keyId === "fixture-key-1" ? key : undefined),
  });
  const value = "fixture-private-sentinel";
  const first = await sealer.seal(identity, { TOKEN: value });
  const second = await sealer.seal(identity, { TOKEN: value });

  expect(first).not.toBeNull();
  if (!first || !second) throw new Error("expected sealed synthetic inputs");
  expect(JSON.stringify(first)).not.toContain(value);
  expect(first.nonce).not.toBe(second.nonce);
  expect(first.ciphertext).not.toBe(second.ciphertext);
  expect(await sealer.open(identity, first)).toEqual({ TOKEN: value });
  expect(await sealer.compare(identity, first, { TOKEN: value })).toBe("matched");
  expect(await sealer.compare(identity, first, { TOKEN: "different" })).toBe("mismatched");
  expect(await sealer.compare(identity, first, { TOKEN: "\ud800" })).toBe("mismatched");

  const sameNormalizedSpec = {
    ...identity,
    spec: {
      requiredSensitiveVars: ["TOKEN"],
      handlers: ["fetch"],
      bundle: { resourceUid: "bundle-uid" },
      worker: { resourceUid: "worker-uid" },
      vars: {},
      kvBindings: [],
      sqliteBindings: [],
      bucketBindings: [],
      queueProducerBindings: [],
      serviceBindings: [],
      actorBindings: [],
      workflowBindings: [],
    },
  };
  expect(await sealer.open(sameNormalizedSpec, first)).toEqual({ TOKEN: value });

  for (const changed of [
    { ...identity, principal: "org:other" },
    { ...identity, space: "other" },
    { ...identity, name: "version-b" },
    { ...identity, resourceUid: "other-version-uid" },
    { ...identity, form: "https://example.invalid/worker-version" },
    {
      ...identity,
      spec: { ...(identity.spec as Record<string, unknown>), vars: { PUBLIC: "changed" } },
    },
  ]) {
    expect(await sealer.open(changed, first)).toBeNull();
  }
  expect(
    await sealer.open(identity, {
      ...first,
      ciphertext: `${first.ciphertext[0] === "A" ? "B" : "A"}${first.ciphertext.slice(1)}`,
    }),
  ).toBeNull();
  expect(await sealer.open(identity, { ...first, nonce: `${first.nonce}=` })).toBeNull();
});

test("configured input sealing requires an exact complete map and allows no-secret specs", async () => {
  const key = await nonextractableKey();
  const sealer = createV2WorkerVersionConfiguredInputSealer({
    current: { keyId: "fixture-key-1", key },
    keyForDecryption: () => key,
  });
  await expect(sealer.seal(identity, undefined)).rejects.toThrow();
  await expect(sealer.seal(identity, {})).rejects.toThrow();
  await expect(sealer.seal(identity, { TOKEN: "" })).rejects.toThrow();
  await expect(sealer.seal(identity, { TOKEN: "value", EXTRA: "value" })).rejects.toThrow();
  await expect(
    sealer.seal(identity, { TOKEN: undefined } as unknown as Record<string, string>),
  ).rejects.toThrow();

  const noSecrets = {
    ...identity,
    spec: { ...(identity.spec as Record<string, unknown>), requiredSensitiveVars: [] },
  };
  expect(await sealer.seal(noSecrets, undefined)).toBeNull();
  expect(await sealer.seal(noSecrets, {})).toBeNull();
  await expect(sealer.seal(noSecrets, { TOKEN: "extra" })).rejects.toThrow();
});

test("compare snapshots proposed values and immutable identity before awaiting decryption", async () => {
  const key = await nonextractableKey();
  const sealer = createV2WorkerVersionConfiguredInputSealer({
    current: { keyId: "fixture-key-1", key },
    keyForDecryption: () => key,
  });
  const sealed = await sealer.seal(identity, { TOKEN: "expected" });
  if (!sealed) throw new Error("expected sealed synthetic inputs");
  const tampered = {
    ...sealed,
    ciphertext: `${sealed.ciphertext[0] === "A" ? "B" : "A"}${sealed.ciphertext.slice(1)}`,
  };

  const proposed = { TOKEN: "different" };
  const proposedComparison = sealer.compare(identity, sealed, proposed);
  proposed.TOKEN = "expected";
  expect(await proposedComparison).toBe("mismatched");

  const mutableIdentity = structuredClone(identity) as {
    principal: string;
    space: string;
    name: string;
    form: string;
    resourceUid: string;
    spec: Record<string, unknown>;
  };
  const identityComparison = sealer.compare(mutableIdentity, sealed, {});
  mutableIdentity.spec.requiredSensitiveVars = [];
  expect(await identityComparison).toBe("mismatched");
  expect(await sealer.compare(identity, tampered, undefined)).toBe("unavailable");
});

test("configured input rotation retains old decryption keys without accepting an absent key", async () => {
  const oldKey = await nonextractableKey();
  const oldSealer = createV2WorkerVersionConfiguredInputSealer({
    current: { keyId: "fixture-key-1", key: oldKey },
    keyForDecryption: (keyId) => (keyId === "fixture-key-1" ? oldKey : undefined),
  });
  const sealed = await oldSealer.seal(identity, { TOKEN: "fixture-rotation-sentinel" });
  if (!sealed) throw new Error("expected sealed synthetic inputs");

  const unavailableKey = await nonextractableKey();
  const unavailable = createV2WorkerVersionConfiguredInputSealer({
    current: { keyId: "fixture-key-2", key: unavailableKey },
    keyForDecryption: (keyId) => (keyId === "fixture-key-2" ? unavailableKey : undefined),
  });
  expect(await unavailable.open(identity, sealed)).toBeNull();
  expect(await unavailable.compare(identity, sealed, { TOKEN: "fixture-rotation-sentinel" })).toBe(
    "unavailable",
  );

  const newKey = await nonextractableKey();
  const rotated = createV2WorkerVersionConfiguredInputSealer({
    current: { keyId: "fixture-key-2", key: newKey },
    keyForDecryption: (keyId) =>
      keyId === "fixture-key-2" ? newKey : keyId === "fixture-key-1" ? oldKey : undefined,
  });
  expect(await rotated.open(identity, sealed)).toEqual({ TOKEN: "fixture-rotation-sentinel" });
});

test("configured input sealer rejects extractable, wrong-purpose and malformed-key configurations", async () => {
  const extractable = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  expect(() =>
    createV2WorkerVersionConfiguredInputSealer({
      current: { keyId: "fixture-extractable", key: extractable },
      keyForDecryption: () => extractable,
    }),
  ).toThrow();

  const encryptOnly = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
  ]);
  expect(() =>
    createV2WorkerVersionConfiguredInputSealer({
      current: { keyId: "fixture-encrypt-only", key: encryptOnly },
      keyForDecryption: () => encryptOnly,
    }),
  ).toThrow();

  const key = await nonextractableKey();
  expect(() =>
    createV2WorkerVersionConfiguredInputSealer({
      current: { keyId: "bad key id", key },
      keyForDecryption: () => key,
    }),
  ).toThrow();
  expect(() =>
    createV2WorkerVersionConfiguredInputSealer({
      current: { keyId: "fixture-key-1", key },
      keyForDecryption: () => undefined,
    }),
  ).toThrow();
});
