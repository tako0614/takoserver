import { bytesDigest, canonicalJson } from "../json.ts";
import type { WorkerVersionBinding } from "./forms/worker-specs.ts";

export const V2_WORKFLOW_FORWARD_SCHEMA = "takoserver.v2-workflow-binding-forward@1" as const;

export interface V2WorkflowForwardGrant {
  readonly publicName: string;
  readonly tenantId: string;
  readonly workflowResourceUid: string;
  readonly token: string;
}

export interface V2WorkflowForwardProjection {
  readonly schema: typeof V2_WORKFLOW_FORWARD_SCHEMA;
  readonly snapshotDigest: `sha256:${string}`;
  readonly bindings: readonly V2WorkflowForwardGrant[];
}

/** Host-private projection: accepted declarations and authority-issued grants must match exactly. */
export async function projectV2WorkflowForward(input: {
  readonly workerUid: string;
  readonly versionUid: string;
  readonly sourceOperationId: string;
  readonly nativeVersionId: string;
  readonly principal: string;
  readonly declarations: readonly WorkerVersionBinding[];
  readonly grants: readonly V2WorkflowForwardGrant[];
}): Promise<V2WorkflowForwardProjection> {
  const { declarations, grants } = input;
  if (declarations.length === 0 || declarations.length !== grants.length) {
    throw new TypeError("Workflow Binding grants do not match accepted declarations");
  }
  const declared = new Map<string, string>();
  for (const declaration of declarations) {
    const name = declaration.name;
    const resourceUid = declaration.resource?.resourceUid;
    if (!name || !resourceUid || declared.has(name)) {
      throw new TypeError("Workflow Binding declaration is not exact");
    }
    declared.set(name, resourceUid);
  }
  const names = new Set<string>();
  const bindings: V2WorkflowForwardGrant[] = [];
  for (const grant of grants) {
    if (
      Reflect.ownKeys(grant).length !== 4 ||
      !["publicName", "tenantId", "workflowResourceUid", "token"].every(
        (key) => Object.getOwnPropertyDescriptor(grant, key)?.value !== undefined,
      ) ||
      !declared.has(grant.publicName) ||
      declared.get(grant.publicName) !== grant.workflowResourceUid ||
      grant.tenantId !== input.principal ||
      !/^[a-f0-9]{64}$/u.test(grant.token) ||
      names.has(grant.publicName)
    )
      throw new TypeError("Workflow Binding grant is not an exact accepted target");
    names.add(grant.publicName);
    bindings.push(
      Object.freeze({
        publicName: grant.publicName,
        tenantId: grant.tenantId,
        workflowResourceUid: grant.workflowResourceUid,
        token: grant.token,
      }),
    );
  }
  bindings.sort((a, b) => a.publicName.localeCompare(b.publicName));
  const digestInput = [
    V2_WORKFLOW_FORWARD_SCHEMA,
    input.workerUid,
    input.versionUid,
    input.sourceOperationId,
    input.nativeVersionId,
    input.principal,
    bindings,
  ];
  const snapshotDigest = await bytesDigest(new TextEncoder().encode(canonicalJson(digestInput)));
  return Object.freeze({
    schema: V2_WORKFLOW_FORWARD_SCHEMA,
    snapshotDigest,
    bindings: Object.freeze(bindings),
  });
}
