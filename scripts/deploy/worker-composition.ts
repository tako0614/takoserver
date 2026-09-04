import { buildEdgeForms } from "../../src/edge-forms.ts";
import { currentTakoformCandidates } from "../../src/takoform/current-candidates.ts";
import {
  createWorkerProductionComposition,
  type WorkerProductionCompositionEnv,
} from "../../src/worker-production-composition.ts";
import { type DeployPhase, mutationError, preflightError, verificationError } from "./errors.ts";
import { deploymentVariables } from "./realized-config.ts";
import type { DeployTarget } from "./target.ts";

/**
 * A target's binding closure can be exactly right and still not describe a
 * Worker that can serve.
 *
 * The closure fence proves names, types and plain-text bytes. It cannot see
 * that two supply halves of one realized target disagree about the same
 * Cloudflare `SupplyContract`, because both halves are legal JSON in their own
 * binding. The Worker only discovers that when it composes, which it does
 * lazily on its first request — after the upload, after traffic moves, and
 * after the previous Version has stopped serving.
 *
 * So every Worker publication runs the same composition the Worker runs, over
 * the same derived plain-text bindings, before it uploads anything. A target
 * that cannot compose is a pre-mutation refusal carrying the runtime's own
 * words, not a post-condition failure to roll back from.
 */

/** Plain-text composition inputs, taken from the realized target vars. */
const COMPOSITION_VARS = [
  "TAKOSERVER_OBJECT_BUCKET_SUPPLIES",
  "TAKOSERVER_EDGE_SUPPLIES",
  "TAKOSERVER_MANAGED_BASE_DOMAIN",
] as const;

/** The composition inputs the Worker reads, derived exactly as the upload does. */
export function workerCompositionEnv(target: DeployTarget): WorkerProductionCompositionEnv {
  // A JIT-enabled target needs an explicit authority profile, and the historical
  // one is the profile that requires no artifact provenance. None of the five
  // JIT bindings is a composition input, so the choice cannot change the answer.
  const derived = deploymentVariables(target, undefined, { kind: "historical-pre-jit" });
  const vars = (derived.vars ?? {}) as Readonly<Record<string, string>>;
  const env: Record<string, unknown> = {};
  for (const name of COMPOSITION_VARS) {
    const value = vars[name];
    if (value !== undefined) env[name] = value;
  }
  if (target.cloudflareProviderExecutor !== undefined) {
    // Composition never invokes the binding. Its exact presence is the
    // credential-free capability fact the runtime requires before it exposes
    // any Cloudflare recovery/provider surface.
    env.CLOUDFLARE_PROVIDER_EXECUTOR = {} as NonNullable<
      WorkerProductionCompositionEnv["CLOUDFLARE_PROVIDER_EXECUTOR"]
    >;
  }
  return env as WorkerProductionCompositionEnv;
}

/**
 * Composes the selected target with the Worker's own startup path.
 *
 * The refusal is the composition's own message, verbatim, because that is the
 * sentence the operator would otherwise have read from `wrangler tail` with the
 * Host already down.
 */
export async function assertTargetComposes(
  phase: DeployPhase,
  target: DeployTarget,
): Promise<void> {
  const env = workerCompositionEnv(target);
  const current = currentTakoformCandidates();
  const retained = await buildEdgeForms();
  try {
    createWorkerProductionComposition({
      env,
      forms: current.forms,
      retainedForms: retained.forms,
      now: new Date(),
    });
  } catch (error) {
    throw phaseError(
      phase,
      `selected target cannot compose the Worker runtime: ${refusal(error)}`,
      `${error instanceof Error ? error.name : typeof error}: ${refusal(error)}`,
    );
  }
}

function refusal(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function phaseError(phase: DeployPhase, message: string, detail?: string) {
  if (phase === "preflight") return preflightError(message, detail);
  if (phase === "mutation") return mutationError(message, detail);
  return verificationError(message, detail);
}
