import type { JsonObject, JsonValue } from "../ports.ts";
import { type BindingRegistry, bindingKey } from "./bindings.ts";
import type { FormRegistry } from "./forms.ts";
import type { ResourceAddress, TakoformStore } from "./store.ts";
import type {
  InstalledTakoformForm,
  TakoformBindingRef,
  TakoformCondition,
  TakoformInterfaceRef,
  TakoformV1Alpha3FormRef,
} from "./types.ts";
import { TakoformHostError } from "./types.ts";

/** One exact cross-resource reference stored beside the declaring Resource. */
export interface TakoformStoredRelation {
  readonly pointer: string;
  readonly relation: string;
  readonly targetApiVersion: string;
  readonly targetKind: string;
  readonly targetName: string;
  readonly targetUid: string;
  readonly targetFormRef: TakoformV1Alpha3FormRef;
  readonly bindingRef?: TakoformBindingRef;
}

interface RelationDeclaration {
  readonly pointer: string;
  readonly targetApiVersion: string;
  readonly targetKind: string;
  readonly binding?: string;
  readonly targetFormRefs?: readonly TakoformV1Alpha3FormRef[];
  readonly requiredInterface?: TakoformInterfaceRef;
}

interface RelationInstance extends RelationDeclaration {
  readonly concretePointer: string;
  readonly targetName: string;
}

const MAXIMUM_RELATION_DEPTH = 32;

/**
 * Fails host construction when an installed Form declares an unverifiable
 * relation. Relations are derived from the desired schema; there is no second
 * manually-maintained relation catalog to drift from it.
 */
export function validateRelationSchema(form: InstalledTakoformForm): void {
  deriveRelations(form.desiredSchema);
}

/**
 * Resolves and pins every relation before a provider mutation.
 *
 * A reference can see only the caller's tenant and its own space. The stored
 * UID makes deleting and recreating a target observable instead of silently
 * rebinding the source to a different incarnation with the same name.
 */
export async function resolveRelations(input: {
  readonly tenantId: string;
  readonly space: string;
  readonly form: InstalledTakoformForm;
  readonly spec: JsonObject;
  readonly forms: FormRegistry;
  readonly bindings: BindingRegistry;
  readonly store: Pick<TakoformStore, "readResource">;
}): Promise<readonly TakoformStoredRelation[]> {
  const declarations = deriveRelations(input.form.desiredSchema);
  const instances = declarations.flatMap((relation) => relationInstances(relation, input.spec));
  const result: TakoformStoredRelation[] = [];
  for (const instance of instances) {
    const address: ResourceAddress = {
      tenantId: input.tenantId,
      space: input.space,
      apiVersion: instance.targetApiVersion,
      kind: instance.targetKind,
      name: instance.targetName,
    };
    const target = await input.store.readResource(address);
    if (!target) {
      throw new TakoformHostError("resource_not_found", 404, {
        pointer: instance.concretePointer,
      });
    }
    const targetForm = input.forms.get(formKey(target.form.formRef));
    if (
      !targetForm ||
      target.form.formRef.apiVersion !== instance.targetApiVersion ||
      target.form.formRef.kind !== instance.targetKind
    ) {
      throw new TakoformHostError("invalid_argument", 400);
    }
    if (instance.targetFormRefs) {
      if (!instance.targetFormRefs.some((candidate) => sameForm(candidate, target.form.formRef))) {
        throw new TakoformHostError("invalid_argument", 400, {
          pointer: instance.concretePointer,
          requiredFormRefs: instance.targetFormRefs,
          targetFormRef: target.form.formRef,
        });
      }
    } else if (
      instance.requiredInterface &&
      !(targetForm.providedInterfaces ?? []).some((candidate) =>
        sameInterface(candidate, instance.requiredInterface as TakoformInterfaceRef),
      )
    ) {
      throw new TakoformHostError("invalid_argument", 400, {
        pointer: instance.concretePointer,
        requiredInterface: instance.requiredInterface,
        targetFormRef: target.form.formRef,
      });
    }

    let bindingRef: TakoformBindingRef | undefined;
    if (instance.binding !== undefined) {
      bindingRef = (input.form.acceptedBindings ?? []).find(
        (candidate) => candidate.name === instance.binding,
      );
      const definition = bindingRef ? input.bindings.get(bindingKey(bindingRef)) : undefined;
      if (!bindingRef || !definition) {
        throw new TakoformHostError("invalid_argument", 400, {
          pointer: instance.concretePointer,
          binding: instance.binding,
        });
      }
      if (
        input.form.role !== definition.sourceRole ||
        !definition.allowedTargetForms.some(
          (allowed) =>
            allowed.apiVersion === target.form.formRef.apiVersion &&
            allowed.kind === target.form.formRef.kind,
        ) ||
        !(targetForm.providedInterfaces ?? []).some((candidate) =>
          sameInterface(candidate, definition.targetInterface),
        )
      ) {
        throw new TakoformHostError("invalid_argument", 400, {
          pointer: instance.concretePointer,
          bindingRef,
          requiredSourceRole: definition.sourceRole,
          actualSourceRole: input.form.role ?? null,
          requiredTargetInterface: definition.targetInterface,
          allowedTargetForms: definition.allowedTargetForms,
          targetFormRef: target.form.formRef,
        });
      }
    }
    result.push({
      pointer: instance.concretePointer,
      relation: instance.pointer,
      targetApiVersion: instance.targetApiVersion,
      targetKind: instance.targetKind,
      targetName: instance.targetName,
      targetUid: target.metadata.uid,
      targetFormRef: structuredClone(target.form.formRef),
      ...(bindingRef ? { bindingRef: structuredClone(bindingRef) } : {}),
    });
  }
  return result;
}

