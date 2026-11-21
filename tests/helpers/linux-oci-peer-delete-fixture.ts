import { expect, spyOn } from "bun:test";
import * as net from "node:net";
import {
  acceptedHttpSelection,
  originalOwnedOciFixture,
} from "./linux-oci-owned-bundle-fixture.ts";

// NONSECRET fixture keys/capabilities; actual memorySql/Core/creator and raw
// spawn streams only.
async function fixture(
  options: {
    pending?: boolean;
    v1?: boolean;
    normal?: boolean;
    runtimeFirst?: boolean;
    qualifiedProducer?: boolean;
    producerRevision?: "missing" | "wrong";
    producerDigest?: "missing" | "wrong";
    localCleanup?: boolean;
    applicationOwner?: boolean;
    configuredPeer?: boolean;
    alternateHostTopology?: NonNullable<
      Parameters<typeof originalOwnedOciFixture>[1]
    >["hostTopology"];
    joinFault?: "foreign" | "refused" | "unknown" | "pidns";
    namespaceFault?:
      | "retained"
      | "lost"
      | "foreign"
      | "malformed"
      | "unknown"
      | "cookie"
      | "regress";
    retirementFault?:
      | "begin-retained"
      | "delete-retained"
      | "dispose-retained"
      | "begin-lost"
      | "delete-lost"
      | "dispose-lost"
      | "missing"
      | "wrong-phase";
    hResultFault?: "stdout" | "stderr" | "nonzero" | "signal" | "unknown";
    allocationSchema?: boolean;
    managementFault?: "incomplete" | "missing-reply" | "lost-reply";
  } = {},
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(0xa5),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  const comparison = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(0x5a),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  let byte = 0x30;
  const random = spyOn(crypto, "getRandomValues").mockImplementation(
    <T extends ArrayBufferView | null>(value: T): T => {
      if (!(value instanceof Uint8Array)) throw Error("raw random shape");
      value.fill(++byte);
      return value;
    },
  );
  const network = spyOn(net, "createConnection").mockImplementation(() => {
    throw Error("unexpected OS socket");
  });
  try {
    const f = await originalOwnedOciFixture(false, {
      ...(options.v1 ? { parentControl: true } : { parentPeer: true }),
      ...(options.runtimeFirst ? { parentPeerRuntime: true } : {}),
      ...(options.qualifiedProducer ? { qualifiedProducer: true } : {}),
      ...(options.producerRevision === undefined
        ? {}
        : { producerRevision: options.producerRevision }),
      ...(options.producerDigest === undefined ? {} : { producerDigest: options.producerDigest }),
      ...(options.localCleanup ? { parentPeerLocal: true } : {}),
      ...(options.applicationOwner ? { parentPeerApplicationOwner: true } : {}),
      ...(options.pending === undefined ? {} : { peerPending: options.pending }),
      ...(options.normal === undefined ? {} : { normalBackend: options.normal }),
      ...(options.managementFault === undefined
        ? {}
        : { peerManagementFault: options.managementFault }),
      ...(options.joinFault === undefined ? {} : { peerJoinFault: options.joinFault }),
      ...(options.namespaceFault === undefined
        ? {}
        : { peerNamespaceFault: options.namespaceFault }),
      ...(options.retirementFault === undefined
        ? {}
        : { peerRetirementFault: options.retirementFault }),
      ...(options.hResultFault === undefined ? {} : { peerHResultFault: options.hResultFault }),
      ...(options.allocationSchema === undefined
        ? {}
        : { peerAllocationSchema: options.allocationSchema }),
      ...(options.configuredPeer
        ? acceptedHttpSelection()
        : { nativeMode: "retire-pending" as const }),
      ...(options.alternateHostTopology === undefined
        ? {}
        : { alternateHostTopology: options.alternateHostTopology }),
      fixedKeys: { key, comparison },
    });
    return Object.assign(f, {
      network,
      async cleanup() {
        try {
          await f.close();
        } catch {
          /* teardown only; no product completion */
        } finally {
          network.mockRestore();
          random.mockRestore();
        }
      },
    });
  } catch (error) {
    network.mockRestore();
    random.mockRestore();
    throw error;
  }
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

async function normalCreate(f: Fixture) {
  await f.create();
  expect(await f.engine.runNext()).toMatchObject({ status: "failed", effect: "partial" });
  const row = (
    await f.sql.query("SELECT resource_uid,state FROM tf_v2_container_create_claims")
  )[0];
  if (typeof row?.resource_uid !== "string" || row.state !== "bound")
    throw Error("original bound CREATE absent");
  return row.resource_uid;
}
async function acceptNormalDelete(f: Fixture, uid: string) {
  const fresh = f.reconstructNormal();
  await fresh.engine.acceptDelete({
    principal: "synthetic-oci-parent",
    key: crypto.randomUUID(),
    uid,
    expectedGeneration: 1,
  });
  return fresh;
}

export { acceptNormalDelete, fixture as originalPeerDeleteFixture, normalCreate };
