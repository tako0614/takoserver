import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { spawn as importedSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import { request as importedRequest } from "node:http";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { V2_CONTAINER_F2_FORM } from "../src/container-contract.ts";
import { canonicalDigest } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { DockerHttpRevisionOptions } from "../src/providers/docker-http-revision.ts";
import type { SelfhostLinuxDockerCoreSelection } from "../src/selfhost-linux-docker-core.ts";
import { createSelfhostLinuxDockerNodeComposition } from "../src/selfhost-linux-docker-node-composition.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import type { V2OperatorFormSelectionFactory } from "../src/takoform-v2/application.ts";
import { additiveV2ConfiguredUpdateInputsDDL } from "../src/takoform-v2/configured-update-inputs-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { createV2HeldArtifactSource } from "../src/takoform-v2/forms/artifact-source.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { createStaticAssetBundleForm } from "../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import type { V2PrivateInputCustody } from "../src/takoform-v2/private-inputs.ts";
import type {
  V2Action,
  V2EngineOptions,
  V2Operation,
  V2RetainedExecutionActions,
} from "../src/takoform-v2/types.ts";
import { engineDouble } from "./helpers/docker-container-configured-owner-snapshot.ts";
import { SOURCE_SELECTION } from "./helpers/docker-container-configured-source-selection.ts";
import { migrateSqliteDatabase } from "./helpers/migrated-database.ts";

type Engine = NonNullable<DockerHttpRevisionOptions["engine"]>;
const PRINCIPAL = "synthetic-selected-node-parent";

// Intercept raw IO only, before any fallback can touch a real socket/helper.
// No native factory, class, owner, validator, engine result or authority is replaced.
function rawIo(handler: Engine) {
  const requests: { method: string; path: string }[] = [];
  let helpers = 0;
  const request = spyOn(http, "request").mockImplementation(((
    options: http.RequestOptions,
    receive: (response: http.IncomingMessage) => void,
  ) => {
    class MemoryRequest extends EventEmitter {
      destroyed = false;
      destroy(error?: Error): this {
        if (!this.destroyed) {
          this.destroyed = true;
          if (error) this.emit("error", error);
          this.emit("close");
        }
        return this;
      }
      end(body?: string): this {
        const method = String(options.method);
        const path = String(options.path).replace(/^\/v1\.51/u, "");
        requests.push({ method, path });
        void Promise.resolve()
          .then(async () => {
            const value = await handler(
              method,
              path,
              body === undefined ? undefined : JSON.parse(body),
            );
            if (this.destroyed) return;
            const incoming = Object.assign(new EventEmitter(), { statusCode: value.status });
            receive(incoming as unknown as http.IncomingMessage);
            incoming.emit("data", Buffer.from(value.body));
            incoming.emit("end");
            this.destroy();
          })
          .catch(() => this.destroy(new Error("synthetic raw IO refusal")));
        return this;
      }
    }
    return new MemoryRequest() as unknown as http.ClientRequest;
  }) as typeof http.request);
  const spawn = spyOn(childProcess, "spawn").mockImplementation(() => {
    helpers++;
    throw new Error("synthetic raw helper refusal");
  });
  if (importedRequest !== request || !Object.is(importedSpawn, spawn)) {
    request.mockRestore();
    spawn.mockRestore();
    throw new Error("raw IO interception unavailable");
  }
  return {
    requests,
    restore() {
      request.mockRestore();
      spawn.mockRestore();
      expect(helpers).toBe(0);
    },
  };
}

async function fixture(actions?: V2RetainedExecutionActions) {
  const database = migrateSqliteDatabase();
  const sql = createSqliteSql(database);
  await sql.batch(
    frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((sql) => ({ sql })),
  );
  await sql.batch(v2ContainerOwnerMigrationCandidate());
  const time = Date.now();
  const clock = () => new Date(time);
  const objects = createMemoryObjectStore();
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const custody: V2PrivateInputCustody = {
    transfer: { current: { id: "synthetic-selected-key", key } },
    comparison: {
      current: {
        id: "synthetic-selected-comparison",
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
        keyForDecryption: (id) => (id === "synthetic-selected-key" ? key : undefined),
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
  const baseFactory: V2OperatorFormSelectionFactory = (context) => ({
    forms: {
      [STATIC_ASSET_BUNDLE_FORM_URL]: createStaticAssetBundleForm({
        sql: context.sql,
        source: createV2HeldArtifactSource({ objects: context.objects, entries: [] }),
        targetKey: "synthetic-selected-held-artifacts",
      }),
    },
    retainedForms: {},
  });
  const compose = (selected: SelfhostLinuxDockerCoreSelection) =>
    createSelfhostLinuxDockerNodeComposition({
      sql,
      clock,
      selection: selected,
      formSelectionFactory: baseFactory,
      privateInputCustody: custody,
      ...(actions === undefined ? {} : { retainedExecutionActions: actions }),
    });
  let node = compose(selection);
  let handler: Engine = async () => {
    throw new Error("synthetic raw read failure");
  };
  const raw = rawIo((...args) => handler(...args));
  const context = { sql, objects, clock };
  function options(retained: boolean, privateCustody = true): V2EngineOptions {
    const ports = node.appPorts;
    const maps = ports.v2FormSelectionFactory?.(context);
    if (!maps) throw new Error("genuine selected maps unavailable");
    const form = maps.retainedForms[V2_CONTAINER_F2_FORM];
    if (!form) throw new Error("genuine retained F2 unavailable");
    return {
      sql,
      now: clock,
      replayWindowSeconds: 3600,
      authorize: async () => true,
      ...(privateCustody && ports.v2PrivateInputCustody
        ? { privateInputCustody: ports.v2PrivateInputCustody }
        : {}),
      // Fresh F2 is registered only in this local bootstrap to obtain genuinely
      // accepted original records. Execution/reconstruction uses retained maps.
      forms: retained ? maps.forms : { ...maps.forms, [V2_CONTAINER_F2_FORM]: form },
      retainedForms: retained ? maps.retainedForms : {},
      ...(retained && ports.v2RetainedExecutionActions
        ? { retainedExecutionActions: ports.v2RetainedExecutionActions }
        : {}),
    };
  }
  const engine = (retained = true, privateCustody = true) =>
    createTakoformV2Engine(
      options(retained, privateCustody),
      node.appPorts.v2ContainerHostAcceptance,
    );
  const spec = {
    image: `registry.example/app@sha256:${"1".repeat(64)}`,
    httpPort: 8080,
    healthPath: "/health",
    workloadRevision: "1".repeat(64),
    environment: {},
    requiredSensitiveVars: ["SECRET"],
    outboundInternet: true,
  };
  async function create(name: string) {
    return engine(false).acceptCreate({
      principal: PRINCIPAL,
      key: crypto.randomUUID(),
      input: {
        form: V2_CONTAINER_F2_FORM,
        space: "synthetic-space",
        name,
        spec,
        privateInputs: { SECRET: "synthetic-selected-transient" },
      },
    });
  }
  async function update() {
    const created = await create("for-update");
    // Original engine failure before dispatch releases busy state. This is a
    // real failed/no-effect custody path, never a fake successful CREATE/ready DTO.
    expect(await engine(false, false).runNext()).toMatchObject({
      id: created.id,
      status: "failed",
      effect: "none",
      error: { code: "private_inputs_unverifiable" },
    });
    expect(raw.requests).toEqual([]);
    return engine(false).acceptUpdate({
      principal: PRINCIPAL,
      key: crypto.randomUUID(),
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: { ...spec, workloadRevision: "2".repeat(64) },
      privateInputs: { SECRET: "synthetic-selected-update" },
    });
  }
  return {
    sql,
    clock,
    time,
    selection,
    raw,
    engine,
    create,
    update,
    node: () => node,
    rawHandler(value: Engine) {
      handler = value;
    },
    async reselect(field: "backendId" | "targetKey") {
      await node.close();
      node = compose({ ...selection, [field]: `synthetic-different-${field}` });
    },
    async snapshot(operation: V2Operation) {
      // Compare only digests on assertion failure; no private values/ciphertext
      // or full original accepted records are printed by this test.
      return canonicalDigest({
        operation: await sql.query("SELECT * FROM tf_v2_operations WHERE id=?", [operation.id]),
        resource: await sql.query("SELECT * FROM tf_v2_resources WHERE uid=?", [
          operation.resourceUid,
        ]),
        private: await sql.query("SELECT * FROM tf_v2_private_inputs WHERE operation_id=?", [
          operation.id,
        ]),
        accepted: await sql.query(
          "SELECT * FROM tf_v2_container_acceptances WHERE resource_uid=? ORDER BY generation",
          [operation.resourceUid],
        ),
        instance: await sql.query("SELECT * FROM tf_v2_container_instances WHERE resource_uid=?", [
          operation.resourceUid,
        ]),
      });
    },
    async unclaimed(operation: V2Operation) {
      expect(
        await sql.query(
          "SELECT status,effect,dispatch_possible,lease_token FROM tf_v2_operations WHERE id=?",
          [operation.id],
        ),
      ).toEqual([{ status: "queued", effect: "none", dispatch_possible: 0, lease_token: null }]);
    },
    async close() {
      try {
        await node.close();
      } finally {
        raw.restore();
        database.close();
      }
    },
  };
}

test("selected composer default delete-only holds original accepted CREATE and UPDATE before claim or custody consumption", async () => {
  const f = await fixture();
  try {
    const updated = await f.update();
    const created = await f.create("held-create");
    const before = await Promise.all([f.snapshot(updated), f.snapshot(created)]);
    const selected = f.engine();
    expect(f.node().appPorts.v2RetainedExecutionActions?.[V2_CONTAINER_F2_FORM]).toEqual([
      "delete",
    ]);
    expect(await selected.runNext()).toBeNull();
    expect(await Promise.all([f.snapshot(updated), f.snapshot(created)])).toEqual(before);
    await f.unclaimed(updated);
    await f.unclaimed(created);
    expect(await f.sql.query("SELECT * FROM tf_v2_container_create_claims")).toEqual([]);
    expect(await f.sql.query("SELECT * FROM tf_v2_container_start_attempts")).toEqual([]);
    expect(f.raw.requests).toEqual([]);
  } finally {
    await f.close();
  }
});

test("captured Node actions keep F2 held while a different genuine Form still executes", async () => {
  const allowed: V2Action[] = ["delete"];
  const rules: Record<string, readonly V2Action[]> = { [V2_CONTAINER_F2_FORM]: allowed };
  const f = await fixture(rules);
  try {
    const held = await f.create("captured-held");
    const selected = f.engine();
    allowed.push("create", "update");
    rules[V2_CONTAINER_F2_FORM] = ["create", "update", "delete"];
    const other = await selected.acceptCreate({
      principal: PRINCIPAL,
      key: crypto.randomUUID(),
      input: {
        form: STATIC_ASSET_BUNDLE_FORM_URL,
        space: "synthetic-space",
        name: "other-form",
        spec: {
          artifact: { url: "https://artifacts.example.test/not-held.json", sha256: "2".repeat(64) },
        },
      },
    });
    const before = await f.snapshot(held);
    // Original held-artifact backend fails without bytes; no successful fake backend.
    expect(await selected.runNext()).toMatchObject({
      id: other.id,
      status: "failed",
      effect: "none",
      error: { code: "artifact_unavailable" },
    });
    expect(await selected.runNext()).toBeNull();
    expect(await f.snapshot(held)).toBe(before);
    await f.unclaimed(held);
    expect(f.raw.requests).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const action of ["create", "update"] as const) {
  test(`explicit selected ${action} reaches original runtime read then lease revocation fences native effects`, async () => {
    const f = await fixture({ [V2_CONTAINER_F2_FORM]: [action] });
    try {
      const operation = action === "create" ? await f.create("explicit-create") : await f.update();
      const docker = engineDouble();
      let revoked = false;
      f.rawHandler(async (method, path, body) => {
        if (method !== "GET") throw new Error("native effect forbidden in local regression");
        if (!revoked) {
          revoked = true;
          await f.sql.run("UPDATE tf_v2_operations SET lease_until_ms=0 WHERE id=?", [
            operation.id,
          ]);
        }
        const result = await docker.engine(method, path, body);
        return path === `/networks/${f.selection.docker.network}`
          ? { ...result, body: JSON.stringify({ ...JSON.parse(result.body), Internal: false }) }
          : result;
      });
      expect(await f.engine().runNext()).toMatchObject({
        id: operation.id,
        status: "reconciling",
        effect: "unknown",
      });
      expect(revoked).toBe(true);
      expect(f.raw.requests.length).toBeGreaterThan(0);
      expect(f.raw.requests.every(({ method }) => method === "GET")).toBe(true);
      expect(docker.creates()).toHaveLength(0);
      expect(docker.starts()).toHaveLength(0);
      expect(await f.sql.query("SELECT * FROM tf_v2_container_start_attempts")).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

for (const field of ["backendId", "targetKey"] as const) {
  test(`selected retained hold does not adopt another genuine ${field}`, async () => {
    const f = await fixture();
    try {
      const accepted = await f.create("original-binding");
      // A real closed/reconstructed composer with another selected identity;
      // no old owner and replacement owner are live together.
      await f.reselect(field);
      await expect(f.engine().runNext()).rejects.toMatchObject({ code: "temporarily_unavailable" });
      await f.unclaimed(accepted);
      const rows = await f.sql.query("SELECT next_attempt_at_ms FROM tf_v2_operations WHERE id=?", [
        accepted.id,
      ]);
      expect(rows[0]?.next_attempt_at_ms).toBe(f.time + 60_000);
      expect(f.raw.requests).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

test("selected engine keeps original closed-composer refusal after claim without native IO", async () => {
  const f = await fixture({ [V2_CONTAINER_F2_FORM]: ["create"] });
  try {
    const accepted = await f.create("closed");
    const engine = f.engine();
    await f.node().close();
    expect(await engine.runNext()).toMatchObject({
      id: accepted.id,
      status: "reconciling",
      effect: "unknown",
    });
    expect(
      await f.sql.query("SELECT dispatch_possible,lease_token FROM tf_v2_operations WHERE id=?", [
        accepted.id,
      ]),
    ).toEqual([{ dispatch_possible: 1, lease_token: null }]);
    expect(f.raw.requests).toEqual([]);
  } finally {
    await f.close();
  }
});
