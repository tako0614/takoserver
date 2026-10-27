import { expect, test } from "bun:test";
import { dockerOwnerFixture } from "./helpers/docker-container-configured-owner-snapshot.ts";
import { revision } from "./helpers/docker-container-configured-source-selection.ts";

// A configured Docker F2 CREATE has to pass the Docker Core owner's acceptance
// snapshot before the owner will issue a claim or an environment loan. The CREATE's
// material is Resource-owned (no accepted-UPDATE row), so the snapshot has to read
// it as the CREATE anchor. These tests go through the real Core engine, the real
// Docker Core owner and the production create-custody / DockerHTTP revision runtime;
// the owner issues the claim, the bind, the start claim and every environment loan.
//
// What is not production: serving. The plain DockerContainerRuntimePreparation has no
// production caller of the owner's publishServing (only the Linux physical preparation
// calls it), so the helper calls the owner's own publishServing after a ready
// observation, inside a real reconcile authority. How many environment loans a CREATE
// opens (create plus the custody's inspections) is not measured; the oracle is the one
// native create request that carries the values.
//
// Substrate and doubles: see the header of the helper. Values are disposable.

const NAMES = ["OTHER", "SECRET"];
const A = { OTHER: "synthetic-other-A", SECRET: "synthetic-secret-A" };
const B = { OTHER: "synthetic-other-B", SECRET: "synthetic-secret-B" };

function sql(fx: { database: { query(statement: string): { all(): unknown[] } } }, text: string) {
  return fx.database.query(text).all();
}

/** Env entries a Docker create request carried for the declared secret names. */
function secretEnv(create: { body?: unknown } | undefined, names: readonly string[]) {
  const env = ((create?.body as { Env?: string[] } | undefined)?.Env ?? []).filter((entry) =>
    names.some((name) => entry.startsWith(`${name}=`)),
  );
  return env.sort();
}

test("a configured CREATE reaches the one native create request with the full map", async () => {
  const { fx, docker, outcomes, dispatch, claimedViaOwner } = await dockerOwnerFixture();
  try {
    fx.dispatch(dispatch);
    const created = await fx.create("owner-create", A, NAMES);

    const result = await fx.engine.runNext();

    expect(outcomes.map((outcome) => outcome.failure)).toEqual([undefined]);
    expect(result).toMatchObject({ id: created.id, status: "succeeded", effect: "complete" });
    // The native create is where the loaned values land: one request, the full synthetic map.
    expect(docker.creates()).toHaveLength(1);
    expect(secretEnv(docker.creates()[0], NAMES)).toEqual([
      "OTHER=synthetic-other-A",
      "SECRET=synthetic-secret-A",
    ]);
    // Claim, bind and start claim were issued by the real owner through the production
    // custody and runtime; serving is the helper's call of the owner's publishServing.
    expect(
      sql(
        fx,
        "SELECT generation, state, native_id IS NOT NULL AS bound FROM tf_v2_container_create_claims",
      ),
    ).toEqual([{ generation: 1, state: "bound", bound: 1 }]);
    expect(claimedViaOwner).toHaveLength(1);
    expect(docker.starts()).toHaveLength(1);
    expect(sql(fx, "SELECT generation, state FROM tf_v2_container_start_attempts")).toEqual([
      { generation: 1, state: "running" },
    ]);
    expect(
      sql(fx, "SELECT desired_generation, serving_generation FROM tf_v2_container_instances"),
    ).toEqual([{ desired_generation: 1, serving_generation: 1 }]);
    expect(sql(fx, "SELECT generation, retention FROM tf_v2_container_revisions")).toEqual([
      { generation: 1, retention: "serving" },
    ]);
  } finally {
    fx.database.close();
  }
});

test("a CREATE without declared secret names is unaffected by the snapshot", async () => {
  const { fx, docker, outcomes, dispatch } = await dockerOwnerFixture();
  try {
    fx.dispatch(dispatch);
    const created = await fx.create("owner-plain", {}, []);

    const result = await fx.engine.runNext();

    expect(outcomes.map((outcome) => outcome.failure)).toEqual([undefined]);
    expect(result).toMatchObject({ id: created.id, status: "succeeded" });
    expect(docker.creates()).toHaveLength(1);
    expect(secretEnv(docker.creates()[0], NAMES)).toEqual([]);
  } finally {
    fx.database.close();
  }
});

test("guard: CREATE material the owner cannot read is refused before any claim, loan or native effect", async () => {
  const { fx, docker, outcomes, dispatch } = await dockerOwnerFixture();
  try {
    fx.dispatch(dispatch);
    const created = await fx.create("owner-missing", A, NAMES);
    const physical = sql(
      fx,
      "SELECT resource_uid, key_id, nonce, ciphertext FROM tf_v2_configured_private_inputs",
    );
    expect(physical).toHaveLength(1);
    // Read-visibility simulation only: a TEMP VIEW hides this Resource's CREATE material
    // from unqualified reads. The row, its ciphertext and every write stay as they are.
    fx.database.exec(
      `CREATE TEMP VIEW tf_v2_configured_private_inputs AS
       SELECT * FROM main.tf_v2_configured_private_inputs WHERE resource_uid <> '${created.resourceUid}'`,
    );

    const result = await fx.engine.runNext();

    expect(result).toMatchObject({ id: created.id, status: "reconciling", effect: "unknown" });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.failure).toMatchObject({
      at: "readAcceptedExecution",
      message: "Docker Core owner authority refused",
    });
    expect(docker.calls).toEqual([]);
    expect(sql(fx, "SELECT * FROM tf_v2_container_create_claims")).toEqual([]);
    expect(sql(fx, "SELECT * FROM tf_v2_container_start_attempts")).toEqual([]);
    expect(
      sql(
        fx,
        "SELECT resource_uid, key_id, nonce, ciphertext FROM main.tf_v2_configured_private_inputs",
      ),
    ).toEqual(physical);
  } finally {
    fx.database.close();
  }
});

