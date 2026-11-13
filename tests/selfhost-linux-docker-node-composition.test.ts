import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { spawn as importedSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import { request as importedRequest } from "node:http";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { V2_CONTAINER_F2_FORM } from "../src/container-contract.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { Sql } from "../src/ports.ts";
import type { SelfhostLinuxDockerCoreSelection } from "../src/selfhost-linux-docker-core.ts";
import { createSelfhostLinuxDockerNodeComposition } from "../src/selfhost-linux-docker-node-composition.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import type {
  V2OperatorFormMaps,
  V2OperatorFormSelectionFactory,
} from "../src/takoform-v2/application.ts";
import { additiveV2ConfiguredUpdateInputsDDL } from "../src/takoform-v2/configured-update-inputs-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { createV2HeldArtifactSource } from "../src/takoform-v2/forms/artifact-source.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { createStaticAssetBundleForm } from "../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { createWorkerBundleForm } from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import type { V2PrivateInputCustody } from "../src/takoform-v2/private-inputs.ts";
import type { V2Action, V2BackendResult, V2Execution, V2Form } from "../src/takoform-v2/types.ts";
import { SOURCE_SELECTION } from "./helpers/docker-container-configured-source-selection.ts";

// Only raw Node IO is intercepted. The original creator, Sql, owner, parser,
// sealing/acceptance, native class, backend and engine are never replaced.
function interceptRawIo(onRequest: () => Promise<void>) {
  let requests = 0;
  let helpers = 0;
  const request = spyOn(http, "request").mockImplementation((() => {
    class FaultRequest extends EventEmitter {
      destroyed = false;
      destroy(error?: Error): this {
        if (!this.destroyed) {
          this.destroyed = true;
          if (error) this.emit("error", error);
          this.emit("close");
        }
        return this;
      }
      end(): this {
        requests++;
        void onRequest().then(
          () => this.destroy(new Error("synthetic raw HTTP failure")),
          () => this.destroy(new Error("synthetic raw HTTP failure")),
        );
        return this;
      }
    }
    return new FaultRequest() as unknown as http.ClientRequest;
  }) as typeof http.request);
  const spawn = spyOn(childProcess, "spawn").mockImplementation(() => {
    helpers++;
    throw new Error("synthetic raw helper failure");
  });
  if (importedRequest !== request || !Object.is(importedSpawn, spawn)) {
    request.mockRestore();
    spawn.mockRestore();
    throw new Error("raw IO interception unavailable");
  }
  return {
    requests: () => requests,
    restore() {
      request.mockRestore();
      spawn.mockRestore();
      expect(helpers).toBe(0);
    },
  };
}

