import type { TakoformV1Alpha3FormRef } from "./form-ref.ts";
import type { TakoformInterfaceRef } from "./interface-ref.ts";

/** Exact software capability; neither an Offering nor a support/activation grant. */
export interface WorkerClassRuntimeContract {
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly packageDigest: `sha256:${string}`;
  readonly runtimeClassRef: TakoformInterfaceRef;
}

export interface WorkerClassResourceIdentity {
  readonly uid: string;
  readonly generation: string;
  readonly revision: string;
  readonly formRef: TakoformV1Alpha3FormRef;
}

/** Host-resolved facts only. No tenant code, environment values, or live Actor state. */
export interface WorkerClassInspectionInput {
  readonly contract: WorkerClassRuntimeContract;
  readonly tenantId: string;
  readonly space: string;
  readonly className: string;
  readonly holder: WorkerClassResourceIdentity;
  readonly worker: WorkerClassResourceIdentity;
  readonly deployment: WorkerClassResourceIdentity;
  readonly version: WorkerClassResourceIdentity;
  readonly weight: number;
  readonly bundle: WorkerClassResourceIdentity & { readonly manifestDigest: `sha256:${string}` };
}

export type WorkerClassInspectionVerdict = "valid" | "invalid" | "unavailable";

/**
 * The provider must inspect the exact closed module graph in an isolated
 * inspection runtime, without constructing the class or supplying live state
 * or sensitive environment. Native wrapper/declared-handler readback is not
 * class inspection. Failure or missing inspection capability is unavailable.
 */
export interface ProviderWorkerClassRuntime {
  readonly contracts: readonly WorkerClassRuntimeContract[];
  inspect(
    input: WorkerClassInspectionInput & {
      readonly providerInstallationRef: string;
      readonly holderNativeId: string;
      readonly versionNativeId: string;
    },
  ): Promise<WorkerClassInspectionVerdict>;
}

/** Selected-deployment adapter used by the Host's existing readiness path. */
export interface WorkerClassRuntime {
  readonly contracts: readonly WorkerClassRuntimeContract[];
  inspect(input: readonly WorkerClassInspectionInput[]): Promise<WorkerClassInspectionVerdict>;
}
