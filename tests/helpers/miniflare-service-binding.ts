import { MiniflareOptionsSchema } from "miniflare";

type ServiceBindingKind = "durable-object" | "worker";

/**
 * Miniflare renamed the service-binding worker selector from `workerName` to
 * `worker`.  The public package is also exercised as a vendored dependency by
 * the private composition, so the test process can legitimately resolve
 * either pinned dependency tree.  Probe the loaded schema once instead of
 * letting the test depend on whichever checkout happened to provide
 * `node_modules`.
 */
const SERVICE_BINDING_SELECTOR = supportsWorkerSelector() ? "worker" : "workerName";

export function miniflareServiceBinding(
  type: ServiceBindingKind,
  workerName: string,
  exportName: string,
): {
  readonly type: ServiceBindingKind;
  readonly worker?: string;
  readonly workerName?: string;
  readonly exportName: string;
} {
  return {
    type,
    [SERVICE_BINDING_SELECTOR]: workerName,
    exportName,
  };
}

function supportsWorkerSelector(): boolean {
  const probe = {
    workers: [
      {
        config: {
          name: "miniflare-binding-shape-probe",
          type: "worker" as const,
          compatibilityDate: "2026-08-18",
          env: {
            TARGET: {
              type: "worker" as const,
              worker: "miniflare-binding-shape-probe",
              exportName: "default",
            },
          },
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": { type: "esm" as const, contents: "export default {};" },
            },
          },
        },
      },
    ],
  };
  return MiniflareOptionsSchema.safeParse(probe).success;
}