async function fixture() {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  await sql.batch(
    frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((sql) => ({ sql })),
  );
  await sql.batch(v2ContainerOwnerMigrationCandidate());
  const clock = () => new Date();
  const objects = createMemoryObjectStore();
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const custody: V2PrivateInputCustody = {
    transfer: { current: { id: "synthetic-node-key", key } },
    comparison: {
      current: {
        id: "synthetic-node-comparison",
        key: await crypto.subtle.generateKey(
          { name: "HMAC", hash: "SHA-256", length: 256 },
          false,
          ["sign", "verify"],
        ),
      },
    },
    transferTtlSeconds: 300,
  };
  const selection: SelfhostLinuxDockerCoreSelection = {
    installationId: SOURCE_SELECTION.providerInstallationId,
    backendId: SOURCE_SELECTION.backendId,
    targetKey: SOURCE_SELECTION.targetKey,
    configuredInputs: {
      keyring: {
        current: custody.transfer.current,
        keyForDecryption: (id) => (id === "synthetic-node-key" ? key : undefined),
      },
      maxSecretBytes: 4096,
    },
    runtime: {
      process: {
        helper: "/synthetic/not-executed/helper",
        socketPath: "/synthetic/not-opened/docker.sock",
        peerPid: 1,
        peerUid: 0,
        ipBinary: "/synthetic/not-executed/ip",
        nftBinary: "/synthetic/not-executed/nft",
        guestNamespaceRoot: "/synthetic/not-opened/namespaces",
      },
      host: { tcpPorts: [8080], conntrackMark: 1, deniedDestinations: [] },
      dnsServers: ["192.0.2.53"],
      maxConnections: 4,
      packetLimitBytes: 4096,
    },
    docker: {
      network: "synthetic-docker-network",
      maxMemoryBytes: 256 * 1024 * 1024,
      maxNanoCpus: 500_000_000,
      pidsLimit: 128,
    },
  };
  let requestAction = async () => {};
  const raw = interceptRawIo(() => requestAction());
  const baseMaps: V2OperatorFormMaps[] = [];
  let retainedEntry: PropertyDescriptor | undefined;
  const baseFactory: V2OperatorFormSelectionFactory = (context) => {
    // Original existing public/retained constructors and a real held-byte source.
    // This is the ordinary operator factory seam, not a substitute Native factory.
    const source = createV2HeldArtifactSource({ objects: context.objects, entries: [] });
    const retainedForms: Record<string, V2Form> = {
      [STATIC_ASSET_BUNDLE_FORM_URL]: createStaticAssetBundleForm({
        sql: context.sql,
        source,
        targetKey: "synthetic-existing-assets",
      }),
    };
    if (retainedEntry) Object.defineProperty(retainedForms, V2_CONTAINER_F2_FORM, retainedEntry);
    const maps = Object.freeze({
      forms: Object.freeze({
        [WORKER_BUNDLE_FORM_URL]: createWorkerBundleForm({
          sql: context.sql,
          source,
          targetKey: "synthetic-existing-worker",
        }),
      }),
      retainedForms: Object.freeze(retainedForms),
    });
    baseMaps.push(maps);
    return maps;
  };
  let node: ReturnType<typeof createSelfhostLinuxDockerNodeComposition> | undefined;
  const context = { sql, objects, clock };
  const spec = {
    image: `registry.example/app@sha256:${"1".repeat(64)}`,
    httpPort: 8080,
    healthPath: "/health",
    workloadRevision: "1".repeat(64),
    environment: { MODE: "synthetic-node" },
    requiredSensitiveVars: ["SECRET"],
    outboundInternet: true,
  };
  return {
    sql,
    database,
    objects,
    clock,
    selection,
    custody,
    context,
    baseFactory,
    baseMaps,
    spec,
    raw,
    request(fn: typeof requestAction) {
      requestAction = fn;
    },
    retainedEntry(descriptor: PropertyDescriptor) {
      retainedEntry = descriptor;
    },
    compose(actions?: Readonly<Record<string, readonly V2Action[]>>) {
      if (node) throw new Error("one Node composition per fixture");
      node = createSelfhostLinuxDockerNodeComposition({
        sql,
        clock,
        selection,
        formSelectionFactory: baseFactory,
        privateInputCustody: custody,
        ...(actions === undefined ? {} : { retainedExecutionActions: actions }),
      });
      return node;
    },
    async engine(
      composition: NonNullable<typeof node>,
      before?: (execution: V2Execution, form: V2Form) => Promise<void>,
    ) {
      const ports = composition.appPorts;
      const factory = ports.v2FormSelectionFactory;
      const acceptance = ports.v2ContainerHostAcceptance;
      if (!factory || !acceptance) throw new Error("selected original Node graph unavailable");
      const maps = factory(context);
      const form = maps.retainedForms[V2_CONTAINER_F2_FORM];
      if (!form) throw new Error("genuine retained Form unavailable");
      // Bootstrap accepts test-local original F2 only to obtain a genuine accepted
      // Operation. The executing/reconstructed engine uses the real retained map.
      // Product public support/entry activation is never changed.
      const bootstrap = createTakoformV2Engine(
        {
          sql,
          authorize: async () => true,
          replayWindowSeconds: 3600,
          privateInputCustody: custody,
          forms: { [V2_CONTAINER_F2_FORM]: form },
        },
        acceptance,
      );
      const accepted = await bootstrap.acceptCreate({
        principal: "synthetic-node-parent",
        key: crypto.randomUUID(),
        input: {
          form: V2_CONTAINER_F2_FORM,
          space: "synthetic-space",
          name: "synthetic-node",
          spec,
          privateInputs: { SECRET: "synthetic-node-transient" },
        },
      });
      const executions: V2Execution[] = [];
      const results: V2BackendResult[] = [];
      const observe = async (execution: V2Execution, reconcile: boolean) => {
        executions.push(execution);
        await before?.(execution, form);
        const result = await (reconcile
          ? form.backend.reconcile(execution)
          : form.backend.execute(execution));
        results.push(result);
        return result;
      };
      const engine = createTakoformV2Engine(
        {
          sql,
          authorize: async () => true,
          replayWindowSeconds: 3600,
          privateInputCustody: custody,
          forms: maps.forms,
          retainedForms: {
            ...maps.retainedForms,
            [V2_CONTAINER_F2_FORM]: {
              ...form,
              backend: {
                ...form.backend,
                execute: (execution) => observe(execution, false),
                reconcile: (execution) => observe(execution, true),
              },
            },
          },
          ...(ports.v2RetainedExecutionActions === undefined
            ? {}
            : { retainedExecutionActions: ports.v2RetainedExecutionActions }),
        },
        acceptance,
      );
      return { accepted, engine, executions, results, form };
    },
    async close() {
      try {
        await node?.close();
      } finally {
        raw.restore();
        database.close();
      }
    },
  };
}

