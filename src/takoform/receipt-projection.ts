import type { JsonObject } from "../ports.ts";
import { validateSchemaValue } from "./schema.ts";
import type { InstalledTakoformForm } from "./types.ts";

/**
 * Whether a driver's own outputs are ones its Form can publish.
 *
 * The engine has always held a receipt to the Form before it materializes a
 * Resource — a driver may only report what its Form declares, and it must
 * report all of it. The trouble was *when*: that check ran after the provider
 * had mutated and, for a `WorkerEndpoint`, after the origin reservation had
 * been activated and the deletion attestation opened. The wire then said "the
 * host mutated nothing" while the ledger held an activated reservation for an
 * endpoint no `tf_resources` row would ever name, and that space could never
 * create the endpoint again.
 *
 * So the rule is named here and asked twice: once by the driver, before it
 * activates anything it would have to give back, and once by the engine, where
 * it always was. Two call sites, one rule — a second copy of the rule is how
 * the two answers start to disagree.
 */
export function receiptProjectable(
  form: InstalledTakoformForm,
  receipt: { readonly observed?: JsonObject; readonly outputs?: JsonObject },
): boolean {
  if (form.observedSchema && !receipt.observed) return false;
  if (form.outputSchema && !receipt.outputs) return false;
  if (
    form.observedSchema &&
    receipt.observed &&
    validateSchemaValue(form.observedSchema, receipt.observed, "").length > 0
  ) {
    return false;
  }
  return !(
    form.outputSchema &&
    receipt.outputs &&
    validateSchemaValue(form.outputSchema, receipt.outputs, "").length > 0
  );
}
