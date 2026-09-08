import { base64UrlDecode, base64UrlEncode, canonicalDigest, canonicalJson } from "../json.ts";
import type { TakoformStoredRelation } from "./relations.ts";
import type { TakoformBindingRef, TakoformV1Alpha3FormRef } from "./types.ts";

/**
 * Private claim keys for Host execution dependencies. Definition claims are
 * minted only as `exclusive_`, `claim_`, or `unique_pair_`, so a Form cannot
 * collide with this namespace.
 */
export const RESOURCE_DEPENDENCY_CLAIM_PREFIX = "host-dependency:v1:";
export const RESOURCE_DEPENDENCY_PRIVATE_HOLDER = Object.freeze({
  space: "@host-dependency",
  apiVersion: "host-dependency:internal",
  kind: "HostDependency",
  name: "@host-dependency",
});
const EDGE_PREFIX = `${RESOURCE_DEPENDENCY_CLAIM_PREFIX}edge:`;
const DATA_PREFIX = `${RESOURCE_DEPENDENCY_CLAIM_PREFIX}data:`;
const SET_PREFIX = `${RESOURCE_DEPENDENCY_CLAIM_PREFIX}set:`;

export interface ResourceDependencyTarget {
  readonly space: string;
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
  readonly uid: string;
  readonly revision: string;
  readonly formRef: TakoformV1Alpha3FormRef;
}

/** One target incarnation, held once even when several relation pointers name it. */
export interface ResourceDependencyFence {
  readonly key: string;
  readonly target: ResourceDependencyTarget;
  readonly relations: readonly TakoformStoredRelation[];
}

/**
 * The complete accepted dependency set. A compact manifest detects missing
 * rows on recovery; bounded payload chunks keep every claim key below the
 * existing 1024-character schema limit even for a maximum-length Space.
 */
export interface ResourceDependencySet {
  readonly operationId: string;
  readonly manifestKey: string;
  readonly dataKeys: readonly string[];
  readonly fences: readonly ResourceDependencyFence[];
  readonly relations: readonly TakoformStoredRelation[];
}

const DATA_CHUNK_LENGTH = 768;

type TargetTuple = readonly [
  space: string,
  apiVersion: string,
  kind: string,
  name: string,
  uid: string,
  revision: string,
  formRef: readonly [
    apiVersion: string,
    kind: string,
    definitionVersion: string,
    schemaDigest: `sha256:${string}`,
  ],
];

type BindingTuple = readonly [
  apiVersion: TakoformBindingRef["apiVersion"],
  name: string,
  version: string,
  schemaDigest: `sha256:${string}`,
];

type RelationDataTuple = readonly [
  position: number,
  target: TargetTuple,
  pointer: string,
  relation: string,
  binding: BindingTuple | null,
];

type ManifestTuple = readonly [
  version: 1,
  setDigest: `sha256:${string}`,
  edgeCount: number,
  dataCount: number,
  edgeDigest: `sha256:${string}`,
];

type DependencyPayloadTuple = readonly [
  version: 1,
  tenantId: string,
  holderUid: string,
  operationId: string,
  relations: readonly RelationDataTuple[],
];

interface DecodedRelationData {
  readonly tenantId: string;
  readonly holderUid: string;
  readonly position: number;
  readonly target: ResourceDependencyTarget;
  readonly relation: TakoformStoredRelation;
}