test("unselected Node composition preserves the original factory/key authority and never reads Sql", async () => {
  const f = await fixture();
  try {
    const rules = Object.freeze({
      [STATIC_ASSET_BUNDLE_FORM_URL]: Object.freeze(["delete"] as const),
    });
    const composition = createSelfhostLinuxDockerNodeComposition({
      get sql(): Sql {
        throw new Error("unselected Sql read");
      },
      get clock(): () => Date {
        throw new Error("unselected clock read");
      },
      selection: undefined,
      formSelectionFactory: f.baseFactory,
      privateInputCustody: f.custody,
      retainedExecutionActions: rules,
    });
    expect(composition.appPorts.v2FormSelectionFactory).toBe(f.baseFactory);
    expect(composition.appPorts.v2PrivateInputCustody).toBe(f.custody);
    expect(composition.appPorts.v2RetainedExecutionActions).toBe(rules);
    expect(Object.hasOwn(composition.appPorts, "v2ContainerHostAcceptance")).toBe(false);
    const forwarded = composition.appPorts.v2FormSelectionFactory?.(f.context);
    expect(forwarded).toBe(f.baseMaps[0]);
    await composition.close();
    expect(f.raw.requests()).toBe(0);
    const absent = createSelfhostLinuxDockerNodeComposition({
      sql: f.sql,
      clock: f.clock,
      selection: undefined,
      formSelectionFactory: undefined,
      privateInputCustody: f.custody,
    });
    expect(absent.appPorts).toEqual({});
    await absent.close();
  } finally {
    await f.close();
  }
});

test("one selected original graph adds retained F2 without changing public Forms or key authority", async () => {
  const f = await fixture();
  try {
    const node = f.compose();
    const maps = node.appPorts.v2FormSelectionFactory?.(f.context);
    if (!maps) throw new Error("selected maps missing");
    const original = f.baseMaps[0];
    if (!original) throw new Error("original maps missing");
    expect(maps.forms).toBe(original.forms);
    expect(Object.keys(maps.forms)).toEqual([WORKER_BUNDLE_FORM_URL]);
    expect(Object.keys(maps.retainedForms)).toEqual([
      STATIC_ASSET_BUNDLE_FORM_URL,
      V2_CONTAINER_F2_FORM,
    ]);
    expect(maps.retainedForms[STATIC_ASSET_BUNDLE_FORM_URL]).toBe(
      original.retainedForms[STATIC_ASSET_BUNDLE_FORM_URL],
    );
    expect(node.appPorts.v2PrivateInputCustody).toBe(f.custody);
    expect(node.appPorts.v2RetainedExecutionActions?.[V2_CONTAINER_F2_FORM]).toEqual(["delete"]);
    const acceptance = node.appPorts.v2ContainerHostAcceptance;
    if (!acceptance) throw new Error("original acceptance missing");
    acceptance.assertSql(f.sql);
    expect(() => acceptance.assertSql({ ...f.sql })).toThrow();
    const calls = f.baseMaps.length;
    expect(() =>
      node.appPorts.v2FormSelectionFactory?.({ ...f.context, sql: { ...f.sql } }),
    ).toThrow();
    expect(f.baseMaps).toHaveLength(calls);
    expect(f.raw.requests()).toBe(0);
  } finally {
    await f.close();
  }
});

