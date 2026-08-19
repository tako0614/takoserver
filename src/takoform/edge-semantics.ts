import type { JsonObject } from "../ports.ts";
import type { InstalledTakoformForm, TakoformDiagnostic } from "./types.ts";

const EDGE_FORMS = "edge.forms.takoform.com/v1alpha1";

/** Semantic rules that a JSON Schema cannot express for the official Edge Forms. */
export function validateEdgeSemantics(
  form: InstalledTakoformForm,
  spec: JsonObject,
): readonly TakoformDiagnostic[] {
  if (
    form.identity.formRef.apiVersion !== EDGE_FORMS ||
    form.identity.formRef.kind !== "WorkerCronTrigger"
  ) {
    return [];
  }
  const cron = spec.cron;
  return typeof cron === "string" && validCron(cron)
    ? []
    : [{ severity: "error", field: "/cron", message: "invalid portable UTC cron expression" }];
}

/** Canonicalize Edge values before validation, prepare hashing, and provider dispatch. */
export function canonicalizeEdgeSpec(form: InstalledTakoformForm, spec: JsonObject): JsonObject {
  if (
    form.identity.formRef.apiVersion !== EDGE_FORMS ||
    form.identity.formRef.kind !== "WorkerCustomDomain" ||
    typeof spec.hostname !== "string"
  ) {
    return spec;
  }
  return {
    ...spec,
    hostname: spec.hostname.replace(/\.$/u, "").toLowerCase(),
  };
}

const CRON_FIELDS = [
  { minimum: 0, maximum: 59 },
  { minimum: 0, maximum: 23 },
  { minimum: 1, maximum: 31 },
  { minimum: 1, maximum: 12 },
  { minimum: 0, maximum: 6 },
] as const;

function validCron(expression: string): boolean {
  const fields = expression.split(" ");
  return (
    fields.length === CRON_FIELDS.length &&
    fields.every((field, index) => {
      const domain = CRON_FIELDS[index];
      return domain !== undefined && validCronField(field, domain.minimum, domain.maximum);
    })
  );
}

function validCronField(field: string, minimum: number, maximum: number): boolean {
  if (field === "") return false;
  return field.split(",").every((term) => validCronTerm(term, minimum, maximum));
}

function validCronTerm(term: string, minimum: number, maximum: number): boolean {
  const pieces = term.split("/");
  if (pieces.length > 2) return false;
  const body = pieces[0];
  const step = pieces[1];
  if (!body) return false;
  if (step !== undefined) {
    const parsed = cronNumber(step);
    if (parsed === null || parsed < 1 || parsed > maximum - minimum) return false;
  }
  if (body === "*") return true;
  const range = body.split("-");
  if (range.length === 2) {
    const low = cronNumber(range[0] ?? "");
    const high = cronNumber(range[1] ?? "");
    return low !== null && high !== null && low >= minimum && high <= maximum && low <= high;
  }
  if (range.length !== 1 || step !== undefined) return false;
  const value = cronNumber(body);
  return value !== null && value >= minimum && value <= maximum;
}

function cronNumber(value: string): number | null {
  if (!/^[0-9]{1,2}$/u.test(value)) return null;
  return Number(value);
}