export async function createResourceDependencySet(input: {
  readonly tenantId: string;
  readonly space: string;
  readonly holderUid: string;
  readonly operationId: string;
  readonly relations: readonly TakoformStoredRelation[];
}): Promise<ResourceDependencySet> {
  const grouped = new Map<
    string,
    { readonly target: ResourceDependencyTarget; readonly entries: DecodedRelationData[] }
  >();
  const entries: DecodedRelationData[] = [];
  for (const [position, relation] of input.relations.entries()) {
    if (!relation.targetRevision) {
      throw new TypeError("fresh resource dependency is missing its target revision");
    }
    const target: ResourceDependencyTarget = {
      space: input.space,
      apiVersion: relation.targetApiVersion,
      kind: relation.targetKind,
      name: relation.targetName,
      uid: relation.targetUid,
      revision: relation.targetRevision,
      formRef: structuredClone(relation.targetFormRef),
    };
    const entry: DecodedRelationData = {
      tenantId: input.tenantId,
      holderUid: input.holderUid,
      position,
      target,
      relation: structuredClone(relation),
    };
    entries.push(entry);
    const existing = grouped.get(target.uid);
    if (existing) {
      assertSameTarget(existing.target, relation);
      existing.entries.push(entry);
    } else {
      grouped.set(target.uid, { target, entries: [entry] });
    }
  }

  const fences: ResourceDependencyFence[] = [];
  for (const groupedTarget of grouped.values()) {
    groupedTarget.entries.sort((left, right) => left.position - right.position);
    const targetDigest = await canonicalDigest({
      tenantId: input.tenantId,
      targetUid: groupedTarget.target.uid,
    });
    const edgeDigest = await canonicalDigest({
      tenantId: input.tenantId,
      holderUid: input.holderUid,
      operationId: input.operationId,
      target: groupedTarget.target,
    });
    fences.push({
      key: `${EDGE_PREFIX}${targetDigest}:${edgeDigest}`,
      target: structuredClone(groupedTarget.target),
      relations: groupedTarget.entries.map((entry) => structuredClone(entry.relation)),
    });
  }
  fences.sort((left, right) => left.key.localeCompare(right.key));
  const payload: DependencyPayloadTuple = [
    1,
    input.tenantId,
    input.holderUid,
    input.operationId,
    entries
      .sort((left, right) => left.position - right.position)
      .map((entry) => relationTuple(entry.position, entry.target, entry.relation)),
  ];
  const setDigest = await canonicalDigest(payload);
  const encodedPayload = encode(payload);
  const dataKeys = chunks(encodedPayload, DATA_CHUNK_LENGTH).map(
    (chunk, index) =>
      `${DATA_PREFIX}${setDigest.slice("sha256:".length)}:${index.toString(36).padStart(6, "0")}:${chunk}`,
  );
  if (dataKeys.some((key) => key.length > 1_024)) {
    throw new TypeError("resource dependency data chunk is too large");
  }
  const edgeKeys = fences.map((fence) => fence.key).sort();
  const manifest: ManifestTuple = [
    1,
    setDigest,
    edgeKeys.length,
    dataKeys.length,
    await canonicalDigest(edgeKeys),
  ];
  const manifestKey = `${SET_PREFIX}${encode(manifest)}`;
  return {
    operationId: input.operationId,
    manifestKey,
    dataKeys,
    fences,
    relations: structuredClone(input.relations),
  };
}

/** Recovers only the exact set durably marked for the accepted operation. */
export async function decodeResourceDependencySet(
  keys: readonly string[],
  tenantId: string,
  holderUid: string,
  operationId: string,
): Promise<ResourceDependencySet | null> {
  const manifestKeys = keys.filter((key) => key.startsWith(SET_PREFIX));
  const edgeKeys = keys.filter((key) => key.startsWith(EDGE_PREFIX)).sort();
  const dataKeys = keys.filter((key) => key.startsWith(DATA_PREFIX)).sort();
  if (manifestKeys.length === 0 && edgeKeys.length === 0 && dataKeys.length === 0) return null;
  if (
    manifestKeys.length !== 1 ||
    manifestKeys.length + edgeKeys.length + dataKeys.length !== keys.length
  ) {
    throw new TypeError("invalid stored resource dependency set");
  }
  const manifestKey = manifestKeys[0];
  if (!manifestKey) throw new TypeError("invalid stored resource dependency manifest");
  const manifest = manifestTuple(decode(manifestKey.slice(SET_PREFIX.length)));
  if (
    manifest[2] !== edgeKeys.length ||
    manifest[3] !== dataKeys.length ||
    manifest[4] !== (await canonicalDigest(edgeKeys))
  ) {
    throw new TypeError("stored resource dependency set does not match its manifest");
  }

  const payload = dependencyPayload(
    decode(await encodedPayloadFromDataKeys(dataKeys, manifest[1])),
  );
  if (
    payload[1] !== tenantId ||
    payload[2] !== holderUid ||
    payload[3] !== operationId ||
    manifest[1] !== (await canonicalDigest(payload))
  ) {
    throw new TypeError("stored resource dependency payload has the wrong owner");
  }
  const decoded = payload[4].map((tuple) => decodedRelationData(tuple, tenantId, holderUid));
  const positions = decoded.map((entry) => entry.position).sort((left, right) => left - right);
  if (positions.some((position, index) => position !== index)) {
    throw new TypeError("stored resource dependency relation order is incomplete");
  }
  const grouped = new Map<string, DecodedRelationData[]>();
  for (const entry of decoded) {
    if (entry.tenantId !== tenantId || entry.holderUid !== holderUid) {
      throw new TypeError("stored resource dependency has the wrong holder");
    }
    const existing = grouped.get(entry.target.uid);
    if (existing) existing.push(entry);
    else grouped.set(entry.target.uid, [entry]);
  }

  const fences: ResourceDependencyFence[] = [];
  for (const entries of grouped.values()) {
    entries.sort((left, right) => left.position - right.position);
    const first = entries[0];
    if (!first) throw new TypeError("stored resource dependency target is empty");
    for (const entry of entries) assertSameTarget(first.target, entry.relation);
    const targetDigest = await canonicalDigest({ tenantId, targetUid: first.target.uid });
    const expectedEdge = `${EDGE_PREFIX}${targetDigest}:${await canonicalDigest({
      tenantId,
      holderUid,
      operationId,
      target: first.target,
    })}`;
    if (!edgeKeys.includes(expectedEdge)) {
      throw new TypeError("stored resource dependency edge is missing");
    }
    fences.push({
      key: expectedEdge,
      target: structuredClone(first.target),
      relations: entries.map((entry) => structuredClone(entry.relation)),
    });
  }
  fences.sort((left, right) => left.key.localeCompare(right.key));
  if (canonicalJson(fences.map((fence) => fence.key).sort()) !== canonicalJson(edgeKeys)) {
    throw new TypeError("stored resource dependency contains an unowned edge");
  }
  const relations = decoded
    .sort((left, right) => left.position - right.position)
    .map((entry) => structuredClone(entry.relation));
  return { operationId, manifestKey, dataKeys, fences, relations };
}

