import { canonicalDigest, isJsonObject } from "../json.ts";
import type { JsonObject } from "../ports.ts";
import { exactInstalledForm, installedForms } from "./forms.ts";
import type { InstalledTakoformForm, TakoformOperation, TakoformV1Alpha3FormRef } from "./types.ts";

const OPERATIONS = new Set<TakoformOperation>([
  "create",
  "read",
  "update",
  "delete",
  "import",
  "observe",
]);
const ROLES = new Set<NonNullable<InstalledTakoformForm["role"]>>([
  "identity",
  "revision",
  "deployment",
  "attachment",
  "policy",
]);

/**
 * Materializes the portable Definition data stored in an admitted package.
 *
 * This does not make the Definition executable. The Host authority separately
 * intersects it with an exact build/provider implementation candidate. Keeping
 * the materialization package-derived lets a valid third-party install remain
 * discoverable as installed-but-unsupported without turning the build corpus
 * into a publisher allowlist.
 */
export async function installedFormFromDefinition(
  definition: unknown,
  formRef: TakoformV1Alpha3FormRef,
  packageDigest: `sha256:${string}`,
): Promise<InstalledTakoformForm | null> {
  if (
    !isJsonObject(definition) ||
    definition.apiVersion !== formRef.apiVersion ||
    definition.kind !== formRef.kind ||
    definition.definitionVersion !== formRef.definitionVersion ||
    (await canonicalDigest(definition)) !== formRef.schemaDigest ||
    !isJsonObject(definition.desiredSchema) ||
    !Array.isArray(definition.lifecycleCapabilities)
  ) {
    return null;
  }
  const operations = definition.lifecycleCapabilities;
  if (
    operations.some(
      (operation) =>
        typeof operation !== "string" || !OPERATIONS.has(operation as TakoformOperation),
    ) ||
    new Set(operations).size !== operations.length
  ) {
    return null;
  }
  if (
    definition.role !== undefined &&
    (typeof definition.role !== "string" ||
      !ROLES.has(definition.role as NonNullable<InstalledTakoformForm["role"]>))
  ) {
    return null;
  }
  if (definition.requiresHostApi !== undefined && typeof definition.requiresHostApi !== "string") {
    return null;
  }
  if (
    (definition.constraints !== undefined && !Array.isArray(definition.constraints)) ||
    (definition.providedInterfaces !== undefined &&
      !Array.isArray(definition.providedInterfaces)) ||
    (definition.acceptedBindings !== undefined && !Array.isArray(definition.acceptedBindings)) ||
    (definition.observedSchema !== undefined && !isJsonObject(definition.observedSchema)) ||
    (definition.outputSchema !== undefined && !isJsonObject(definition.outputSchema))
  ) {
    return null;
  }

  const form: InstalledTakoformForm = {
    identity: { formRef: structuredClone(formRef), packageDigest },
    ...(typeof definition.title === "string" ? { displayName: definition.title } : {}),
    ...(typeof definition.description === "string" ? { description: definition.description } : {}),
    ...(typeof definition.requiresHostApi === "string"
      ? { requiresHostApi: definition.requiresHostApi }
      : {}),
    ...(typeof definition.role === "string"
      ? { role: definition.role as NonNullable<InstalledTakoformForm["role"]> }
      : {}),
    ...(Array.isArray(definition.constraints)
      ? { constraints: structuredClone(definition.constraints) as never }
      : {}),
    ...(Array.isArray(definition.providedInterfaces)
      ? { providedInterfaces: structuredClone(definition.providedInterfaces) as never }
      : {}),
    ...(Array.isArray(definition.acceptedBindings)
      ? { acceptedBindings: structuredClone(definition.acceptedBindings) as never }
      : {}),
    desiredSchema: structuredClone(definition.desiredSchema) as JsonObject,
    ...(isJsonObject(definition.observedSchema)
      ? { observedSchema: structuredClone(definition.observedSchema) as JsonObject }
      : {}),
    ...(isJsonObject(definition.outputSchema)
      ? { outputSchema: structuredClone(definition.outputSchema) as JsonObject }
      : {}),
    operations: operations as TakoformOperation[],
  };
  try {
    return exactInstalledForm(formRef, installedForms([form], "forms.takoform.com/v1")) ?? null;
  } catch {
    return null;
  }
}
