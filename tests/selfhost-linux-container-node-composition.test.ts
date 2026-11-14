import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as http from "node:http";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { V2_CONTAINER_F2_FORM } from "../src/container-contract.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { Sql } from "../src/ports.ts";
import { parseRuntimeInputKeyAuthority } from "../src/runtime-input-seal-keyring.ts";
import { createSelfhostLinuxContainerNodeComposition } from "../src/selfhost-linux-container-node-composition.ts";
import {
  createSelfhostLinuxContainerNodeSelection,
  type SelfhostLinuxOciNodeSelectionSource,
} from "../src/selfhost-linux-container-node-selection.ts";
import { createSelfhostLinuxDockerNodeComposition } from "../src/selfhost-linux-docker-node-composition.ts";
import { createSelfhostLinuxDockerNodeSelection } from "../src/selfhost-linux-docker-node-selection.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import type { V2OperatorFormSelectionFactory } from "../src/takoform-v2/application.ts";
import { readV2ConfiguredPrivateInputs } from "../src/takoform-v2/configured-private-inputs.ts";
import { additiveV2ConfiguredUpdateInputsDDL } from "../src/takoform-v2/configured-update-inputs-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2Action } from "../src/takoform-v2/types.ts";

// Constructor/configured-admission harness only. Raw IO always throws; no
// original factory, owner, acceptance, configured hook or backend is replaced.
async function fixture() {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const sql = createSqliteSql(database),
    clock = () => new Date(),
    objects = createMemoryObjectStore();
  await sql.batch(
    frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((sql) => ({ sql })),
  );
  await sql.batch(v2ContainerOwnerMigrationCandidate());
  const encoded = (byte: number) =>
    btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
  const authority = await parseRuntimeInputKeyAuthority(
    JSON.stringify({
      current: { id: "synthetic-oci-node-current", key: encoded(1) },
      previous: [{ id: "synthetic-oci-node-previous", key: encoded(2) }],
    }),
  );
  const source: SelfhostLinuxOciNodeSelectionSource = {
    installationId: "synthetic-oci-node-installation",
    backendId: "synthetic-oci-node-backend",
    targetKey: "synthetic-oci-node-target",
    configuredInputs: { maxSecretBytes: 4096 },
    artifactRoot: "/synthetic/not-opened/artifacts",
    umociBinary: "/synthetic/not-executed/umoci",
    physicalBinary: "/synthetic/not-executed/oci",
    memoryBytes: 268435456,
    nanoCpus: 500000000,
    pidsLimit: 128,
    egressLimits: { maxConnections: 9, packetLimitBytes: 65536 },
    hostTopology: {
      interfaceName: "uplink0",
      interfaceIndex: 7,
      interfaceMac: "02:10:20:30:40:50",
      ipv4Address: "192.0.2.10/24",
      ipv4Gateway: "192.0.2.1",
      ipv6Address: "2001:db8:1::10/64",
      ipv6Gateway: "fe80::1",
      peerIpv4Host: "10.240.0.2",
      peerIpv4Guest: "10.240.0.3",
      peerIpv6Host: "fd60:1234::2",
      peerIpv6Guest: "fd60:1234::3",
    },
    images: {
      source: {
        origin: "https://registry.example",
        read() {
          throw new Error("unexpected raw image read");
        },
        expand() {
          throw new Error("unexpected raw image expansion");
        },
      },
      limits: {
        maxManifestBytes: 8192,
        maxConfigBytes: 8192,
        maxLayerCompressedBytes: 8192,
        maxTotalCompressedBytes: 16384,
        maxLayerExpandedBytes: 8192,
        maxTotalExpandedBytes: 16384,
        maxExpansionRatio: 100,
        maxLayers: 4,
        maxIndexEntries: 4,
        maxArchiveBytes: 65536,
        maxRetainedBytes: 131072,
        maxDurationMs: 5000,
      },
    },
  };
  const selection = createSelfhostLinuxContainerNodeSelection({
    selection: { kind: "oci", selection: source },
    sealKeys: authority.sealKeys,
  });
  if (selection?.kind !== "oci") throw new Error("original OCI selection absent");
  let io = 0;
  const spawn = spyOn(childProcess, "spawn").mockImplementation(() => {
    io++;
    throw new Error("unexpected raw child");
  });
  const request = spyOn(http, "request").mockImplementation(() => {
    io++;
    throw new Error("unexpected raw HTTP");
  });
  const nodes: ReturnType<typeof createSelfhostLinuxContainerNodeComposition>[] = [];
  const compose = (
    factory?: V2OperatorFormSelectionFactory,
    actions?: Readonly<Record<string, readonly V2Action[]>>,
  ) => {
    const node = createSelfhostLinuxContainerNodeComposition({
      sql,
      clock,
      selection,
      formSelectionFactory: factory,
      privateInputCustody: authority.privateInputCustody,
      ...(actions === undefined ? {} : { retainedExecutionActions: actions }),
    });
    nodes.push(node);
    return node;
  };
  return {
    sql,
    database,
    clock,
    objects,
    authority,
    source,
    selection,
    context: { sql, clock, objects },
    compose,
    io: () => io,
    async close() {
      try {
        for (const node of nodes) await node.close();
        expect(io).toBe(0);
      } finally {
        spawn.mockRestore();
        request.mockRestore();
        database.close();
      }
    },
  };
}

