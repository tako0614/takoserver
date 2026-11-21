import { expect } from "bun:test";
import {
  v2ConfiguredUpdateDiscardTransition,
  v2FinalDeleteConfiguredUpdateDiscardTransition,
} from "../../src/takoform-v2/configured-update-inputs-schema.ts";
import {
  V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND,
  V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND,
} from "../../src/takoform-v2/container-owner-schema.ts";
import { acceptedRawHttp } from "./linux-oci-owned-bundle-fixture.ts";
import { originalPeerDeleteFixture } from "./linux-oci-peer-delete-fixture.ts";

// Explicit NONSECRET bytes inside the original factory; actual normal Engine,
// Core, crypto, atomic memorySQLite and closed raw P/H/HTTP model. Assertions
// are outside Engine backend callbacks.
async function live(
  options: {
    producerRevision?: "missing";
    producerDigest?: "missing" | "wrong";
    localCleanup?: boolean;
    alternateHostTopology?: NonNullable<
      Parameters<typeof originalPeerDeleteFixture>[0]
    >["alternateHostTopology"];
  } = {},
) {
  const f = await originalPeerDeleteFixture({
    normal: true,
    configuredPeer: true,
    runtimeFirst: true,
    allocationSchema: true,
    qualifiedProducer: true,
    ...options,
  });
  const health = acceptedRawHttp();
  health.onEnd(() => {
    health.reply();
    health.join();
  });
  try {
    await f.sql.batch(V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND.statements.map((sql) => ({ sql })));
    await f.sql.batch(V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND.statements);
    await f.sql.batch(v2ConfiguredUpdateDiscardTransition());
    await f.sql.batch(v2FinalDeleteConfiguredUpdateDiscardTransition());
    const accepted = await f.create();
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded", effect: "complete" });
    return { f, accepted };
  } catch (error) {
    await f.cleanup();
    throw error;
  } finally {
    health.restore();
  }
}

export { live as qualifiedNormalDeleteFixture };
