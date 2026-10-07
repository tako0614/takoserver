import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseRuntimeInputSealKeyRing } from "../src/runtime-input-seal-keyring.ts";
import { createSelfhostV2ConfiguredInputSealer } from "../src/selfhost-v2-configured-input-sealer.ts";
import { WORKER_VERSION_FORM_URL } from "../src/takoform-v2/forms/worker-specs.ts";

const KEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEY_B = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const identity = {
  principal: "org:fixture",
  space: "fixture",
  name: "worker-version",
  form: WORKER_VERSION_FORM_URL,
  resourceUid: "version-fixture",
  spec: {
    worker: { resourceUid: "worker-fixture" },
    bundle: { resourceUid: "bundle-fixture" },
    handlers: ["fetch"],
    requiredSensitiveVars: ["TOKEN"],
  },
};
const fixtureValue = "synthetic-configured-input-sentinel";

test("one parsed operator ring restores v2 ciphertext across rotation and a fresh process", async () => {
  const oldRaw = JSON.stringify({ current: { id: "operator-old", key: KEY_A } });
  const rotatedRaw = JSON.stringify({
    current: { id: "operator-current", key: KEY_B },
    previous: [{ id: "operator-old", key: KEY_A }],
  });
  const oldRing = await parseRuntimeInputSealKeyRing(oldRaw);
  const oldSealer = createSelfhostV2ConfiguredInputSealer(oldRing);
  const sealed = await oldSealer.seal(identity, { TOKEN: fixtureValue });
  if (!sealed) throw new Error("synthetic configured input was not sealed");
  expect(sealed.keyId).toBe("operator-old");
  expect(JSON.stringify(sealed)).not.toContain(fixtureValue);

  const rotated = createSelfhostV2ConfiguredInputSealer(
    await parseRuntimeInputSealKeyRing(rotatedRaw),
  );
  expect(await rotated.open(identity, sealed)).toEqual({ TOKEN: fixtureValue });
  expect(await rotated.open({ ...identity, resourceUid: "different-version" }, sealed)).toBeNull();
  expect(
    await rotated.open(
      { ...identity, spec: { ...identity.spec, requiredSensitiveVars: ["OTHER"] } },
      sealed,
    ),
  ).toBeNull();
  const withoutOld = createSelfhostV2ConfiguredInputSealer(
    await parseRuntimeInputSealKeyRing(
      JSON.stringify({ current: { id: "operator-current", key: KEY_B } }),
    ),
  );
  expect(await withoutOld.open(identity, sealed)).toBeNull();
  expect(await withoutOld.compare(identity, sealed, { TOKEN: fixtureValue })).toBe("unavailable");

  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "fixtures", "selfhost-v2-sealer-reopen.ts")],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    child.stdin.write(
      JSON.stringify({ ring: rotatedRaw, identity, sealed, expected: fixtureValue }),
    );
    child.stdin.end();
    const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(exit).toBe(0);
    expect(output.trim()).toBe("opened");
    expect(output).not.toContain(fixtureValue);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});
