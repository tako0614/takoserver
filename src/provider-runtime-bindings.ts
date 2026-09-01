import type { JsonObject } from "./ports.ts";
import type {
  ProviderPack,
  RuntimeBindingMaterializer,
  RuntimeBindingMaterialRoute,
} from "./provider-pack.ts";
import type {
  ProviderRelation,
  ProviderRuntimeBinding,
  ResourceIdentity,
} from "./provider-port.ts";
import type { ResourceDeployment } from "./resource-deployments.ts";
import type { TakoformBindingRef } from "./takoform/types.ts";
import { TakoformHostError } from "./takoform/types.ts";

/**
 * Executes the one provider-private runtime Binding protocol.
 *
 * A cross-provider relation is never accepted because two deployments happen
 * to look compatible. The target pack must export the exact Binding and the
 * selected consumer pack must import that same identity. Both calls are
 * read-only materialization of an existing realization; mutation, credential
 * issuance, and public endpoint projection do not belong at this seam.
 */
export async function materializeProviderRuntimeBindings(input: {
  readonly tenantId: string;
  readonly source: ResourceIdentity;
  readonly sourceSpec: JsonObject;
  readonly consumerPack: ProviderPack | undefined;
  readonly packs: ReadonlyMap<string, ProviderPack>;
  readonly relations: readonly ProviderRelation[];
}): Promise<readonly ProviderRuntimeBinding[]> {
  const bindings: ProviderRuntimeBinding[] = [];
  const names = new Set<string>();
  for (const relation of input.relations) {
    const bindingRef = relation.bindingRef;
    if (!bindingRef) continue;
    const deployment = relation.deployment;
    const targetPack = deployment ? input.packs.get(deployment.providerPackRef) : undefined;
    const route = runtimeBindingRoute({
      bindingRef,
      consumerPack: input.consumerPack,
      targetPack,
    });
    const exporter = targetPack?.runtimeBindingMaterializer?.exporter;
    const importer = input.consumerPack?.runtimeBindingMaterializer?.importer;
    if (deployment?.state !== "active" || !route || !exporter || !importer) unsupported();
    const name = bindingName(input.sourceSpec, relation.pointer);
    if (!name || names.has(name)) unsupported();
    const exactRelation = relation as ProviderRelation & {
      readonly deployment: ResourceDeployment;
    };
    const exported = await exporter.exportTarget({
      tenantId: input.tenantId,
      relation: exactRelation,
      route,
    });
    if (exported === null || exported === undefined) unsupported();
    const material = await importer.importBinding({
      tenantId: input.tenantId,
      source: input.source,
      sourceSpec: input.sourceSpec,
      name,
      relation: exactRelation,
      route,
      exported: {
        providerPackRef: deployment.providerPackRef,
        materialKind: route.materialKind,
        material: exported,
      },
    });
    if (material === null || material === undefined) unsupported();
    names.add(name);
    bindings.push({
      name,
      targetUid: relation.targetUid,
      bindingRef: structuredClone(bindingRef),
      material,
    });
  }
  return bindings;
}

export function canMaterializeAcrossProviderPacks(input: {
  readonly bindingRef: TakoformBindingRef | undefined;
  readonly consumerPack: ProviderPack | undefined;
  readonly targetPack: ProviderPack | undefined;
}): boolean {
  return runtimeBindingRoute(input) !== null;
}

/**
 * Resolves one unambiguous internal route shared by the target exporter and
 * consumer importer. Material kind is part of compatibility; matching only a
 * portable Binding identity would let unrelated opaque capabilities cross.
 */
export function runtimeBindingRoute(input: {
  readonly bindingRef: TakoformBindingRef | undefined;
  readonly consumerPack: ProviderPack | undefined;
  readonly targetPack: ProviderPack | undefined;
}): RuntimeBindingMaterialRoute | null {
  return resolveRuntimeBindingMaterialRoute({
    bindingRef: input.bindingRef,
    consumer: input.consumerPack?.runtimeBindingMaterializer,
    target: input.targetPack?.runtimeBindingMaterializer,
  });
}

/** Composition-time form of runtimeBindingRoute before concrete packs exist. */
export function resolveRuntimeBindingMaterialRoute(input: {
  readonly bindingRef: TakoformBindingRef | undefined;
  readonly consumer: RuntimeBindingMaterializer | undefined;
  readonly target: RuntimeBindingMaterializer | undefined;
}): RuntimeBindingMaterialRoute | null {
  const bindingRef = input.bindingRef;
  const exports = input.target?.exporter?.routes;
  const imports = input.consumer?.importer?.routes;
  if (!bindingRef || !exports || !imports) return null;

  const matches = exports.filter(
    (candidate) =>
      sameBinding(candidate.bindingRef, bindingRef) &&
      imports.some(
        (accepted) =>
          accepted.materialKind === candidate.materialKind &&
          sameBinding(accepted.bindingRef, bindingRef),
      ),
  );
  return matches.length === 1 ? structuredClone(matches[0] as RuntimeBindingMaterialRoute) : null;
}

function sameBinding(left: TakoformBindingRef, right: TakoformBindingRef): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.name === right.name &&
    left.version === right.version &&
    left.schemaDigest === right.schemaDigest
  );
}

function bindingName(spec: JsonObject, relationPointer: string): string | null {
  const segments = relationPointer.split("/").slice(1).map(unescapePointer);
  if (segments.length < 2 || segments.at(-1) !== "resource") return null;
  let value: unknown = spec;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) return null;
      value = value[Number(segment)];
    } else if (record(value)) {
      value = value[segment];
    } else {
      return null;
    }
  }
  return record(value) && typeof value.name === "string" ? value.name : null;
}

function unescapePointer(value: string): string {
  return value.replace(/~1/gu, "/").replace(/~0/gu, "~");
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsupported(): never {
  throw new TakoformHostError("unsupported_capability", 422);
}
