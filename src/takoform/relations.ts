import { canonicalDigest, canonicalJson } from "../json.ts";
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
import { crossResourcePrecondition, TakoformHostError } from "./types.ts";

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

export interface TakoformDeclaredResourceClaim {
  readonly key: string;
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
  const relations = deriveRelations(form.desiredSchema);
  for (const constraint of form.constraints ?? []) {
    if (constraint.kind === "exclusive") {
      if (
        !pointer(constraint.reference) ||
        (constraint.keyedBy !== undefined && !pointer(constraint.keyedBy)) ||
        !relations.some((relation) => relation.pointer === constraint.reference)
      ) {
        throw new TypeError("invalid exclusive constraint");
      }
      continue;
    }
    if (constraint.kind === "sum") {
      if (
        !pointer(constraint.list) ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(constraint.member) ||
        !Number.isSafeInteger(constraint.total)
      ) {
        throw new TypeError("invalid sum constraint");
      }
      continue;
    }
    if (constraint.kind === "claim") {
      if (!pointer(constraint.property)) throw new TypeError("invalid claim constraint");
      continue;
    }
    if (constraint.kind === "hostAssigned") {
      if (!pointer(constraint.output) || !form.outputSchema) {
        throw new TypeError("invalid host-assigned constraint");
      }
      continue;
    }
    if (constraint.kind === "orderedPair") {
      if (!validPair(constraint.references)) throw new TypeError("invalid ordered-pair constraint");
      continue;
    }
    if (constraint.kind === "uniqueBy") {
      if (!pointer(constraint.list) || !memberName(constraint.member)) {
        throw new TypeError("invalid unique-by constraint");
      }
      continue;
    }
    if (constraint.kind === "acyclic") {
      if (
        !pointer(constraint.reference) ||
        !relations.some((relation) => relation.pointer === constraint.reference)
      ) {
        throw new TypeError("invalid acyclic constraint");
      }
      continue;
    }
    if (constraint.kind === "distinctPair" || constraint.kind === "uniquePair") {
      if (
        !validPair(constraint.references) ||
        !constraint.references.every((reference) =>
          relations.some((relation) => relation.pointer === reference),
        )
      ) {
        throw new TypeError(`invalid ${constraint.kind} constraint`);
      }
      continue;
    }
    if (constraint.kind === "sameResolvedTarget") {
      if (
        !pointer(constraint.anchor) ||
        !pointer(constraint.members) ||
        !pointer(constraint.through) ||
        !relations.some((relation) => relation.pointer === constraint.anchor) ||
        !relations.some((relation) => relation.pointer === constraint.members)
      ) {
        throw new TypeError("invalid same-resolved-target constraint");
      }
      continue;
    }
    throw new TypeError("unknown Form constraint");
  }
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
      // The neighbour this relation names is simply not there yet. The operator
      // declares it and re-applies under the same plan-derived key, so this
      // refusal must not be the answer to that second ask.
      throw crossResourcePrecondition({
        code: "resource_not_found",
        status: 404,
        details: { pointer: instance.concretePointer },
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

/** Enforces stable-v1 desired-document rules before relation resolution. */
export function validateDeclaredConstraintRequest(input: {
  readonly resourceName: string;
  readonly form: InstalledTakoformForm;
  readonly spec: JsonObject;
}): void {
  for (const constraint of input.form.constraints ?? []) {
    if (constraint.kind === "sum") {
      const entries = pointerValue(input.spec, constraint.list);
      if (
        !Array.isArray(entries) ||
        entries.reduce((total, entry) => {
          if (!record(entry)) return Number.NaN;
          const value = entry[constraint.member];
          return typeof value === "number" && Number.isSafeInteger(value)
            ? total + value
            : Number.NaN;
        }, 0) !== constraint.total
      ) {
        throw new TakoformHostError("invalid_argument", 400, { constraint: "sum" });
      }
      continue;
    }
    if (constraint.kind === "orderedPair") {
      const [leftPointer, rightPointer] = constraint.references;
      const left = pointerValue(input.spec, leftPointer);
      const right = pointerValue(input.spec, rightPointer);
      if (
        typeof left !== "number" ||
        !Number.isFinite(left) ||
        typeof right !== "number" ||
        !Number.isFinite(right) ||
        left > right
      ) {
        throw new TakoformHostError("invalid_argument", 400, { constraint: "orderedPair" });
      }
      continue;
    }
    if (constraint.kind === "uniqueBy") {
      const entries = pointerValue(input.spec, constraint.list);
      if (!Array.isArray(entries)) {
        throw new TakoformHostError("invalid_argument", 400, { constraint: "uniqueBy" });
      }
      const seen = new Set<string>();
      for (const entry of entries) {
        if (!record(entry)) {
          throw new TakoformHostError("invalid_argument", 400, { constraint: "uniqueBy" });
        }
        const value = entry[constraint.member];
        const key = scalarKey(value);
        if (key === null || seen.has(key)) {
          throw new TakoformHostError("invalid_argument", 400, { constraint: "uniqueBy" });
        }
        seen.add(key);
      }
      continue;
    }
    if (constraint.kind !== "acyclic") continue;
    const value = pointerValue(input.spec, constraint.reference);
    if (
      record(value) &&
      value.apiVersion === input.form.identity.formRef.apiVersion &&
      value.kind === input.form.identity.formRef.kind &&
      value.name === input.resourceName
    ) {
      throw new TakoformHostError("invalid_argument", 400, { constraint: "acyclic" });
    }
  }
}

/**
 * Enforces the installed Definition's portable cross-resource mechanisms.
 *
 * Every refusal here is read off *another resource's* live state — a claim
 * somebody else holds, a pinned target that moved, a cycle the neighbours make
 * — so every one of them is a `crossResourcePrecondition`. The document that
 * arrived is not what is wrong, and the operator cures it by changing the
 * neighbour, which leaves this resource's plan, and therefore the released
 * provider's idempotency key, byte-identical. The purely document-shaped rules
 * — `sum`, `orderedPair`, `uniqueBy`, `distinctPair`, and the self-reference
 * `acyclic` check in `validateDeclaredConstraintRequest` — stay plain
 * `invalid_argument`, because for those the stored answer really is still the
 * answer. See [ADR 0008](../../docs/adr/0008-a-settled-refusal-about-the-host-is-re-attempted.md).
 */
export async function validateDeclaredConstraints(input: {
  readonly tenantId: string;
  readonly space: string;
  readonly resourceName: string;
  readonly form: InstalledTakoformForm;
  readonly spec: JsonObject;
  readonly relations: readonly TakoformStoredRelation[];
  readonly forms: FormRegistry;
  /** Review checks relation- and live-state-dependent mechanisms without reserving their claims. */
  readonly reviewPhaseOnly?: boolean;
  readonly store: Pick<
    TakoformStore,
    | "committedResourceClaimHolder"
    | "resourcesByRelation"
    | "readResource"
    | "readRelations"
    | "resourceClaimHolder"
  >;
}): Promise<void> {
  for (const constraint of input.form.constraints ?? []) {
    if (
      input.reviewPhaseOnly &&
      !["claim", "acyclic", "distinctPair", "uniquePair", "sameResolvedTarget"].includes(
        constraint.kind,
      )
    ) {
      continue;
    }
    if (constraint.kind === "orderedPair" || constraint.kind === "uniqueBy") continue;
    if (constraint.kind === "acyclic") {
      await validateAcyclicConstraint(input, constraint.reference);
      continue;
    }
    if (constraint.kind === "distinctPair") {
      const left = oneRelation("distinctPair", constraint.references[0], input.relations);
      const right = oneRelation("distinctPair", constraint.references[1], input.relations);
      if (!left || !right) continue;
      if (left.targetUid === right.targetUid) {
        throw new TakoformHostError("invalid_argument", 400, { constraint: "distinctPair" });
      }
      continue;
    }
    if (constraint.kind === "uniquePair") {
      const pair = requiredUidPair("uniquePair", constraint.references, input.relations);
      const key = await uniquePairClaimKey({
        tenantId: input.tenantId,
        form: input.form,
        pair,
      });
      const holder = await input.store.resourceClaimHolder(key);
      if (
        holder &&
        (holder.holderSpace !== input.space ||
          holder.holderApiVersion !== input.form.identity.formRef.apiVersion ||
          holder.holderKind !== input.form.identity.formRef.kind ||
          holder.holderName !== input.resourceName)
      ) {
        throw crossResourcePrecondition({ details: { constraint: "uniquePair" } });
      }
      continue;
    }
    if (constraint.kind === "sameResolvedTarget") {
      await validateSameResolvedTargetConstraint(input, constraint);
      continue;
    }
    if (constraint.kind === "sum") {
      const entries = pointerValue(input.spec, constraint.list);
      if (
        !Array.isArray(entries) ||
        entries.reduce((total, entry) => {
          if (!record(entry)) return Number.NaN;
          const value = entry[constraint.member];
          return typeof value === "number" && Number.isSafeInteger(value)
            ? total + value
            : Number.NaN;
        }, 0) !== constraint.total
      ) {
        throw new TakoformHostError("invalid_argument", 400);
      }
      continue;
    }
    if (constraint.kind === "exclusive") {
      const relation = input.relations.find(
        (candidate) => candidate.relation === constraint.reference,
      );
      if (!relation) continue;
      const holders = await input.store.resourcesByRelation({
        tenantId: input.tenantId,
        space: input.space,
        sourceApiVersion: input.form.identity.formRef.apiVersion,
        sourceKind: input.form.identity.formRef.kind,
        relation: constraint.reference,
        targetUid: relation.targetUid,
        limit: 2,
      });
      const keyValue = constraint.keyedBy
        ? pointerValue(input.spec, constraint.keyedBy)
        : undefined;
      if (constraint.keyedBy && keyValue === undefined) {
        throw new TakoformHostError("invalid_argument", 400);
      }
      const key = keyValue === undefined ? undefined : canonicalJson(keyValue);
      if (
        holders.some((holder) => {
          if (holder.resource.metadata.name === input.resourceName) return false;
          if (key === undefined) return true;
          const holderKey = pointerValue(holder.resource.spec, constraint.keyedBy ?? "");
          return holderKey !== undefined && key === canonicalJson(holderKey);
        })
      ) {
        throw crossResourcePrecondition();
      }
      continue;
    }
    if (constraint.kind === "claim") {
      const value = pointerValue(input.spec, constraint.property);
      if (value === undefined) throw new TakoformHostError("invalid_argument", 400);
      const holder = await input.store.committedResourceClaimHolder(
        await claimConstraintKey({
          tenantId: input.tenantId,
          form: input.form,
          property: constraint.property,
          value,
        }),
      );
      if (
        holder &&
        (holder.holderSpace !== input.space ||
          holder.holderApiVersion !== input.form.identity.formRef.apiVersion ||
          holder.holderKind !== input.form.identity.formRef.kind ||
          holder.holderName !== input.resourceName)
      ) {
        throw crossResourcePrecondition({ details: { holder: holder.holderName } });
      }
    }
  }
}

const MAXIMUM_CONSTRAINT_TRAVERSAL = 256;

function relationsForDeclaration(
  relations: readonly TakoformStoredRelation[],
  pointer: string,
): readonly TakoformStoredRelation[] {
  return relations.filter((relation) => relation.relation === pointer);
}

function oneRelation(
  kind: string,
  pointer: string,
  relations: readonly TakoformStoredRelation[],
): TakoformStoredRelation | null {
  const matches = relationsForDeclaration(relations, pointer);
  if (matches.length === 0) return null;
  if (matches.length !== 1 || !matches[0]?.targetUid) {
    throw new TakoformHostError("invalid_argument", 400, { constraint: kind, pointer });
  }
  return matches[0];
}

function requiredUidPair(
  kind: string,
  references: readonly [string, string],
  relations: readonly TakoformStoredRelation[],
): readonly [string, string] {
  const left = oneRelation(kind, references[0], relations);
  const right = oneRelation(kind, references[1], relations);
  if (!left || !right) {
    throw new TakoformHostError("invalid_argument", 400, { constraint: kind });
  }
  return [left.targetUid, right.targetUid];
}

async function livePinnedTarget(
  input: {
    readonly tenantId: string;
    readonly space: string;
    readonly store: Pick<TakoformStore, "readResource">;
  },
  kind: string,
  relation: TakoformStoredRelation,
): Promise<NonNullable<Awaited<ReturnType<TakoformStore["readResource"]>>>> {
  const current = await input.store.readResource({
    tenantId: input.tenantId,
    space: input.space,
    apiVersion: relation.targetApiVersion,
    kind: relation.targetKind,
    name: relation.targetName,
  });
  if (
    !current ||
    current.metadata.uid !== relation.targetUid ||
    !sameForm(current.form.formRef, relation.targetFormRef)
  ) {
    throw crossResourcePrecondition({ details: { constraint: kind } });
  }
  return current;
}

async function validateAcyclicConstraint(
  input: {
    readonly tenantId: string;
    readonly space: string;
    readonly resourceName: string;
    readonly form: InstalledTakoformForm;
    readonly relations: readonly TakoformStoredRelation[];
    readonly store: Pick<TakoformStore, "readResource" | "readRelations">;
  },
  reference: string,
): Promise<void> {
  let edge = oneRelation("acyclic", reference, input.relations);
  if (!edge) return;
  const source = await input.store.readResource({
    tenantId: input.tenantId,
    space: input.space,
    apiVersion: input.form.identity.formRef.apiVersion,
    kind: input.form.identity.formRef.kind,
    name: input.resourceName,
  });
  const seen = new Set<string>();
  if (source && sameForm(source.form.formRef, input.form.identity.formRef)) {
    seen.add(source.metadata.uid);
  }
  for (let step = 0; step < MAXIMUM_CONSTRAINT_TRAVERSAL; step += 1) {
    if (seen.has(edge.targetUid)) {
      throw crossResourcePrecondition({ details: { constraint: "acyclic" } });
    }
    seen.add(edge.targetUid);
    const target = await livePinnedTarget(input, "acyclic", edge);
    if (!sameForm(target.form.formRef, input.form.identity.formRef)) return;
    const targetRelations = await input.store.readRelations({
      tenantId: input.tenantId,
      space: input.space,
      apiVersion: edge.targetApiVersion,
      kind: edge.targetKind,
      name: edge.targetName,
    });
    edge = oneRelation("acyclic", reference, targetRelations);
    if (!edge) return;
  }
  throw crossResourcePrecondition({ details: { constraint: "acyclic" } });
}

async function validateSameResolvedTargetConstraint(
  input: {
    readonly tenantId: string;
    readonly space: string;
    readonly forms: FormRegistry;
    readonly relations: readonly TakoformStoredRelation[];
    readonly store: Pick<TakoformStore, "readResource" | "readRelations">;
  },
  constraint: Extract<
    NonNullable<InstalledTakoformForm["constraints"]>[number],
    { readonly kind: "sameResolvedTarget" }
  >,
): Promise<void> {
  const anchor = oneRelation("sameResolvedTarget", constraint.anchor, input.relations);
  if (!anchor) {
    throw new TakoformHostError("invalid_argument", 400, {
      constraint: "sameResolvedTarget",
    });
  }
  await livePinnedTarget(input, "sameResolvedTarget", anchor);
  for (const memberRelation of relationsForDeclaration(input.relations, constraint.members)) {
    const member = await livePinnedTarget(input, "sameResolvedTarget", memberRelation);
    const memberForm = input.forms.get(formKey(member.form.formRef));
    if (!memberForm) {
      throw new TakoformHostError("invalid_argument", 400, {
        constraint: "sameResolvedTarget",
      });
    }
    if (
      deriveRelations(memberForm.desiredSchema).filter(
        (relation) => relation.pointer === constraint.through,
      ).length !== 1
    ) {
      throw new TakoformHostError("invalid_argument", 400, {
        constraint: "sameResolvedTarget",
      });
    }
    const memberRelations = await input.store.readRelations({
      tenantId: input.tenantId,
      space: input.space,
      apiVersion: memberRelation.targetApiVersion,
      kind: memberRelation.targetKind,
      name: memberRelation.targetName,
    });
    const through = oneRelation("sameResolvedTarget", constraint.through, memberRelations);
    if (!through) {
      throw crossResourcePrecondition({ details: { constraint: "sameResolvedTarget" } });
    }
    await livePinnedTarget(input, "sameResolvedTarget", through);
    if (through.targetUid !== anchor.targetUid) {
      throw crossResourcePrecondition({ details: { constraint: "sameResolvedTarget" } });
    }
  }
}

async function uniquePairClaimKey(input: {
  readonly tenantId: string;
  readonly form: InstalledTakoformForm;
  readonly pair: readonly [string, string];
}): Promise<string> {
  return `unique_pair_${await canonicalDigest({
    tenantId: input.tenantId,
    formRef: input.form.identity.formRef,
    pair: input.pair,
  })}`;
}

/**
 * Canonical unique keys for Definition-declared exclusivity and claims.
 *
 * These keys are reserved in durable SQL before a provider await. They contain
 * only a digest of the portable declaration, so an arbitrary claimed value is
 * neither used as SQL identity nor repeated in the claim table.
 */
export async function declaredResourceClaims(input: {
  readonly tenantId: string;
  readonly space: string;
  readonly form: InstalledTakoformForm;
  readonly spec: JsonObject;
  readonly relations: readonly TakoformStoredRelation[];
}): Promise<readonly TakoformDeclaredResourceClaim[]> {
  const claims: TakoformDeclaredResourceClaim[] = [];
  for (const constraint of input.form.constraints ?? []) {
    if (constraint.kind === "uniquePair") {
      claims.push({
        key: await uniquePairClaimKey({
          tenantId: input.tenantId,
          form: input.form,
          pair: requiredUidPair("uniquePair", constraint.references, input.relations),
        }),
      });
      continue;
    }
    if (constraint.kind === "claim") {
      const value = pointerValue(input.spec, constraint.property);
      if (value === undefined) throw new TakoformHostError("invalid_argument", 400);
      claims.push({
        key: await claimConstraintKey({
          tenantId: input.tenantId,
          form: input.form,
          property: constraint.property,
          value,
        }),
      });
      continue;
    }
    if (constraint.kind !== "exclusive") continue;
    const relation = input.relations.find(
      (candidate) => candidate.relation === constraint.reference,
    );
    if (!relation) continue;
    const keyedValue = constraint.keyedBy ? pointerValue(input.spec, constraint.keyedBy) : null;
    if (constraint.keyedBy && keyedValue === undefined) {
      throw new TakoformHostError("invalid_argument", 400);
    }
    claims.push({
      key: await exclusiveRelationClaimKey({
        tenantId: input.tenantId,
        space: input.space,
        apiVersion: input.form.identity.formRef.apiVersion,
        kind: input.form.identity.formRef.kind,
        reference: constraint.reference,
        targetUid: relation.targetUid,
        keyedBy: constraint.keyedBy ?? null,
        keyedValue,
      }),
    });
  }
  return claims.sort((left, right) => left.key.localeCompare(right.key));
}

/**
 * The one spelling of the canonical key an `exclusive` constraint reserves.
 *
 * A reader that only wants to know whether somebody is *already* creating the
 * one resource this constraint admits needs the identical key the writer
 * reserves, so both go through here rather than through two copies of the same
 * digest input.
 */
export async function exclusiveRelationClaimKey(input: {
  readonly tenantId: string;
  readonly space: string;
  readonly apiVersion: string;
  readonly kind: string;
  readonly reference: string;
  readonly targetUid: string;
  readonly keyedBy?: string | null;
  readonly keyedValue?: unknown;
}): Promise<string> {
  return `exclusive_${await canonicalDigest({
    tenantId: input.tenantId,
    space: input.space,
    form: { apiVersion: input.apiVersion, kind: input.kind },
    reference: input.reference,
    targetUid: input.targetUid,
    keyedBy: input.keyedBy ?? null,
    keyedValue: input.keyedValue ?? null,
  })}`;
}

async function claimConstraintKey(input: {
  readonly tenantId: string;
  readonly form: InstalledTakoformForm;
  readonly property: string;
  readonly value: unknown;
}): Promise<string> {
  return `claim_${await canonicalDigest({
    tenantId: input.tenantId,
    form: {
      apiVersion: input.form.identity.formRef.apiVersion,
      kind: input.form.identity.formRef.kind,
    },
    property: input.property,
    value: input.value,
  })}`;
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

function pointer(value: string): boolean {
  return /^\/(?:[^~/]|~[01])+(?:\/(?:[^~/]|~[01])+)*$/u.test(value);
}

function validPair(value: readonly string[]): value is readonly [`/${string}`, `/${string}`] {
  return value.length === 2 && value[0] !== value[1] && value.every(pointer);
}

function memberName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value);
}

function scalarKey(value: unknown): string | null {
  if (typeof value === "string") return `string\0${value}`;
  if (typeof value === "boolean") return `boolean\0${String(value)}`;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `number\0${canonicalJson(Object.is(value, -0) ? 0 : value)}`;
  }
  return null;
}

function pointerValue(root: unknown, value: string): unknown {
  if (!pointer(value)) return undefined;
  let current = root;
  for (const token of value
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
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
