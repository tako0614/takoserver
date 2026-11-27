import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as http from "node:http";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { V2_CONTAINER_F2_FORM } from "../src/container-contract.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { parseRuntimeInputKeyAuthority } from "../src/runtime-input-seal-keyring.ts";
import { createSelfhostLinuxDockerNodeComposition } from "../src/selfhost-linux-docker-node-composition.ts";
import {
  createSelfhostLinuxDockerNodeSelection,
  type SelfhostLinuxDockerNodeSelectionSource,
} from "../src/selfhost-linux-docker-node-selection.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { readV2ConfiguredPrivateInputs } from "../src/takoform-v2/configured-private-inputs.ts";
import { additiveV2ConfiguredUpdateInputsDDL } from "../src/takoform-v2/configured-update-inputs-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { SOURCE_SELECTION } from "./helpers/docker-container-configured-source-selection.ts";

// Disposable local input to the original parser, never operator configuration.
async function keyAuthority() {
  const encoded = (byte: number) =>
    btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
  return parseRuntimeInputKeyAuthority(
    JSON.stringify({
      current: { id: "synthetic-node-current", key: encoded(1) },
      previous: [{ id: "synthetic-node-previous", key: encoded(2) }],
    }),
  );
}

function hostSelection(): SelfhostLinuxDockerNodeSelectionSource {
  return {
    installationId: SOURCE_SELECTION.providerInstallationId,
    backendId: SOURCE_SELECTION.backendId,
    targetKey: SOURCE_SELECTION.targetKey,
    configuredInputs: { maxSecretBytes: 4096 },
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
}

test("absent Host choice stays disabled without reading a key authority", () => {
  expect(
    createSelfhostLinuxDockerNodeSelection({
      selection: undefined,
      get sealKeys(): never {
        throw new Error("unselected key authority read");
      },
    }),
  ).toBeUndefined();
});

test("parsed current and rotation keys retain their original capabilities and captured identities", async () => {
  const authority = await keyAuthority();
  const previous = authority.sealKeys.previous?.[0];
  if (!previous) throw new Error("original rotation key unavailable");
  const ring = {
    current: { ...authority.sealKeys.current },
    previous: [{ ...previous }],
  };
  const source = hostSelection();
  const selected = createSelfhostLinuxDockerNodeSelection({ selection: source, sealKeys: ring });
  if (!selected) throw new Error("explicit Host selection unavailable");
  const keyring = selected.configuredInputs.keyring;
  expect(selected.runtime).toBe(source.runtime);
  expect(selected.docker).toBe(source.docker);
  expect(selected.configuredInputs.maxSecretBytes).toBe(4096);
  expect(keyring.current.key).toBe(authority.sealKeys.current.key);
  expect(keyring.keyForDecryption(keyring.current.id)).toBe(keyring.current.key);
  expect(keyring.keyForDecryption(previous.keyId)).toBe(previous.key);
  expect(keyring.keyForDecryption("absent")).toBeUndefined();
  // Local configured capsules and transfer custody retain separate original keys.
  expect(keyring.current.key).not.toBe(authority.privateInputCustody.transfer.current.key);
  ring.current.keyId = "changed-after-capture";
  ring.current.key = previous.key;
  ring.previous.length = 0;
  expect(keyring.current.id).toBe("synthetic-node-current");
  expect(keyring.current.key).toBe(authority.sealKeys.current.key);
  expect(keyring.keyForDecryption(previous.keyId)).toBe(previous.key);
});

test("selected Host refuses missing keys, wrong crypto, duplicate IDs and injected keyring/accessors", async () => {
  const authority = await keyAuthority();
  const select = (selection: SelfhostLinuxDockerNodeSelectionSource) =>
    createSelfhostLinuxDockerNodeSelection({ selection, sealKeys: authority.sealKeys });
  expect(() =>
    createSelfhostLinuxDockerNodeSelection({ selection: hostSelection(), sealKeys: undefined }),
  ).toThrow("operator seal keys unavailable");
  expect(() =>
    createSelfhostLinuxDockerNodeSelection({
      selection: hostSelection(),
      sealKeys: {
        current: {
          keyId: authority.sealKeys.current.keyId,
          key: authority.privateInputCustody.comparison.current.key,
        },
      },
    }),
  ).toThrow("invalid Linux Docker operator seal keys");
  expect(() =>
    createSelfhostLinuxDockerNodeSelection({
      selection: hostSelection(),
      sealKeys: { current: authority.sealKeys.current, previous: [authority.sealKeys.current] },
    }),
  ).toThrow("invalid Linux Docker operator seal keys");
  const injected = {
    ...hostSelection(),
    configuredInputs: { maxSecretBytes: 4096, keyring: authority.sealKeys },
  };
  expect(() => select(injected)).toThrow("invalid Linux Docker configured input selection");
  let reads = 0;
  const accessor = {
    ...hostSelection(),
    get installationId() {
      reads++;
      return SOURCE_SELECTION.providerInstallationId;
    },
  };
  expect(() => select(accessor)).toThrow();
  expect(reads).toBe(0);
});

test("original Node owner and engine seal accepted input on the same Sql without native dispatch", async () => {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  await sql.batch(
    frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((sql) => ({ sql })),
  );
  await sql.batch(v2ContainerOwnerMigrationCandidate());
  const authority = await keyAuthority();
  const selection = createSelfhostLinuxDockerNodeSelection({
    selection: hostSelection(),
    sealKeys: authority.sealKeys,
  });
  const clock = () => new Date();
  let rawRequests = 0;
  let rawChildren = 0;
  // Raw transport fences only; original factories and validation are intact.
  const request = spyOn(http, "request").mockImplementation(() => {
    rawRequests++;
    throw new Error("unexpected raw HTTP");
  });
  const spawn = spyOn(childProcess, "spawn").mockImplementation(() => {
    rawChildren++;
    throw new Error("unexpected raw child");
  });
  let node: ReturnType<typeof createSelfhostLinuxDockerNodeComposition> | undefined;
  try {
    node = createSelfhostLinuxDockerNodeComposition({
      sql,
      clock,
      selection,
      formSelectionFactory: undefined,
      privateInputCustody: authority.privateInputCustody,
    });
    const ports = node.appPorts;
    const factory = ports.v2FormSelectionFactory;
    const acceptance = ports.v2ContainerHostAcceptance;
    if (!factory || !acceptance) throw new Error("original selected Node owner unavailable");
    acceptance.assertSql(sql);
    expect(() => acceptance.assertSql(createSqliteSql(database))).toThrow();
    const objects = createMemoryObjectStore();
    expect(() => factory({ sql: createSqliteSql(database), objects, clock })).toThrow();
    const maps = factory({ sql, objects, clock });
    expect(Object.keys(maps.forms)).toEqual([]);
    const form = maps.retainedForms[V2_CONTAINER_F2_FORM];
    if (!form) throw new Error("original retained F2 unavailable");
    expect(ports.v2PrivateInputCustody).toBe(authority.privateInputCustody);
    expect(ports.v2RetainedExecutionActions?.[V2_CONTAINER_F2_FORM]).toEqual(["delete"]);
    // Test-local admission of the genuine Form only, never public registration.
    // No runNext: this proves the configured snapshot producer, not native readiness.
    const engine = createTakoformV2Engine(
      {
        sql,
        authorize: async () => true,
        replayWindowSeconds: 3600,
        privateInputCustody: authority.privateInputCustody,
        forms: { [V2_CONTAINER_F2_FORM]: form },
      },
      acceptance,
    );
    const identity = {
      principal: "synthetic-node-selection-parent",
      space: "synthetic-space",
      name: "synthetic-selected",
      form: V2_CONTAINER_F2_FORM,
    };
    const accepted = await engine.acceptCreate({
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
          environment: { MODE: "synthetic-selection" },
          requiredSensitiveVars: ["SECRET"],
          outboundInternet: true,
        },
        privateInputs: { SECRET: "synthetic-selection-transient" },
      },
    });
    const material = await readV2ConfiguredPrivateInputs(sql, {
      ...identity,
      resourceUid: accepted.resourceUid,
    });
    if (!material) throw new Error("original configured snapshot unavailable");
    expect(material.keyId).toBe(authority.sealKeys.current.keyId);
    expect(material.ciphertext).not.toContain("synthetic-selection-transient");
    expect(
      await readV2ConfiguredPrivateInputs(sql, {
        ...identity,
        principal: "different-parent",
        resourceUid: accepted.resourceUid,
      }),
    ).toBeNull();
    expect(await sql.query("SELECT count(*) AS n FROM tf_v2_container_create_claims")).toEqual([
      { n: 0 },
    ]);
    expect(await sql.query("SELECT count(*) AS n FROM tf_v2_container_start_attempts")).toEqual([
      { n: 0 },
    ]);
    await node.close();
    expect(() => factory({ sql, objects, clock })).toThrow("node_closed");
  } finally {
    try {
      await node?.close();
    } finally {
      request.mockRestore();
      spawn.mockRestore();
      database.close();
    }
  }
  expect(rawRequests).toBe(0);
  expect(rawChildren).toBe(0);
});
