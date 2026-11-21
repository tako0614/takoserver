import { expect, spyOn, test } from "bun:test";
import { canonicalJson } from "../src/json.ts";
import {
  decodeContainerSecretBytes,
  decryptContainerSecretBytes,
} from "../src/providers/container-secret-codec.ts";
import * as bundle from "../src/providers/linux-oci-owned-bundle.ts";
import {
  V2_CONTAINER_APPLICATION_IO_RESERVED,
  V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND,
} from "../src/takoform-v2/container-owner-schema.ts";
import {
  observeRawPromise,
  ownedRawHttp,
  rawTick,
} from "./helpers/container-http-transport-fixture.ts";
import { acceptedRawHttp } from "./helpers/linux-oci-owned-bundle-fixture.ts";
import { originalPeerDeleteFixture } from "./helpers/linux-oci-peer-delete-fixture.ts";

// NONSECRET fixtures, real normal Engine/Core/creator functions, closed raw
// spawn/HTTP streams. Imported old cases are filtered, never executed. The
// separate C model covers actual same-H READ/disposal; this model covers its
// private TS consumer and actual application I/O Promise/AEAD/allocation order.
test("runtime-first-connection original READ and H result consume same application close before allocation", async () => {
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    runtimeFirst: true,
    allocationSchema: true,
  });
  await f.sql.batch(V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND.statements.map((sql) => ({ sql })));
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  let accepted: Awaited<ReturnType<typeof f.create>>;
  try {
    accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded", effect: "complete" });
  } catch (error) {
    await f.cleanup();
    throw error;
  } finally {
    health.restore();
  }
  const io = ownedRawHttp(),
    originalSource = bundle.originalLinuxOciHttpRetirementSource,
    sources: ReturnType<typeof originalSource>[] = [];
  const source = spyOn(bundle, "originalLinuxOciHttpRetirementSource").mockImplementation(
    (...args) => {
      const actual = originalSource(...args);
      sources.push(actual);
      return actual;
    },
  );
  try {
    const response = f.composition.fetchServingHttp(
      f.recordedCreate(),
      new Request("http://ignored.invalid/runtime-first-owned-io"),
    );
    for (let tick = 0; tick < 30 && !io.counts().calls; tick++) await rawTick();
    expect(io.counts().calls).toBe(1);
    io.head();
    await response;
    await f.engine.acceptDelete({
      principal: "synthetic-oci-parent",
      key: crypto.randomUUID(),
      uid: accepted.resourceUid,
      expectedGeneration: 1,
    });
    let consuming: ReturnType<typeof observeRawPromise> | undefined;
    for (let phase = 0; phase < 16; phase++) {
      f.advanceNormalClock(61_000); // scheduling only; no real 30s qualification
      const running = observeRawPromise(f.engine.runNext());
      for (let tick = 0; tick < 100 && running.state() === "pending" && !sources.length; tick++)
        await rawTick();
      if (sources.length) {
        consuming = running;
        break;
      }
      expect(await running.value).toHaveProperty("result");
    }
    if (!consuming) throw Error("original runtime-first application consumer not reached");
    const actual = sources[0];
    if (!actual) throw Error("original application source missing");
    const close = actual.close();
    expect(actual.close()).toBe(close);
    const joined = observeRawPromise(close);
    for (let tick = 0; tick < 100 && sources.length < 3; tick++) await rawTick();
    expect(sources.length).toBeGreaterThanOrEqual(3);
    expect(sources.every((value) => value === actual)).toBe(true);
    expect(consuming.state()).toBe("pending");
    expect(joined.state()).toBe("pending");
    const before = (await f.sql.query("SELECT * FROM tf_v2_container_create_claims"))[0];
    expect(before).toMatchObject({
      state: "bound",
      allocation_cleanup: "untouched",
      application_io_cleanup: V2_CONTAINER_APPLICATION_IO_RESERVED,
      removed_at_ms: null,
    });
    const retirements = new Set(
      [
        "stop-init",
        "join-init",
        "release-namespace",
        "continue-namespace-release",
        "delete-born",
        "join-born-delete",
        "begin-tracked-join",
        "read-tracked-join",
        "dispose-born",
        "continue-born-disposal",
        "parent-read-result",
      ].map((kind) => `linux-oci-${kind}@1`),
    );
    expect(f.nativeCounts().requests.filter((kind) => retirements.has(kind))).toEqual([
      "linux-oci-stop-init@1",
      "linux-oci-join-init@1",
      "linux-oci-release-namespace@1",
      "linux-oci-delete-born@1",
      "linux-oci-join-born-delete@1",
      "linux-oci-begin-tracked-join@1",
      "linux-oci-read-tracked-join@1",
      "linux-oci-dispose-born@1",
      "linux-oci-parent-read-result@1",
    ]);
    io.closeResponse();
    await rawTick();
    expect(consuming.state()).toBe("pending");
    io.closeRequest();
    expect(await joined.value).toHaveProperty("result");
    expect(await consuming.value).toHaveProperty("result");
    const row = (await f.sql.query("SELECT * FROM tf_v2_container_create_claims"))[0];
    expect(row).toMatchObject({
      state: "bound",
      allocation_cleanup: "closed",
      removed_at_ms: null,
    });
    if (typeof row?.application_io_cleanup !== "string") throw Error("saved close fact missing");
    const sealed = JSON.parse(row.application_io_cleanup);
    expect(sealed.kind).toBe("linux-oci-sealed-application-io-close@1");
    expect(sealed.scope.original.claimId).toBe(row.claim_id);
    expect(sealed.scope.operation.action).toBe("delete");
    const body = await decryptContainerSecretBytes(
      f.configuredInputs.keyring.current.key,
      decodeContainerSecretBytes(sealed.nonce),
      decodeContainerSecretBytes(sealed.ciphertext),
      new TextEncoder().encode(canonicalJson(sealed.scope)),
    );
    try {
      expect(new TextDecoder().decode(body)).toBe(
        '{"kind":"linux-oci-original-application-io-closed@1"}',
      );
    } finally {
      body.fill(0);
    }
    const requests = f.nativeCounts().requests;
    expect(requests.filter((kind) => kind === "linux-oci-parent-bootstrap@3")).toHaveLength(1);
    expect(requests.filter((kind) => kind === "linux-oci-create-stopped@1")).toHaveLength(1);
    expect(requests.filter((kind) => kind === "linux-oci-start@1")).toHaveLength(1);
    expect(io.counts().calls).toBe(1);
    expect(f.network).not.toHaveBeenCalled();
  } finally {
    source.mockRestore();
    io.closeResponse();
    io.closeRequest();
    io.restore();
    await f.cleanup();
  }
});