test("OCI Node code choice binds original parser keys and same-Sql configured acceptance without public support", async () => {
  const f = await fixture();
  try {
    const previous = f.authority.sealKeys.previous?.[0];
    if (!previous) throw new Error("original previous key absent");
    const keyring = f.selection.selection.configuredInputs.keyring;
    expect(keyring.current.key).toBe(f.authority.sealKeys.current.key);
    expect(keyring.keyForDecryption(previous.keyId)).toBe(previous.key);
    const node = f.compose(),
      ports = node.appPorts,
      factory = ports.v2FormSelectionFactory,
      acceptance = ports.v2ContainerHostAcceptance,
      actions = ports.v2RetainedExecutionActions;
    if (!factory || !acceptance || !actions) throw new Error("original Node owner absent");
    const maps = factory(f.context),
      form = maps.retainedForms[V2_CONTAINER_F2_FORM];
    if (!form) throw new Error("original retained OCI Form absent");
    expect(Object.keys(maps.forms)).toEqual([]);
    expect(form.backend.id).toBe(f.source.backendId);
    expect(form.backend.targetKey).toBe(f.source.targetKey);
    expect(ports.v2PrivateInputCustody).toBe(f.authority.privateInputCustody);
    expect(ports.v2RetainedExecutionActions?.[V2_CONTAINER_F2_FORM]).toEqual(["delete"]);
    acceptance.assertSql(f.sql);
    const bootstrap = createTakoformV2Engine(
      {
        sql: f.sql,
        authorize: async () => true,
        replayWindowSeconds: 3600,
        privateInputCustody: f.authority.privateInputCustody,
        forms: { [V2_CONTAINER_F2_FORM]: form },
      },
      acceptance,
    );
    const identity = {
      principal: "synthetic-oci-node-parent",
      space: "synthetic-space",
      name: "synthetic-node",
      form: V2_CONTAINER_F2_FORM,
    };
    const accepted = await bootstrap.acceptCreate({
      principal: identity.principal,
      key: crypto.randomUUID(),
      input: {
        form: identity.form,
        space: identity.space,
        name: identity.name,
        spec: {
          image: `registry.example/app@sha256:${"1".repeat(64)}`,
          httpPort: 8080,
          healthPath: "/health",
          workloadRevision: "1".repeat(64),
          requiredSensitiveVars: ["SECRET"],
        },
        privateInputs: { SECRET: "synthetic-node-loan" },
      },
    });
    const captured = await readV2ConfiguredPrivateInputs(f.sql, {
      ...identity,
      resourceUid: accepted.resourceUid,
    });
    expect(captured?.keyId).toBe(f.authority.sealKeys.current.keyId);
    expect(JSON.stringify(captured)).not.toContain("synthetic-node-loan");
    const retained = createTakoformV2Engine(
      {
        sql: f.sql,
        authorize: async () => true,
        replayWindowSeconds: 3600,
        privateInputCustody: f.authority.privateInputCustody,
        forms: maps.forms,
        retainedForms: maps.retainedForms,
        retainedExecutionActions: actions,
      },
      acceptance,
    );
    expect(await retained.runNext()).toBeNull();
    expect(await f.sql.query("SELECT dispatch_possible FROM tf_v2_operations")).toEqual([
      { dispatch_possible: 0 },
    ]);
    await expect(
      retained.acceptCreate({
        principal: identity.principal,
        key: crypto.randomUUID(),
        input: { form: identity.form, space: identity.space, name: "public", spec: {} },
      }),
    ).rejects.toMatchObject({ code: "unsupported_form" });
    expect(f.io()).toBe(0);
  } finally {
    await f.close();
  }
});

