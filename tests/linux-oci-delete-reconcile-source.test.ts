import { expect, test } from "bun:test";
import {
  acceptNormalDelete,
  normalCreate,
  originalPeerDeleteFixture,
} from "./linux-oci-peer-reconstruction.test.ts";

// Only this new selector runs. Actual original accepted Core/Engine/creator,
// fresh memorySQLite and intercepted peer streams; imported prior cases never run.
// The existing CREATE helper is partial-bound, not a normal ready CREATE proof.
test("DELETE reconcile same creator advances original STOP to consuming JOIN without replay", async () => {
  const f = await originalPeerDeleteFixture({ normal: false });
  try {
    const uid = await normalCreate(f);
    const normal = await acceptNormalDelete(f, uid);
    const before = f.nativeCounts();
    try {
      expect(await normal.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      const stopped = f.nativeCounts();
      expect(stopped.requests.filter((k) => k === "linux-oci-stop-init@1")).toHaveLength(1);
      expect(stopped.processes).toBe(before.processes + 1);
      f.advanceNormalClock(60_000);
      expect(await normal.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      const joined = f.nativeCounts();
      expect(joined.requests.filter((k) => k === "linux-oci-join-init@1")).toHaveLength(1);
      expect(joined.requests.filter((k) => k === "linux-oci-stop-init@1")).toHaveLength(1);
      expect(joined.requests.filter((k) => k === "linux-oci-create-stopped@1")).toEqual(
        before.requests.filter((k) => k === "linux-oci-create-stopped@1"),
      );
      expect(joined.requests.filter((k) => k === "linux-oci-start@1")).toEqual(
        before.requests.filter((k) => k === "linux-oci-start@1"),
      );
      expect(joined.requests.filter((k) => k === "linux-oci-parent-bootstrap@2")).toHaveLength(1);
      expect(
        (await f.sql.query("SELECT state,removed_at_ms FROM tf_v2_container_create_claims"))[0],
      ).toMatchObject({ state: "bound", removed_at_ms: null });
      expect(f.network).not.toHaveBeenCalled();
    } finally {
      await normal.close().catch(() => undefined);
    }
  } finally {
    await f.cleanup();
  }
});

test("DELETE reconcile same creator retains rejected STOP connector and never spawns replacement", async () => {
  const f = await originalPeerDeleteFixture({ normal: false, managementFault: "lost-reply" });
  try {
    const uid = await normalCreate(f);
    const normal = await acceptNormalDelete(f, uid);
    try {
      expect(await normal.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      const lost = f.nativeCounts();
      expect(lost.requests.filter((k) => k === "linux-oci-stop-init@1")).toHaveLength(1);
      f.advanceNormalClock(60_000);
      expect(await normal.engine.runNext()).toMatchObject({
        status: "reconciling",
        effect: "unknown",
      });
      expect(f.nativeCounts()).toEqual(lost);
      expect(f.nativeCounts().requests.filter((k) => k === "linux-oci-join-init@1")).toHaveLength(
        0,
      );
      expect(
        (await f.sql.query("SELECT state,removed_at_ms FROM tf_v2_container_create_claims"))[0],
      ).toMatchObject({ state: "bound", removed_at_ms: null });
      // The original connector's nonzero exit remains an actual close failure;
      // a later normal lease cannot erase it or manufacture a new connector.
      const closed = await normal.close().then(
        () => "closed",
        () => "unknown",
      );
      expect(closed).toBe("unknown");
      expect(f.network).not.toHaveBeenCalled();
    } finally {
      await normal.close().catch(() => undefined);
    }
  } finally {
    await f.cleanup();
  }
});
