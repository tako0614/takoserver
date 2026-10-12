import type { V2Operation } from "./types.ts";

const MAX_STEPS = 8;
const MAX_ELAPSED_MS = 20_000;
const CONTINUATION_DELAY_MS = 1_000;

/**
 * Opportunistic Worker progress, never an Operation queue or recovery authority.
 * Every pass goes through the Host's durable candidate, lease and dispatch fences.
 * The unchanged Cron can resume anything canceled with its request lifetime.
 */
export async function drainV2Operations(
  tick: () => Promise<V2Operation | null>,
  options: {
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly maxSteps?: number;
    readonly maxElapsedMs?: number;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxSteps = options.maxSteps ?? MAX_STEPS;
  const maxElapsedMs = options.maxElapsedMs ?? MAX_ELAPSED_MS;
  const deadline = now() + maxElapsedMs;
  for (let step = 0; step < maxSteps && now() < deadline; step += 1) {
    const result = await tick();
    if (!result) return;
    // An uncertain result uses the engine's durable backoff. Do not poll it
    // early or turn a failed native ACK into a second dispatch.
    if (result.status === "reconciling" && result.error) return;
    if (result.status === "reconciling") {
      // The engine persists a one-second eligibility delay for known
      // checkpointed continuation. Wait once, then re-enter through runNext.
      if (deadline - now() <= CONTINUATION_DELAY_MS) return;
      await sleep(CONTINUATION_DELAY_MS);
    }
  }
}
