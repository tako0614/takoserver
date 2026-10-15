import { buildEdgeForms } from "../../src/edge-forms.ts";
import type { WorkerEnv } from "../../src/entry-worker.ts";
import { PAYMENT_SETTING_VARIABLES } from "../../src/payment-settings.ts";
import { currentTakoformCandidates } from "../../src/takoform/current-candidates.ts";
import { parseTakoformV2PublicConfig } from "../../src/takoform-v2/config.ts";
import {
  createWorkerProductionComposition,
  type WorkerProductionCompositionEnv,
} from "../../src/worker-production-composition.ts";
import { type DeployPhase, mutationError, preflightError, verificationError } from "./errors.ts";
import { deploymentVariables } from "./realized-config.ts";
import {
  type DeployTarget,
  isArtifactBlobIoQuiescedTarget,
  takoformV2StorageLineage,
} from "./target.ts";

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
  "TAKOSERVER_TAKOFORM_V2_CONFIG",
] as const;

const HOSTED_BILLING_COMPOSITION_VARS = [
  "PUBLIC_ORIGIN",
  "TAKOSERVER_CONSOLE_ORIGIN",
  "TAKOSERVER_BILLING_CONFIG",
  "TAKOSERVER_HOSTED_PRICING",
  "TAKOSERVER_HOSTED_BILLING",
  "TAKOSERVER_STRIPE_MODE",
  "TAKOSERVER_HOSTED_BILLING_ACCOUNT_ID",
  "TAKOSERVER_HOSTED_BILLING_AUTHORITY",
  "TAKOSERVER_HOSTED_BILLING_ON_DEMAND",
  ...Object.values(PAYMENT_SETTING_VARIABLES),
] as const;

export type WorkerCompositionEnv = WorkerProductionCompositionEnv &
  Partial<Pick<WorkerEnv, (typeof HOSTED_BILLING_COMPOSITION_VARS)[number]>>;

/** The composition inputs the Worker reads, derived exactly as the upload does. */
export function workerCompositionEnv(target: DeployTarget): WorkerCompositionEnv {
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
  if (target.hostedBilling !== undefined) {
    for (const name of HOSTED_BILLING_COMPOSITION_VARS) {
      const value = vars[name];
      if (value !== undefined) env[name] = value;
    }
  }
  if (target.cloudflareProviderExecutor !== undefined && !isArtifactBlobIoQuiescedTarget(target)) {
    // Composition never invokes the binding. Its exact presence is the
    // credential-free capability fact the runtime requires before it exposes
    // any Cloudflare recovery/provider surface.
    env.CLOUDFLARE_PROVIDER_EXECUTOR = {} as NonNullable<
      WorkerProductionCompositionEnv["CLOUDFLARE_PROVIDER_EXECUTOR"]
    >;
  }
  return env as WorkerCompositionEnv;
}

/**
 * Composes the selected target with the Worker's supply and Form composition.
 * Financial environment inputs are retained, but SQL/Stripe realm and secret
 * qualification remain the actual entry's separate startup responsibility.
 *
 * The refusal is the composition's own message, verbatim, because that is the
 * sentence the operator would otherwise have read from `wrangler tail` with the
 * Host already down.
 */
export async function assertTargetComposes(
  phase: DeployPhase,
  target: DeployTarget,
): Promise<void> {
  if (isArtifactBlobIoQuiescedTarget(target)) return;
  const env = workerCompositionEnv(target);
  const current = currentTakoformCandidates();
  const retained = await buildEdgeForms();
  try {
    if (target.takoformV2 !== undefined) {
      const realized = env as WorkerProductionCompositionEnv & {
        readonly TAKOSERVER_TAKOFORM_V2_CONFIG?: string;
      };
      if (realized.TAKOSERVER_TAKOFORM_V2_CONFIG !== target.takoformV2.config) {
        throw new TypeError("realized v2 startup configuration differs from the selected target");
      }
      const v2 = parseTakoformV2PublicConfig(realized.TAKOSERVER_TAKOFORM_V2_CONFIG);
      // A normal Host with configured artifact Forms refuses to start without
      // the complete 0075 and 0081 schema. The historical fresh v2 payload
      // stops at 0075, so that pairing could only fail after traffic moved.
      if (
        target.schemaMaintenanceMode === undefined &&
        takoformV2StorageLineage(target) === "v2-artifacts-0075" &&
        (v2.sqliteMigrationSet !== undefined ||
          v2.workerBundle !== undefined ||
          v2.staticAssetBundle !== undefined)
      ) {
        throw new TypeError(
          "configured v2 artifact Forms require the complete 0081 schema; select takoformV2.storageLineage v2-0088, v2-0089, v2-0091 or v2-0092 storage",
        );
      }
    }
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