test("selected composition rejects missing or invalid original private-input authority and configured keyring", async () => {
  const f = await fixture();
  try {
    const input = {
      sql: f.sql,
      clock: f.clock,
      selection: f.selection,
      formSelectionFactory: f.baseFactory,
    };
    expect(() =>
      createSelfhostLinuxDockerNodeComposition({ ...input, privateInputCustody: undefined }),
    ).toThrow("selfhost_linux_docker_private_input_custody_required");
    expect(() =>
      createSelfhostLinuxDockerNodeComposition({
        ...input,
        privateInputCustody: { ...f.custody, transferTtlSeconds: 0 },
      }),
    ).toThrow("invalid v2 private input transfer lifetime");
    expect(() =>
      createSelfhostLinuxDockerNodeComposition({
        ...input,
        privateInputCustody: f.custody,
        selection: {
          ...f.selection,
          configuredInputs: { ...f.selection.configuredInputs, maxSecretBytes: 0 },
        },
      }),
    ).toThrow("Container configured inputs unavailable");
    expect(f.baseMaps).toHaveLength(0);
    expect(f.raw.requests()).toBe(0);
  } finally {
    await f.close();
  }
});

test("retained execution keeps original backend/target/current lease and captures action bounds", async () => {
  const f = await fixture();
  try {
    const actions: V2Action[] = ["create"];
    const node = f.compose({
      [V2_CONTAINER_F2_FORM]: actions,
      [STATIC_ASSET_BUNDLE_FORM_URL]: ["delete"],
    });
    actions.push("update", "delete");
    expect(node.appPorts.v2RetainedExecutionActions?.[V2_CONTAINER_F2_FORM]).toEqual(["create"]);
    const running = await f.engine(node, async (execution, form) => {
      const before = f.raw.requests();
      expect(
        await form.backend.execute({ ...execution, backendId: "synthetic-other-backend" }),
      ).toEqual({ kind: "unknown" });
      expect(
        await form.backend.reconcile({ ...execution, targetKey: "synthetic-other-target" }),
      ).toEqual({ kind: "unknown" });
      expect(
        await form.backend.execute({ ...execution, principal: "synthetic-other-parent" }),
      ).toEqual({ kind: "unknown" });
      expect(await form.backend.execute({ ...execution, action: "update" })).toEqual({
        kind: "unknown",
      });
      expect(await form.backend.reconcile({ ...execution, action: "delete" })).toEqual({
        kind: "unknown",
      });
      expect(f.raw.requests()).toBe(before);
    });
    expect(await running.engine.runNext()).toMatchObject({
      id: running.accepted.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(running.results).toEqual([{ kind: "unknown" }]);
    expect(f.raw.requests()).toBeGreaterThan(0);
    expect(await f.sql.query("SELECT serving_generation FROM tf_v2_container_instances")).toEqual([
      { serving_generation: null },
    ]);
    expect(await f.sql.query("SELECT * FROM tf_v2_container_start_attempts")).toEqual([]);
    await expect(
      running.engine.acceptCreate({
        principal: "synthetic-node-parent",
        key: crypto.randomUUID(),
        input: {
          form: V2_CONTAINER_F2_FORM,
          space: "synthetic-space",
          name: "other",
          spec: f.spec,
          privateInputs: { SECRET: "synthetic" },
        },
      }),
    ).rejects.toMatchObject({ code: "unsupported_form" });
  } finally {
    await f.close();
  }
});

test("revocation and close fence retained calls while whole engine settlement finishes before database cleanup", async () => {
  const f = await fixture();
  try {
    const node = f.compose({ [V2_CONTAINER_F2_FORM]: ["create"] });
    let revoked = false;
    f.request(async () => {
      revoked = true;
      await f.sql.run("UPDATE tf_v2_operations SET lease_until_ms=0");
    });
    const running = await f.engine(node);
    await running.engine.runNext();
    expect(revoked).toBe(true);
    expect(running.results).toEqual([{ kind: "unknown" }]);
    const execution = running.executions[0];
    if (!execution) throw new Error("original accepted execution missing");
    const before = f.raw.requests();
    expect(await running.form.backend.reconcile(execution)).toEqual({ kind: "unknown" });
    const close = node.close();
    expect(node.close()).toBe(close);
    await close;
    expect(await running.form.backend.execute(execution)).toEqual({ kind: "unknown" });
    expect(() => node.appPorts.v2FormSelectionFactory?.(f.context)).toThrow(
      "selfhost_linux_docker_node_closed",
    );
    expect(f.raw.requests()).toBe(before);
    expect(await f.sql.query("SELECT 1 AS still_open")).toEqual([{ still_open: 1 }]);
  } finally {
    await f.close();
  }
});

test("existing retained F2 cannot be overwritten and action-rule accessors are refused without evaluation", async () => {
  const f = await fixture();
  try {
    let reads = 0;
    const rules: Record<string, readonly V2Action[]> = {};
    Object.defineProperty(rules, V2_CONTAINER_F2_FORM, {
      enumerable: true,
      get() {
        reads++;
        throw new Error("operator rule accessor must not run");
      },
    });
    expect(() =>
      createSelfhostLinuxDockerNodeComposition({
        sql: f.sql,
        clock: f.clock,
        selection: f.selection,
        formSelectionFactory: f.baseFactory,
        privateInputCustody: f.custody,
        retainedExecutionActions: rules,
      }),
    ).toThrow("invalid retained execution selection");
    expect(reads).toBe(0);
    f.retainedEntry({
      enumerable: true,
      get() {
        reads++;
        throw new Error("existing adapter accessor must not run");
      },
    });
    const node = f.compose();
    expect(() => node.appPorts.v2FormSelectionFactory?.(f.context)).toThrow(
      "selfhost_linux_docker_form_already_composed",
    );
    expect(reads).toBe(0);
    expect(f.raw.requests()).toBe(0);
  } finally {
    await f.close();
  }
});

for (const result of [null, undefined]) {
  test(`supplied existing factory returning ${String(result)} refuses a missing map`, async () => {
    const f = await fixture();
    // Deliberately malformed runtime return at the old factory contract boundary;
    // no valid product/native factory or authority is replaced by this case.
    const invalidFactory: V2OperatorFormSelectionFactory = () =>
      Object.getOwnPropertyDescriptor({ result }, "result")?.value;
    const node = createSelfhostLinuxDockerNodeComposition({
      sql: f.sql,
      clock: f.clock,
      selection: f.selection,
      formSelectionFactory: invalidFactory,
      privateInputCustody: f.custody,
    });
    try {
      expect(() => node.appPorts.v2FormSelectionFactory?.(f.context)).toThrow();
      expect(f.raw.requests()).toBe(0);
    } finally {
      await node.close();
      await f.close();
    }
  });
}

test("absent existing factory still composes a retained-only map", async () => {
  const f = await fixture();
  const node = createSelfhostLinuxDockerNodeComposition({
    sql: f.sql,
    clock: f.clock,
    selection: f.selection,
    formSelectionFactory: undefined,
    privateInputCustody: f.custody,
  });
  try {
    const maps = node.appPorts.v2FormSelectionFactory?.(f.context);
    expect(maps?.forms).toEqual({});
    expect(Object.keys(maps?.retainedForms ?? {})).toEqual([V2_CONTAINER_F2_FORM]);
    expect(f.raw.requests()).toBe(0);
  } finally {
    await node.close();
    await f.close();
  }
});