test("OCI Node refuses foreign Sql and duplicate or hidden original Form entries before IO", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const node = f.compose(() => {
      calls++;
      return { forms: {}, retainedForms: {} };
    });
    const factory = node.appPorts.v2FormSelectionFactory;
    if (!factory) throw new Error("original factory absent");
    const other = createSqliteSql(f.database);
    expect(() => factory({ ...f.context, sql: other })).toThrow("Sql");
    expect(calls).toBe(0);
    const maps = factory(f.context),
      original = maps.retainedForms[V2_CONTAINER_F2_FORM];
    if (!original) throw new Error("original Form absent");
    const collision = f.compose(() => ({
      forms: {},
      retainedForms: { [V2_CONTAINER_F2_FORM]: original },
    }));
    expect(() => collision.appPorts.v2FormSelectionFactory?.(f.context)).toThrow(
      "already_composed",
    );
    let reads = 0;
    const hidden = {};
    Object.defineProperty(hidden, V2_CONTAINER_F2_FORM, {
      get() {
        reads++;
        return original;
      },
    });
    const accessor = f.compose(() => ({ forms: {}, retainedForms: hidden }));
    expect(() => accessor.appPorts.v2FormSelectionFactory?.(f.context)).toThrow("already_composed");
    expect(reads).toBe(0);
  } finally {
    await f.close();
  }
});

test("OCI Node rejects missing custody keys and code-choice or action accessors without evaluating them", async () => {
  const f = await fixture();
  try {
    expect(() =>
      createSelfhostLinuxContainerNodeSelection({
        selection: { kind: "oci", selection: f.source },
        sealKeys: undefined,
      }),
    ).toThrow("seal keys unavailable");
    expect(() =>
      createSelfhostLinuxContainerNodeSelection({
        selection: { kind: "oci", selection: f.source },
        sealKeys: {
          current: {
            keyId: "wrong-role",
            key: f.authority.privateInputCustody.comparison.current.key,
          },
        },
      }),
    ).toThrow("invalid Linux OCI operator seal keys");
    expect(() =>
      createSelfhostLinuxContainerNodeComposition({
        get sql(): Sql {
          throw new Error("Sql read before custody");
        },
        clock: f.clock,
        selection: f.selection,
        formSelectionFactory: undefined,
        privateInputCustody: undefined,
      }),
    ).toThrow("private_input_custody_required");
    let reads = 0;
    const choice = { kind: "oci" as const, selection: f.source };
    Object.defineProperty(choice, "selection", {
      enumerable: true,
      get() {
        reads++;
        return f.source;
      },
    });
    expect(() =>
      createSelfhostLinuxContainerNodeSelection({
        selection: choice,
        sealKeys: f.authority.sealKeys,
      }),
    ).toThrow();
    const rules: Record<string, readonly V2Action[]> = {};
    Object.defineProperty(rules, V2_CONTAINER_F2_FORM, {
      enumerable: true,
      get() {
        reads++;
        return ["create"];
      },
    });
    expect(() => f.compose(undefined, rules)).toThrow("invalid retained execution selection");
    expect(reads).toBe(0);
  } finally {
    await f.close();
  }
});

