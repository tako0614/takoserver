import { CONTAINER_CONTRACT as C } from "../../src/container-contract.ts";
import { isJsonObject } from "../../src/json.ts";
import type { qualifiedNormalDeleteFixture } from "./linux-oci-normal-delete-fixture.ts";
import { acceptedHttpSelection } from "./linux-oci-owned-bundle-fixture.ts";

const alternate = () => ({
  ...acceptedHttpSelection().hostTopology,
  peerIpv4Host: "10.240.0.4",
  peerIpv4Guest: "10.240.0.5",
  peerIpv6Host: "fd60:1234::4",
  peerIpv6Guest: "fd60:1234::5",
});
type Fixture = Awaited<ReturnType<typeof qualifiedNormalDeleteFixture>>["f"];
async function specOf(f: Fixture, uid: string) {
  const row = (await f.sql.query("SELECT spec_json FROM tf_v2_resources WHERE uid=?", [uid]))[0];
  if (typeof row?.spec_json !== "string") throw Error("NONSECRET accepted spec missing");
  const spec: unknown = JSON.parse(row.spec_json);
  if (!isJsonObject(spec)) throw Error("NONSECRET accepted spec invalid");
  return spec;
}
async function update(f: Fixture, uid: string, generation = 1) {
  return f.engine.acceptUpdate({
    principal: "synthetic-oci-parent",
    key: crypto.randomUUID(),
    uid,
    expectedGeneration: generation,
    spec: { ...(await specOf(f, uid)), [C.fields.workloadRevision]: "2".repeat(64) },
    privateInputs: { SECRET: "NONSECRET-generation-two-value" },
  });
}
async function step(f: Fixture) {
  f.advanceNormalClock(61_000);
  return f.engine.runNext();
}

export {
  alternate as normalUpdateAlternateTopology,
  type Fixture as NormalUpdateFixture,
  specOf,
  step as runNormalUpdateStep,
  update as acceptNormalUpdate,
};