test("guard: an execution whose scope differs from the accepted Operation is refused before any effect", async () => {
  const { fx, docker, outcomes, dispatch } = await dockerOwnerFixture();
  try {
    // The backend hands the owner a copy of the engine's execution with another principal.
    // A negative probe of the owner's scope check, not a way to obtain authority. The refusal
    // comes from the execution check, not from the snapshot: it guards against loosening.
    fx.dispatch((input) => dispatch({ ...input, principal: "synthetic-other-principal" }));
    const created = await fx.create("owner-scope", A, NAMES);

    const result = await fx.engine.runNext();

    expect(result).toMatchObject({ id: created.id, status: "reconciling", effect: "unknown" });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.failure).toMatchObject({
      at: "readAcceptedExecution",
      message: "Docker Core owner authority refused",
    });
    expect(docker.calls).toEqual([]);
    expect(sql(fx, "SELECT * FROM tf_v2_container_create_claims")).toEqual([]);
  } finally {
    fx.database.close();
  }
});

test("after the CREATE is served through the owner, an explicit full-map PUT executes and delivers its own map", async () => {
  const { fx, docker, outcomes, dispatch } = await dockerOwnerFixture();
  try {
    fx.dispatch(dispatch);
    const created = await fx.create("owner-explicit", A, NAMES);
    expect(await fx.engine.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
    const second = await fx.update(created.resourceUid, 1, revision("2"), B, NAMES);

    const result = await fx.engine.runNext();

    expect(outcomes.map((outcome) => outcome.failure)).toEqual([undefined, undefined]);
    expect(result).toMatchObject({ id: second.id, status: "succeeded", effect: "complete" });
    expect(docker.creates()).toHaveLength(2);
    expect(secretEnv(docker.creates()[1], NAMES)).toEqual([
      "OTHER=synthetic-other-B",
      "SECRET=synthetic-secret-B",
    ]);
    expect(
      sql(fx, "SELECT generation, retention FROM tf_v2_container_revisions ORDER BY generation"),
    ).toEqual([
      { generation: 1, retention: "draining" },
      { generation: 2, retention: "serving" },
    ]);
    expect(
      sql(fx, "SELECT desired_generation, serving_generation FROM tf_v2_container_instances"),
    ).toEqual([{ desired_generation: 2, serving_generation: 2 }]);
  } finally {
    fx.database.close();
  }
});

test("guard: hiding one Resource's CREATE material refuses only that Resource, not another configured one", async () => {
  const { fx, docker, outcomes, dispatch } = await dockerOwnerFixture();
  try {
    fx.dispatch(dispatch);
    const hidden = await fx.create("owner-hidden", A, NAMES);
    const visible = await fx.create("owner-visible", B, NAMES);
    fx.database.exec(
      `CREATE TEMP VIEW tf_v2_configured_private_inputs AS
       SELECT * FROM main.tf_v2_configured_private_inputs WHERE resource_uid <> '${hidden.resourceUid}'`,
    );

    const first = await fx.engine.runNext();
    const second = await fx.engine.runNext();

    expect(first).toMatchObject({ id: hidden.id, status: "reconciling" });
    expect(second).toMatchObject({ id: visible.id, status: "succeeded" });
    expect(outcomes.map((outcome) => outcome.failure?.at)).toEqual([
      "readAcceptedExecution",
      undefined,
    ]);
    // Only the visible Resource's own map reached a native create; the other Resource's did not.
    expect(docker.creates()).toHaveLength(1);
    expect(secretEnv(docker.creates()[0], NAMES)).toEqual([
      "OTHER=synthetic-other-B",
      "SECRET=synthetic-secret-B",
    ]);
  } finally {
    fx.database.close();
  }
});

test("guard: an explicit PUT whose own material the owner cannot read is refused before any effect", async () => {
  const { fx, docker, outcomes, dispatch } = await dockerOwnerFixture();
  try {
    fx.dispatch(dispatch);
    const created = await fx.create("owner-explicit-hidden", A, NAMES);
    expect(await fx.engine.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
    const second = await fx.update(created.resourceUid, 1, revision("2"), B, NAMES);
    // Read-visibility simulation of the UPDATE's own row (helper of the source-selection unit).
    fx.visibility.hide(second.id);

    const result = await fx.engine.runNext();

    expect(result).toMatchObject({ id: second.id, status: "reconciling", effect: "unknown" });
    expect(outcomes.at(-1)?.failure).toMatchObject({
      at: "readAcceptedExecution",
      message: "Docker Core owner authority refused",
    });
    expect(fx.visibility.hits()).toBeGreaterThan(0);
    // No second claim and no second native create: only generation 1 was ever served.
    expect(docker.creates()).toHaveLength(1);
    expect(sql(fx, "SELECT generation FROM tf_v2_container_create_claims")).toEqual([
      { generation: 1 },
    ]);
  } finally {
    fx.database.close();
  }
});