test("disabled common and legacy Docker Node paths preserve references without reading Sql clock or keys", async () => {
  const f = await fixture();
  try {
    expect(
      createSelfhostLinuxContainerNodeSelection({
        selection: undefined,
        get sealKeys(): never {
          throw new Error("disabled keys read");
        },
      }),
    ).toBeUndefined();
    expect(
      createSelfhostLinuxDockerNodeSelection({
        selection: undefined,
        get sealKeys(): never {
          throw new Error("legacy disabled keys read");
        },
      }),
    ).toBeUndefined();
    const base: V2OperatorFormSelectionFactory = () => ({ forms: {}, retainedForms: {} });
    for (const compose of [
      createSelfhostLinuxContainerNodeComposition,
      createSelfhostLinuxDockerNodeComposition,
    ]) {
      const node = compose({
        get sql(): Sql {
          throw new Error("disabled Sql read");
        },
        get clock(): () => Date {
          throw new Error("disabled clock read");
        },
        selection: undefined,
        formSelectionFactory: base,
        privateInputCustody: f.authority.privateInputCustody,
      });
      expect(node.appPorts.v2FormSelectionFactory).toBe(base);
      expect(node.appPorts.v2PrivateInputCustody).toBe(f.authority.privateInputCustody);
      expect(Object.hasOwn(node.appPorts, "v2ContainerHostAcceptance")).toBe(false);
      await node.close();
    }
  } finally {
    await f.close();
  }
});

test("OCI Node close revokes the original factory and preserves database-before-shutdown ordering", async () => {
  const f = await fixture();
  try {
    const node = f.compose(undefined, { [V2_CONTAINER_F2_FORM]: ["create"] });
    const factory = node.appPorts.v2FormSelectionFactory;
    if (!factory) throw new Error("original factory absent");
    expect(Object.keys(factory(f.context).retainedForms)).toEqual([V2_CONTAINER_F2_FORM]);
    const joined = node.close();
    expect(node.close()).toBe(joined);
    expect(() => factory(f.context)).toThrow("selfhost_linux_oci_node_closed");
    await joined;
    expect(await f.sql.query("SELECT 1 AS database_still_owned")).toEqual([
      { database_still_owned: 1 },
    ]);
    expect(f.io()).toBe(0);
  } finally {
    await f.close();
  }
});

// Missing realized inputs remain configuration refusals, never default network
// values. Object.defineProperty models a malformed JS data field, not authority.
test("OCI Node refuses missing topology limits or physical target before Sql and raw IO", async () => {
  const f = await fixture();
  try {
    for (const key of ["hostTopology", "egressLimits", "physicalBinary"]) {
      const source = { ...f.source };
      Object.defineProperty(source, key, { value: undefined, enumerable: true });
      expect(() =>
        createSelfhostLinuxContainerNodeSelection({
          selection: { kind: "oci", selection: source },
          sealKeys: f.authority.sealKeys,
        }),
      ).toThrow("configuration_required");
      const selected = { ...f.selection.selection };
      Object.defineProperty(selected, key, { value: undefined, enumerable: true });
      expect(() =>
        createSelfhostLinuxContainerNodeComposition({
          get sql(): Sql {
            throw new Error("Sql read before configuration");
          },
          clock: f.clock,
          selection: { kind: "oci", selection: selected },
          formSelectionFactory: undefined,
          privateInputCustody: f.authority.privateInputCustody,
        }),
      ).toThrow("configuration_required");
    }
    expect(f.io()).toBe(0);
  } finally {
    await f.close();
  }
});

// Closed constructor/model source for the dedicated OCI binding cases only.
export { fixture as originalOciNodeBindingFixture };
