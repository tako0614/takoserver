import { type InstalledTakoformForm, TakoformHostError } from "./types.ts";

/**
 * Form-provided worker classes are not executable in the control process.
 * Their semantic loading belongs to the provider execution path, so every
 * control-plane apply/import attempt must refuse them before accepting a saga.
 */
export function validateClassHolderRuntime(form: InstalledTakoformForm): void {
  if (form.workerClassRuntime) {
    throw new TakoformHostError("unsupported_capability", 422);
  }
}