/** Renders, but never repairs, a stored UID pin whose target moved or vanished. */
export async function relationDrift(input: {
  readonly tenantId: string;
  readonly space: string;
  readonly relations: readonly TakoformStoredRelation[];
  readonly store: Pick<TakoformStore, "readResource">;
}): Promise<TakoformCondition | null> {
  for (const relation of input.relations) {
    const current = await input.store.readResource({
      tenantId: input.tenantId,
      space: input.space,
      apiVersion: relation.targetApiVersion,
      kind: relation.targetKind,
      name: relation.targetName,
    });
    if (!current) {
      return {
        type: "Ready",
        status: "False",
        reason: "DependencyMissing",
        hostReason: boundedReason(
          `${relation.pointer} target uid ${relation.targetUid} no longer exists`,
        ),
        lastTransitionTime: "",
      };
    }
    if (
      current.metadata.uid !== relation.targetUid ||
      !sameForm(current.form.formRef, relation.targetFormRef)
    ) {
      return {
        type: "Ready",
        status: "False",
        reason: "ExternalChange",
        hostReason: boundedReason(
          `${relation.pointer} uid:${relation.targetUid}>${current.metadata.uid} form:${relation.targetFormRef.definitionVersion}@${relation.targetFormRef.schemaDigest}>${current.form.formRef.definitionVersion}@${current.form.formRef.schemaDigest}`,
        ),
        lastTransitionTime: "",
      };
    }
  }
  return null;
}

function deriveRelations(schema: JsonObject): readonly RelationDeclaration[] {
  const result: RelationDeclaration[] = [];
  walkSchema(schema, "", undefined, 0, result);
  return result.sort((left, right) => left.pointer.localeCompare(right.pointer));
}

function walkSchema(
  schema: unknown,
  pointer: string,
  inheritedBinding: string | undefined,
  depth: number,
  result: RelationDeclaration[],
): void {
  if (!record(schema)) return;
  if (depth > MAXIMUM_RELATION_DEPTH) throw new TypeError("relation schema is too deep");
  const binding =
    typeof schema["x-takoform-binding"] === "string"
      ? schema["x-takoform-binding"]
      : inheritedBinding;
  const reference = referenceShape(schema);
  if (reference) {
    if (pointer === "") throw new TypeError("desired schema root cannot be a relation");
    if (pointer.length > 128) throw new TypeError("relation pointer is too long");
    const formRefs = schema["x-takoform-target-formrefs"];
    const interfaceRef = schema["x-takoform-required-interface"];
    if ((formRefs === undefined) === (interfaceRef === undefined)) {
      throw new TypeError("relation must declare exactly one target contract");
    }
    result.push({
      pointer,
      targetApiVersion: reference.apiVersion,
      targetKind: reference.kind,
      ...(binding ? { binding } : {}),
      ...(formRefs !== undefined
        ? { targetFormRefs: targetFormRefList(formRefs) }
        : { requiredInterface: interfaceReference(interfaceRef) }),
    });
    return;
  }
  if (record(schema.items)) {
    walkSchema(schema.items, `${pointer}/*`, binding, depth + 1, result);
  }
  if (!record(schema.properties)) return;
  for (const name of Object.keys(schema.properties).sort()) {
    walkSchema(
      schema.properties[name],
      `${pointer}/${escapePointer(name)}`,
      binding,
      depth + 1,
      result,
    );
  }
}

