import { createHash, createHmac } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { canonicalJson } from "../json.ts";
import type { Sql } from "../ports.ts";
import { SELFHOST_SOCKET_DIRECTORY_PREFIX } from "../selfhost-socket-layout.ts";
import { openSelfhostWorkflowBindingBroker } from "../selfhost-workflow-binding-broker.ts";
import type {
  WorkerdV2WorkflowForwardBinding,
  WorkerdWorkflowForwardLifecycle,
  WorkerdWorkflowForwardPublication,
  WorkerdWorkflowForwardSocket,
} from "../workerd-runtime.ts";
import type { WorkflowRuntime } from "../workflow-execution.ts";
import { parseWorkerVersionSpec, WORKER_VERSION_FORM_URL } from "./forms/worker-specs.ts";
import type { V2WorkflowBindingClaim } from "./workflow-binding-authority.ts";
import {
  projectV2WorkflowForward,
  type V2WorkflowForwardGrant,
} from "./workflow-binding-projection.ts";

type Instances = Pick<
  WorkflowRuntime["instances"],
  "create" | "get" | "status" | "sendEvent" | "terminate"
>;
type Authority = {
  resolveCurrentBinding(
    claim: V2WorkflowBindingClaim,
    name: string,
  ): Promise<{
    readonly tenantId: string;
    readonly workflowResourceUid: string;
    readonly workerUid: string;
    readonly vector: string;
  } | null>;
};

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const V2_SCHEMA = "takoserver.v2-workflow-binding-forward@1";
// WorkerDeployment 0.4.0 selects at most eight Versions; WorkerVersion 0.5.0
// declares at most 64 Workflow bindings per Version. A fenced replacement may
// hold the prior complete graph while the next complete graph is reserved.
const MAX_CURRENT_WORKFLOW_BINDINGS = 8 * 64;
const MAX_RESERVED_WORKFLOW_BROKERS = 2 * MAX_CURRENT_WORKFLOW_BINDINGS;

export interface V2WorkflowForwardIncarnation {
  readonly workerUid: string;
  readonly sourceOperationId: string;
  readonly scriptName: string;
  readonly eventToken: string;
}

