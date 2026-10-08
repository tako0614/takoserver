import { acquireWranglerVersionPublicationLease } from "../../scripts/deploy/wrangler-state.ts";

export async function expectPublicationLeaseHeld(input: {
  readonly accountId: string;
  readonly workerName: string;
  readonly root: string;
}): Promise<void> {
  let held = false;
  try {
    const lease = await acquireWranglerVersionPublicationLease(input);
    await lease.release();
  } catch (error) {
    if (error instanceof Error && error.message.includes("holds the active kernel lease")) {
      held = true;
    } else {
      throw error;
    }
  }
  if (!held) throw new Error("publication lease was not held through authoritative readback");
}