function referenceShape(
  schema: Record<string, unknown>,
): { readonly apiVersion: string; readonly kind: string } | null {
  if (
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    !record(schema.properties)
  ) {
    return null;
  }
  if (Object.keys(schema.properties).sort().join("\0") !== "apiVersion\0kind\0name") return null;
  const required = stringList(schema.required);
  if (!required || [...required].sort().join("\0") !== "apiVersion\0kind\0name") return null;
  const apiVersion = constant(schema.properties.apiVersion);
  const kind = constant(schema.properties.kind);
  return apiVersion && kind ? { apiVersion, kind } : null;
}

function relationInstances(
  declaration: RelationDeclaration,
  spec: JsonObject,
): readonly RelationInstance[] {
  const tokens = declaration.pointer.replace(/^\//u, "").split("/");
  return descend(declaration, spec, tokens, "");
}

function descend(
  declaration: RelationDeclaration,
  value: JsonValue,
  tokens: readonly string[],
  pointer: string,
): readonly RelationInstance[] {
  if (tokens.length === 0) {
    if (!record(value) || typeof value.name !== "string" || value.name === "") return [];
    return [{ ...declaration, concretePointer: pointer, targetName: value.name }];
  }
  const [token, ...remaining] = tokens;
  if (token === "*") {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry, index) =>
      descend(declaration, entry, remaining, `${pointer}/${index}`),
    );
  }
  if (!record(value) || token === undefined) return [];
  const child = value[unescapePointer(token)];
  return child === undefined ? [] : descend(declaration, child, remaining, `${pointer}/${token}`);
}

function targetFormRefList(value: unknown): readonly TakoformV1Alpha3FormRef[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("invalid relation FormRefs");
  return value.map((entry) => formReference(entry));
}

function formReference(value: unknown): TakoformV1Alpha3FormRef {
  if (
    !record(value) ||
    Object.keys(value).sort().join("\0") !== "apiVersion\0definitionVersion\0kind\0schemaDigest"
  ) {
    throw new TypeError("invalid relation FormRef");
  }
  if (
    typeof value.apiVersion !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.definitionVersion !== "string" ||
    typeof value.schemaDigest !== "string"
  ) {
    throw new TypeError("invalid relation FormRef");
  }
  return value as unknown as TakoformV1Alpha3FormRef;
}

function interfaceReference(value: unknown): TakoformInterfaceRef {
  if (
    !record(value) ||
    Object.keys(value).sort().join("\0") !== "apiVersion\0name\0schemaDigest\0version"
  ) {
    throw new TypeError("invalid relation InterfaceRef");
  }
  if (
    value.apiVersion !== "interfaces.takoform.com/v1alpha1" ||
    typeof value.name !== "string" ||
    typeof value.version !== "string" ||
    typeof value.schemaDigest !== "string"
  ) {
    throw new TypeError("invalid relation InterfaceRef");
  }
  return value as unknown as TakoformInterfaceRef;
}

function sameInterface(left: TakoformInterfaceRef, right: TakoformInterfaceRef): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.name === right.name &&
    left.version === right.version &&
    left.schemaDigest === right.schemaDigest
  );
}

function sameForm(left: TakoformV1Alpha3FormRef, right: TakoformV1Alpha3FormRef): boolean {
  return formKey(left) === formKey(right);
}

function formKey(value: TakoformV1Alpha3FormRef): string {
  return `${value.apiVersion}\0${value.kind}\0${value.definitionVersion}\0${value.schemaDigest}`;
}

function constant(value: unknown): string | null {
  return record(value) && typeof value.const === "string" && value.const !== ""
    ? value.const
    : null;
}

function stringList(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

function record(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function unescapePointer(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function boundedReason(value: string): string {
  if (value.length > 256) throw new TypeError("relation host reason is too long");
  return value;
}