/** A private broker for the selected owner incarnation, not a new Workflow ledger. */
export function createV2WorkflowForwardBoot(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly authority: Authority;
  readonly instances: Instances;
  readonly privateSocketDirectory: string;
}) {
  if (
    !options.sql ||
    !options.targetKey ||
    typeof options.authority?.resolveCurrentBinding !== "function" ||
    !options.instances ||
    ["create", "get", "status", "sendEvent", "terminate"].some(
      (name) => typeof options.instances[name as keyof Instances] !== "function",
    ) ||
    !isAbsolute(options.privateSocketDirectory)
  ) {
    throw new TypeError(
      "v2 Workflow forward requires accepted authority, instances, and private root",
    );
  }
  const { sql, authority, instances } = options;
  return Object.freeze({
    openIncarnation(source: V2WorkflowForwardIncarnation) {
      const identity = { ...source };
      const key = Buffer.from(identity.eventToken, "hex");
      if (
        !identity.workerUid ||
        !identity.scriptName ||
        !OPERATION_ID.test(identity.sourceOperationId) ||
        key.byteLength !== 32 ||
        key.toString("hex") !== identity.eventToken
      ) {
        throw new TypeError("v2 Workflow incarnation identity unavailable");
      }
      let closed = false;
      let restored = false;
      let socketDirectory: string | null = null;
      let admitted = new Set<string>();
      let serial: Promise<void> = Promise.resolve();
      let closing: Promise<void> | undefined;
      const brokers = new Map<
        string,
        {
          readonly broker: Awaited<ReturnType<typeof openSelfhostWorkflowBindingBroker>>;
          readonly socket: WorkerdWorkflowForwardSocket;
        }
      >();
      const reserved = new Map<string, number>();
      const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
        const next = serial.then(operation, operation);
        serial = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      };
      const bindingKey = (
        binding: WorkerdV2WorkflowForwardBinding,
        publication: WorkerdWorkflowForwardPublication,
      ) =>
        canonicalJson([
          publication.script,
          publication.versionId,
          publication.snapshotDigest,
          binding.publicName,
          binding.tenantId,
          binding.workflowResourceUid,
          binding.token,
        ]);

      const issueBinding = async (
        sourceClaim: V2WorkflowBindingClaim,
        name: string,
      ): Promise<V2WorkflowForwardGrant | null> => {
        if (closed) return null;
        const claim: V2WorkflowBindingClaim = {
          ...sourceClaim,
          bindings: sourceClaim.bindings.map((binding) => ({ ...binding })),
        };
        if (
          claim.targetKey !== options.targetKey ||
          claim.workerUid !== identity.workerUid ||
          claim.bindings.filter((binding) => binding.name === name).length !== 1
        )
          return null;
        const resolved = await authority.resolveCurrentBinding(claim, name);
        if (
          closed ||
          !resolved ||
          resolved.tenantId !== claim.principal ||
          resolved.workerUid !== identity.workerUid
        )
          return null;
        const token = createHmac("sha256", key)
          .update(
            canonicalJson([
              V2_SCHEMA,
              identity.sourceOperationId,
              identity.scriptName,
              identity.workerUid,
              claim.workerVersionUid,
              claim.workerVersionOperationId,
              claim.nativeVersionId,
              name,
              resolved.workflowResourceUid,
              resolved.vector,
            ]),
          )
          .digest("hex");
        return {
          publicName: name,
          tenantId: resolved.tenantId,
          workflowResourceUid: resolved.workflowResourceUid,
          token,
        };
      };

      const proof = async (publication: WorkerdWorkflowForwardPublication) => {
        if (
          closed ||
          publication.script !== identity.scriptName ||
          publication.workerResourceUid !== identity.workerUid ||
          publication.bindings.length > 64 ||
          publication.bindings.length === 0 ||
          publication.bindings.some((binding) => "workflowFormRef" in binding)
        ) {
          throw new Error("v2 Workflow native publication unavailable");
        }
        const rows = await sql.query(
          `SELECT spec_json, backend_id, generation, principal, space FROM tf_v2_resources
           WHERE uid = ? AND form_url = ? AND target_key = ? AND deleted_at IS NULL LIMIT 2`,
          [publication.workerVersionResourceUid, WORKER_VERSION_FORM_URL, options.targetKey],
        );
        const version = rows.length === 1 ? rows[0] : null;
        if (
          !version ||
          typeof version.spec_json !== "string" ||
          typeof version.backend_id !== "string" ||
          typeof version.generation !== "number" ||
          typeof version.principal !== "string" ||
          typeof version.space !== "string"
        ) {
          throw new Error("v2 Workflow Version source unavailable");
        }
        const spec = parseWorkerVersionSpec(JSON.parse(version.spec_json));
        const sources = await sql.query(
          `SELECT id, generation FROM tf_v2_operations
           WHERE resource_uid = ? AND principal = ? AND target_key = ? AND backend_id = ?
             AND action IN ('create','update') AND status = 'succeeded' AND effect = 'complete'
             AND accepted_spec_json = ? AND generation <= ?`,
          [
            publication.workerVersionResourceUid,
            version.principal,
            options.targetKey,
            version.backend_id,
            version.spec_json,
            version.generation,
          ],
        );
        const matched = sources.filter(
          (row) =>
            typeof row.id === "string" &&
            typeof row.generation === "number" &&
            publication.versionId ===
              `v2-${createHash("sha256")
                .update(`${publication.workerVersionResourceUid}\u0000${row.generation}`)
                .digest("hex")}`,
        );
        if (matched.length !== 1 || typeof matched[0]?.id !== "string")
          throw new Error("v2 Workflow Version source unavailable");
        const claim: V2WorkflowBindingClaim = {
          principal: version.principal,
          space: version.space,
          targetKey: options.targetKey,
          workerUid: identity.workerUid,
          workerVersionUid: publication.workerVersionResourceUid,
          workerVersionOperationId: matched[0].id,
          nativeVersionId: publication.versionId,
          bindings: spec.workflowBindings.map((binding) => ({
            name: binding.name,
            resourceUid: binding.resource.resourceUid,
          })),
        };
        const grants: V2WorkflowForwardGrant[] = [];
        const bindings: WorkerdV2WorkflowForwardBinding[] = [];
        for (const binding of publication.bindings) {
          if ("workflowFormRef" in binding) throw new Error("legacy Workflow descriptor rejected");
          const issued = await issueBinding(claim, binding.publicName);
          if (
            !issued ||
            issued.tenantId !== binding.tenantId ||
            issued.workflowResourceUid !== binding.workflowResourceUid ||
            issued.token !== binding.token
          )
            throw new Error("v2 Workflow relation changed");
          grants.push(issued);
          bindings.push(binding);
        }
        const projected = await projectV2WorkflowForward({
          workerUid: identity.workerUid,
          versionUid: publication.workerVersionResourceUid,
          sourceOperationId: claim.workerVersionOperationId,
          nativeVersionId: publication.versionId,
          principal: claim.principal,
          declarations: spec.workflowBindings,
          grants,
        });
        if (projected.snapshotDigest !== publication.snapshotDigest)
          throw new Error("v2 Workflow private snapshot changed");
        return bindings.map((binding) => ({
          binding,
          claim,
          key: bindingKey(binding, publication),
        }));
      };

      const privateDirectory = async () => {
        if (socketDirectory) return socketDirectory;
        await mkdir(options.privateSocketDirectory, { recursive: true, mode: 0o700 });
        const info = await lstat(options.privateSocketDirectory);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          (info.mode & 0o077) !== 0 ||
          (await realpath(options.privateSocketDirectory)) !== options.privateSocketDirectory
        )
          throw new Error("v2 Workflow private root unavailable");
        socketDirectory = await mkdtemp(
          join(options.privateSocketDirectory, SELFHOST_SOCKET_DIRECTORY_PREFIX.workflowBrokers),
        );
        return socketDirectory;
      };

      const prepare = async (publications: readonly WorkerdWorkflowForwardPublication[]) => {
        if (closed) throw new Error("v2 Workflow owner unavailable");
        const entries = (await Promise.all(publications.map(proof))).flat();
        const keys = new Set<string>();
        for (const entry of entries) {
          if (keys.has(entry.key)) throw new Error("duplicate v2 Workflow binding");
          keys.add(entry.key);
        }
        const newKeys = [...keys].filter((key) => !brokers.has(key));
        if (
          keys.size > MAX_CURRENT_WORKFLOW_BINDINGS ||
          brokers.size + newKeys.length > MAX_RESERVED_WORKFLOW_BROKERS
        )
          throw new Error("v2 Workflow broker capacity exceeded");
        const opened: string[] = [];
        try {
          for (const entry of entries) {
            if (brokers.has(entry.key)) continue;
            const root = await privateDirectory();
            const socketPath = join(
              root,
              `${createHash("sha256").update(entry.key).digest("hex").slice(0, 22)}.sock`,
            );
            if (Buffer.byteLength(socketPath) >= 100)
              throw new Error("v2 Workflow socket path unavailable");
            const current = async () => {
              if (closed || !admitted.has(entry.key))
                throw new Error("v2 Workflow Version not active");
              const binding = await issueBinding(entry.claim, entry.binding.publicName);
              if (!binding || binding.token !== entry.binding.token)
                throw new Error("v2 Workflow Binding relation changed");
            };
            const guarded: Instances = {
              async create(scope, input) {
                await current();
                return instances.create(scope, input);
              },
              async get(scope, id) {
                await current();
                return instances.get(scope, id);
              },
              async status(scope, id) {
                await current();
                return instances.status(scope, id);
              },
              async sendEvent(scope, id, event) {
                await current();
                return instances.sendEvent(scope, id, event);
              },
              async terminate(scope, id) {
                await current();
                return instances.terminate(scope, id);
              },
            };
            const broker = await openSelfhostWorkflowBindingBroker({
              socketPath,
              token: entry.binding.token,
              scope: {
                tenantId: entry.binding.tenantId,
                workflowResourceUid: entry.binding.workflowResourceUid,
              },
              instances: guarded,
            });
            const publication = publications.find((item) => item.bindings.includes(entry.binding));
            if (!publication) throw new Error("v2 Workflow publication unavailable");
            brokers.set(entry.key, {
              broker,
              socket: {
                script: publication.script,
                workerResourceUid: publication.workerResourceUid,
                versionId: publication.versionId,
                workerVersionResourceUid: publication.workerVersionResourceUid,
                snapshotDigest: publication.snapshotDigest,
                binding: entry.binding,
                socketPath,
              },
            });
            opened.push(entry.key);
          }
          for (const publication of publications) await proof(publication);
        } catch (error) {
          for (const key of opened) {
            const entry = brokers.get(key);
            if (entry) await entry.broker.close().catch(() => {});
            brokers.delete(key);
          }
          throw error;
        }
        return keys;
      };
      const cleanup = async () => {
        for (const [key, entry] of brokers) {
          if (admitted.has(key) || (reserved.get(key) ?? 0) > 0) continue;
          brokers.delete(key);
          await entry.broker.retire();
        }
      };
      const workflowForwardLifecycle: WorkerdWorkflowForwardLifecycle = Object.freeze({
        reserve(publications: readonly WorkerdWorkflowForwardPublication[]) {
          return exclusive(async () => {
            const keys = await prepare(publications);
            for (const key of keys) reserved.set(key, (reserved.get(key) ?? 0) + 1);
            let released = false;
            return {
              release() {
                return exclusive(async () => {
                  if (released) return;
                  released = true;
                  for (const key of keys) {
                    const remaining = (reserved.get(key) ?? 1) - 1;
                    if (remaining > 0) reserved.set(key, remaining);
                    else reserved.delete(key);
                  }
                  await cleanup();
                });
              },
            };
          });
        },
        activated(publications: readonly WorkerdWorkflowForwardPublication[]) {
          if (closed) return false;
          const keys = new Set<string>();
          for (const publication of publications) {
            if (publication.bindings.some((binding) => "workflowFormRef" in binding)) return false;
            for (const binding of publication.bindings) {
              const key = bindingKey(binding, publication);
              if (!brokers.has(key) || keys.has(key)) return false;
              keys.add(key);
            }
          }
          admitted = keys;
          restored = true;
          void exclusive(cleanup).catch(() => {
            admitted = new Set();
            restored = false;
          });
          return true;
        },
        isRestored() {
          return restored && !closed;
        },
        uncertain() {
          admitted = new Set();
          restored = false;
        },
      });
      return Object.freeze({
        issueBinding,
        workflowForwardLifecycle,
        workflowForwardSockets(
          publications: readonly WorkerdWorkflowForwardPublication[],
        ): readonly WorkerdWorkflowForwardSocket[] {
          if (closed) return [];
          return publications.flatMap((publication) =>
            publication.bindings.flatMap((binding) => {
              if ("workflowFormRef" in binding) return [];
              const socket = brokers.get(bindingKey(binding, publication))?.socket;
              return socket ? [socket] : [];
            }),
          );
        },
        close(): Promise<void> {
          if (!closing) {
            closed = true;
            admitted = new Set();
            restored = false;
            closing = (async () => {
              await serial;
              const results = await Promise.allSettled(
                [...brokers.values()].map((entry) => entry.broker.close()),
              );
              if (results.some((result) => result.status === "rejected"))
                throw new Error("v2 Workflow broker close incomplete");
              if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
            })();
          }
          return closing;
        },
      });
    },
  });
}