export function resourceDependencyClaimKeys(set: ResourceDependencySet): readonly string[] {
  return [set.manifestKey, ...set.dataKeys, ...set.fences.map((fence) => fence.key)].sort();
}

export function isResourceDependencyClaimKey(key: string): boolean {
  return key.startsWith(RESOURCE_DEPENDENCY_CLAIM_PREFIX);
}

export function resourceDependencyClaimRange(): readonly [string, string] {
  return [RESOURCE_DEPENDENCY_CLAIM_PREFIX, `${RESOURCE_DEPENDENCY_CLAIM_PREFIX}\uffff`];
}

export async function resourceDependencyTargetClaimRange(
  tenantId: string,
  targetUid: string,
): Promise<readonly [string, string]> {
  const digest = await canonicalDigest({ tenantId, targetUid });
  const prefix = `${EDGE_PREFIX}${digest}:`;
  return [prefix, `${prefix}\uffff`];
}

function relationTuple(
  position: number,
  target: ResourceDependencyTarget,
  relation: TakoformStoredRelation,
): RelationDataTuple {
  return [
    position,
    targetTuple(target),
    relation.pointer,
    relation.relation,
    relation.bindingRef ? bindingTuple(relation.bindingRef) : null,
  ];
}

function decodedRelationData(
  tuple: RelationDataTuple,
  tenantId: string,
  holderUid: string,
): DecodedRelationData {
  const target = targetFromTuple(tuple[1]);
  const relation: TakoformStoredRelation = {
    pointer: tuple[2],
    relation: tuple[3],
    targetApiVersion: target.apiVersion,
    targetKind: target.kind,
    targetName: target.name,
    targetUid: target.uid,
    targetRevision: target.revision,
    targetFormRef: structuredClone(target.formRef),
    ...(tuple[4] ? { bindingRef: bindingFromTuple(tuple[4]) } : {}),
  };
  return {
    tenantId,
    holderUid,
    position: tuple[0],
    target,
    relation,
  };
}

function targetTuple(target: ResourceDependencyTarget): TargetTuple {
  return [
    target.space,
    target.apiVersion,
    target.kind,
    target.name,
    target.uid,
    target.revision,
    [
      target.formRef.apiVersion,
      target.formRef.kind,
      target.formRef.definitionVersion,
      target.formRef.schemaDigest,
    ],
  ];
}

function targetFromTuple(value: unknown): ResourceDependencyTarget {
  if (
    !Array.isArray(value) ||
    value.length !== 7 ||
    !value.slice(0, 6).every(nonEmptyString) ||
    !Array.isArray(value[6]) ||
    value[6].length !== 4 ||
    !value[6].slice(0, 3).every(nonEmptyString) ||
    !digest(value[6][3])
  ) {
    throw new TypeError("invalid resource dependency target tuple");
  }
  return {
    space: String(value[0]),
    apiVersion: String(value[1]),
    kind: String(value[2]),
    name: String(value[3]),
    uid: String(value[4]),
    revision: String(value[5]),
    formRef: {
      apiVersion: String(value[6][0]),
      kind: String(value[6][1]),
      definitionVersion: String(value[6][2]),
      schemaDigest: value[6][3],
    },
  };
}

