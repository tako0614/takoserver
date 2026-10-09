import { expect, test } from "bun:test";
import {
  parseRuntimeInputSealKeyRing,
  parseSelfhostRuntimeInputKeyAuthority,
} from "../src/runtime-input-seal-keyring.ts";
import { createSelfhostV2ConfiguredInputSealer } from "../src/selfhost-v2-configured-input-sealer.ts";
import { WORKER_VERSION_FORM_URL } from "../src/takoform-v2/forms/worker-specs.ts";
import {
  hasPrivateComparisonMaterial,
  matchesPrivateInputs,
  sealPrivateInputs,
  unsealPrivateInputs,
  validatePrivateInputCustody,
} from "../src/takoform-v2/private-inputs.ts";

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

test("one retained operator key ring supplies separate non-extractable v2 transfer and comparison keys", async () => {
  const { sealKeys, privateInputCustody } = await parseSelfhostRuntimeInputKeyAuthority(
    JSON.stringify({
      current: { id: "runtime-2026-08", key: KEY_A },
      previous: [{ id: "runtime-2026-07", key: KEY_B }],
    }),
  );
  validatePrivateInputCustody(privateInputCustody);
  expect(sealKeys.current.keyId).toBe("runtime-2026-08");
  expect(privateInputCustody.transfer.current.id).toBe("runtime-2026-08");
  expect(privateInputCustody.comparison.current.id).toBe("runtime-2026-08");
  expect(privateInputCustody.transfer.previous?.map(({ id }) => id)).toEqual(["runtime-2026-07"]);
  expect(privateInputCustody.comparison.previous?.map(({ id }) => id)).toEqual(["runtime-2026-07"]);
  expect(privateInputCustody.transfer.current.key.algorithm).toMatchObject({
    name: "AES-GCM",
    length: 256,
  });
  expect(privateInputCustody.comparison.current.key.algorithm).toMatchObject({
    name: "HMAC",
    hash: { name: "SHA-256" },
  });
  expect(privateInputCustody.transfer.current.key.extractable).toBe(false);
  expect(privateInputCustody.comparison.current.key.extractable).toBe(false);
  expect(privateInputCustody.transfer.current.key).not.toBe(sealKeys.current.key);
});

test("rotation retains old configured ciphertext and both private-input keys, then refuses removed history", async () => {
  const oldRaw = JSON.stringify({ current: { id: "old", key: KEY_A } });
  const rotatedRaw = JSON.stringify({
    current: { id: "new", key: KEY_B },
    previous: [{ id: "old", key: KEY_A }],
  });
  const old = await parseSelfhostRuntimeInputKeyAuthority(oldRaw);
  const identity = {
    principal: "org:fixture",
    space: "fixture",
    name: "version",
    form: WORKER_VERSION_FORM_URL,
    resourceUid: "version-fixture",
    spec: {
      worker: { resourceUid: "worker-fixture" },
      bundle: { resourceUid: "bundle-fixture" },
      handlers: ["fetch"],
      requiredSensitiveVars: ["TOKEN"],
    },
  };
  const value = { TOKEN: "synthetic-rotation-value" };
  const configured = await createSelfhostV2ConfiguredInputSealer(
    await parseRuntimeInputSealKeyRing(oldRaw),
  ).seal(identity, value);
  if (!configured) throw new Error("fixture configured ciphertext was not sealed");
  const binding = {
    operationId: "operation-fixture",
    principal: "org:fixture",
    resourceUid: "version-fixture",
    generation: 1,
  };
  const transient = await sealPrivateInputs(old.privateInputCustody, binding, value, Date.now());
  const rotated = await parseSelfhostRuntimeInputKeyAuthority(rotatedRaw);
  expect(
    await createSelfhostV2ConfiguredInputSealer(rotated.sealKeys).open(identity, configured),
  ).toEqual(value);
  expect(
    await unsealPrivateInputs(
      rotated.privateInputCustody,
      binding,
      transient.transferKeyId,
      transient.transferNonce,
      transient.transferCiphertext,
    ),
  ).toEqual(value);
  expect(
    await matchesPrivateInputs(
      rotated.privateInputCustody,
      binding,
      transient.comparisonKeyId,
      transient.comparisonTag,
      value,
    ),
  ).toBe(true);
  expect(
    await hasPrivateComparisonMaterial(
      rotated.privateInputCustody,
      transient.comparisonKeyId,
      transient.comparisonTag,
    ),
  ).toBe(true);
  expect(
    await hasPrivateComparisonMaterial(
      rotated.privateInputCustody,
      transient.comparisonKeyId,
      `${transient.comparisonTag}x`,
    ),
  ).toBe(false);
  expect(
    await unsealPrivateInputs(
      rotated.privateInputCustody,
      { ...binding, generation: 2 },
      transient.transferKeyId,
      transient.transferNonce,
      transient.transferCiphertext,
    ),
  ).toBeNull();
  expect(
    await matchesPrivateInputs(
      rotated.privateInputCustody,
      binding,
      transient.comparisonKeyId,
      transient.comparisonTag,
      { TOKEN: "changed-synthetic-value" },
    ),
  ).toBe(false);
  const currentOnly = await parseSelfhostRuntimeInputKeyAuthority(
    JSON.stringify({ current: { id: "new", key: KEY_B } }),
  );
  expect(
    await createSelfhostV2ConfiguredInputSealer(currentOnly.sealKeys).open(identity, configured),
  ).toBeNull();
  expect(
    await unsealPrivateInputs(
      currentOnly.privateInputCustody,
      binding,
      transient.transferKeyId,
      transient.transferNonce,
      transient.transferCiphertext,
    ),
  ).toBeNull();
  expect(
    await matchesPrivateInputs(
      currentOnly.privateInputCustody,
      binding,
      transient.comparisonKeyId,
      transient.comparisonTag,
      value,
    ),
  ).toBeNull();
});