function bindingTuple(binding: TakoformBindingRef): BindingTuple {
  return [binding.apiVersion, binding.name, binding.version, binding.schemaDigest];
}

function bindingFromTuple(value: BindingTuple): TakoformBindingRef {
  return {
    apiVersion: value[0],
    name: value[1],
    version: value[2],
    schemaDigest: value[3],
  };
}

function relationDataTuple(value: unknown): RelationDataTuple {
  if (
    !Array.isArray(value) ||
    value.length !== 5 ||
    !Number.isSafeInteger(value[0]) ||
    Number(value[0]) < 0 ||
    !nonEmptyString(value[2]) ||
    !nonEmptyString(value[3]) ||
    (value[4] !== null && !bindingTupleValue(value[4]))
  ) {
    throw new TypeError("invalid resource dependency relation tuple");
  }
  targetFromTuple(value[1]);
  return value as unknown as RelationDataTuple;
}

function manifestTuple(value: unknown): ManifestTuple {
  if (
    !Array.isArray(value) ||
    value.length !== 5 ||
    value[0] !== 1 ||
    !digest(value[1]) ||
    !Number.isSafeInteger(value[2]) ||
    Number(value[2]) < 0 ||
    !Number.isSafeInteger(value[3]) ||
    Number(value[3]) < 1 ||
    !digest(value[4])
  ) {
    throw new TypeError("invalid resource dependency manifest tuple");
  }
  return value as unknown as ManifestTuple;
}

function dependencyPayload(value: unknown): DependencyPayloadTuple {
  if (
    !Array.isArray(value) ||
    value.length !== 5 ||
    value[0] !== 1 ||
    !nonEmptyString(value[1]) ||
    !nonEmptyString(value[2]) ||
    !nonEmptyString(value[3]) ||
    !Array.isArray(value[4])
  ) {
    throw new TypeError("invalid resource dependency payload");
  }
  return [1, value[1], value[2], value[3], value[4].map((entry) => relationDataTuple(entry))];
}

async function encodedPayloadFromDataKeys(
  keys: readonly string[],
  setDigest: `sha256:${string}`,
): Promise<string> {
  const parts = keys.map((key) => {
    const match = key.match(
      /^host-dependency:v1:data:([0-9a-f]{64}):([0-9a-z]{6}):([A-Za-z0-9_-]{1,768})$/u,
    );
    if (!match?.[1] || !match[2] || !match[3] || `sha256:${match[1]}` !== setDigest) {
      throw new TypeError("invalid resource dependency data key");
    }
    return { position: Number.parseInt(match[2], 36), value: match[3] };
  });
  parts.sort((left, right) => left.position - right.position);
  if (parts.some((part, index) => part.position !== index)) {
    throw new TypeError("stored resource dependency data is incomplete");
  }
  return parts.map((part) => part.value).join("");
}

function chunks(value: string, length: number): readonly string[] {
  const result: string[] = [];
  for (let start = 0; start < value.length; start += length) {
    result.push(value.slice(start, start + length));
  }
  return result.length > 0 ? result : [""];
}

function bindingTupleValue(value: unknown): value is BindingTuple {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    (value[0] === "bindings.takoform.com/v1alpha1" ||
      value[0] === "bindings.takoform.com/v1alpha2") &&
    value.slice(1, 3).every(nonEmptyString) &&
    digest(value[3])
  );
}

function assertSameTarget(
  target: ResourceDependencyTarget,
  relation: TakoformStoredRelation,
): void {
  if (
    relation.targetApiVersion !== target.apiVersion ||
    relation.targetKind !== target.kind ||
    relation.targetName !== target.name ||
    relation.targetUid !== target.uid ||
    relation.targetRevision !== target.revision ||
    canonicalJson(relation.targetFormRef) !== canonicalJson(target.formRef)
  ) {
    throw new TypeError("relations grouped under one dependency target disagree");
  }
}

function encode(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(canonicalJson(value)));
}

function decode(encoded: string): unknown {
  const bytes = base64UrlDecode(encoded);
  if (!bytes) throw new TypeError("invalid resource dependency key encoding");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new TypeError("invalid resource dependency key payload");
  }
  if (encode(parsed) !== encoded) throw new TypeError("non-canonical resource dependency payload");
  return parsed;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function digest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}
