import { expect, test } from "bun:test";
import { readV2ConfiguredPrivateInputs } from "../src/takoform-v2/configured-private-inputs.ts";
import { V2_CONTAINER_F2_FORM } from "../src/takoform-v2/container-owner-schema.ts";
import {
  containerSpec,
  dockerSourceFixture,
  PRINCIPAL,
  revision,
  SPACE,
  VALUE,
} from "./helpers/docker-container-configured-source-selection.ts";

// Accepted explicit CREATE/PUT history chooses the configured-map source on its
// own. Whether the chosen operation's material can be read decides only whether
// the omitted PUT may proceed, never which operation is the source.
//
// Disposable synthetic values only. The fault hides one accepted UPDATE
// operation's material row from the consumer's READ responses (see the helper);
// no physical row, ciphertext or write is changed, and nothing grants authority.
//
// Scope of this file: admission, on the in-memory SQLite substrate with the real Core
// engine, the Docker owner's acceptance hooks and the configured-input hooks. The
// selector's use during execution (withAcceptedInputs) and the execution generation
// fence are not exercised: no test reaches them, because the Docker owner refuses to
// execute a configured Operation at this base. This is not D1, Workerd or Docker
// native qualification.

const UNAVAILABLE = "Container configured inputs unavailable";

type Fixture = Awaited<ReturnType<typeof dockerSourceFixture>>;

async function omittedPut(fx: Fixture, uid: string, expectedGeneration: number, workload: string) {
  const before = fx.fingerprint();
  try {
    return {
      kind: "accepted" as const,
      operation: await fx.update(uid, expectedGeneration, workload),
    };
  } catch (error) {
    return {
      kind: "refused" as const,
      message: error instanceof Error ? error.message : String(error),
      unchanged: fx.fingerprint().equals(before),
    };
  }
}

/**
 * Two outcomes conform: the PUT is refused with nothing written, or it is
 * accepted and its Operation fails secret_unavailable before any start. Both
 * require that no value of an older source reaches the start callback.
 *
 * At this base the accepted outcome cannot be proven: the Docker owner refuses to
 * execute a configured Operation before the configured-input layer is reached
 * (it stops at stage "accepted"), which this oracle rejects. Status, effect and
 * code below come from the test Form's own contract mapping of a failed start,
 * not from product output; started, stoppedAt and messages are the load-bearing
 * parts.
 */
async function expectNoStaleStart(fx: Fixture, outcome: Awaited<ReturnType<typeof omittedPut>>) {
  if (outcome.kind === "refused") {
    expect(outcome).toEqual({ kind: "refused", message: UNAVAILABLE, unchanged: true });
    return;
  }
  fx.dispatch(fx.genuineDispatch);
  const result = await fx.engine.runNext();
  const lease = fx.database
    .query("SELECT lease_token, lease_until_ms FROM tf_v2_operations WHERE id = ?")
    .get(outcome.operation.id);
  const retried = await fx.engine.runNext();
  // Reaching the start callback with any map is wrong here. Only the configured-input
  // layer's own refusal inside the environment loan counts; an owner refusal in an
  // earlier stage, or in the loan's own guards, proves nothing about the source.
  expect({
    started: fx.genuine.started,
    stoppedAt: fx.genuine.stopped.map((stop) => stop.stage),
    messages: fx.genuine.stopped.map((stop) => stop.message),
    status: result?.status,
    effect: result?.effect,
    code: result?.error?.code,
    lease,
    idleAfterRetry: retried === null,
  }).toEqual({
    started: [],
    stoppedAt: ["environment"],
    messages: [UNAVAILABLE],
    status: "failed",
    effect: "none",
    code: "secret_unavailable",
    lease: { lease_token: null, lease_until_ms: null },
    idleAfterRetry: true,
  });
}

async function settle(fx: Fixture, accepted: { id: string }) {
  expect(await fx.engine.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
}

function material(fx: Fixture, operationId: string) {
  return fx.database
    .query(
      "SELECT operation_id, generation, key_id, nonce, ciphertext FROM tf_v2_operation_configured_private_inputs WHERE operation_id = ?",
    )
    .all(operationId);
}

test("latest explicit UPDATE material unreadable: an omitted PUT cannot revive CREATE", async () => {
  const fx = await dockerSourceFixture();
  try {
    const created = await fx.create("source-create", { SECRET: VALUE.create });
    await settle(fx, created);
    const rotated = await fx.update(created.resourceUid, 1, revision("2"), {
      SECRET: VALUE.second,
    });
    await settle(fx, rotated);
    const physical = material(fx, rotated.id);
    expect(physical).toHaveLength(1);
    fx.visibility.hide(rotated.id);

    const outcome = await omittedPut(fx, created.resourceUid, 2, revision("3"));

    expect(fx.visibility.hits()).toBeGreaterThan(0);
    expect(material(fx, rotated.id)).toEqual(physical);
    await expectNoStaleStart(fx, outcome);
  } finally {
    fx.database.close();
  }
});

test("latest explicit UPDATE material unreadable: an omitted PUT cannot revive an earlier UPDATE or CREATE", async () => {
  const fx = await dockerSourceFixture();
  try {
    const created = await fx.create("source-chain", { SECRET: VALUE.create });
    await settle(fx, created);
    const second = await fx.update(created.resourceUid, 1, revision("2"), {
      SECRET: VALUE.second,
    });
    await settle(fx, second);
    const third = await fx.update(created.resourceUid, 2, revision("3"), { SECRET: VALUE.third });
    await settle(fx, third);
    // CREATE and the earlier UPDATE stay readable; only the newest map is hidden.
    expect(material(fx, second.id)).toHaveLength(1);
    const physical = material(fx, third.id);
    expect(physical).toHaveLength(1);
    fx.visibility.hide(third.id);

    const outcome = await omittedPut(fx, created.resourceUid, 3, revision("4"));

    expect(fx.visibility.hits()).toBeGreaterThan(0);
    expect(material(fx, third.id)).toEqual(physical);
    await expectNoStaleStart(fx, outcome);
  } finally {
    fx.database.close();
  }
});

test("control: an unreadable superseded UPDATE does not block an omitted PUT after a readable newest map", async () => {
  const fx = await dockerSourceFixture();
  try {
    const created = await fx.create("source-superseded", { SECRET: VALUE.create });
    await settle(fx, created);
    const second = await fx.update(created.resourceUid, 1, revision("2"), {
      SECRET: VALUE.second,
    });
    await settle(fx, second);
    const third = await fx.update(created.resourceUid, 2, revision("3"), { SECRET: VALUE.third });
    await settle(fx, third);
    fx.visibility.hide(second.id);

    const outcome = await omittedPut(fx, created.resourceUid, 3, revision("4"));

    expect(fx.visibility.hits()).toBeGreaterThan(0);
    expect(outcome).toMatchObject({ kind: "accepted" });
    expect(outcome.kind === "accepted" && outcome.operation.generation).toBe(4);
  } finally {
    fx.database.close();
  }
});

test("control: omitted PUTs are accepted without a fault, after CREATE alone and after an explicit UPDATE", async () => {
  const fx = await dockerSourceFixture();
  try {
    const created = await fx.create("source-control", { SECRET: VALUE.create });
    await settle(fx, created);
    const inheritedCreate = await fx.update(created.resourceUid, 1, revision("2"));
    expect(inheritedCreate.generation).toBe(2);
    await settle(fx, inheritedCreate);
    const explicit = await fx.update(created.resourceUid, 2, revision("3"), {
      SECRET: VALUE.second,
    });
    await settle(fx, explicit);
    const inheritedUpdate = await fx.update(created.resourceUid, 3, revision("4"));
    expect(inheritedUpdate.generation).toBe(4);
    expect(material(fx, inheritedUpdate.id)).toEqual([]);
  } finally {
    fx.database.close();
  }
});

test("control: an explicit empty map lets an omitted PUT drop names, and re-adding one needs a full map", async () => {
  const fx = await dockerSourceFixture();
  try {
    const created = await fx.create("source-empty", { SECRET: VALUE.create });
    await settle(fx, created);
    // An explicit empty map is an accepted UPDATE with no material row. This control does
    // not reach latestSource (names [] returns early, a re-added name fails the names
    // check first); it pins the flows the new selection must not disturb.
    const emptied = await fx.update(created.resourceUid, 1, revision("2"), {}, []);
    await settle(fx, emptied);
    expect(material(fx, emptied.id)).toEqual([]);
    const omitted = await fx.update(created.resourceUid, 2, revision("3"), undefined, []);
    expect(omitted.generation).toBe(3);
    await settle(fx, omitted);
    // Naming the value again needs a full map; the retained CREATE map cannot return.
    const before = fx.fingerprint();
    await expect(fx.update(created.resourceUid, 3, revision("4"))).rejects.toThrow("invalid_spec");
    expect(fx.fingerprint().equals(before)).toBe(true);
  } finally {
    fx.database.close();
  }
});

test("generation fence: an admission-hook call for generation N considers only accepted history below N", async () => {
  const fx = await dockerSourceFixture();
  try {
    const both = ["OTHER", "SECRET"];
    const created = await fx.create("source-fence", { OTHER: "o-A", SECRET: VALUE.create }, both);
    await settle(fx, created);
    const second = await fx.update(
      created.resourceUid,
      1,
      revision("2"),
      { OTHER: "o-B", SECRET: VALUE.second },
      both,
    );
    await settle(fx, second);
    // Generation 3 narrows the declared names; its map is the newest accepted history.
    const third = await fx.update(created.resourceUid, 2, revision("3"), { SECRET: VALUE.third }, [
      "SECRET",
    ]);
    await settle(fx, third);

    const identity = {
      principal: PRINCIPAL,
      space: SPACE,
      name: "source-fence",
      form: V2_CONTAINER_F2_FORM,
      resourceUid: created.resourceUid,
    };
    const configured = await readV2ConfiguredPrivateInputs(fx.sql, identity);
    // A counterfactual admission-hook call: the engine accepted generation 3 with an explicit
    // map, so this re-asks the hook for generation 3 with the omitted map and both names.
    // The hook itself is admission, so this pins refusal and has no accepted-then-failed
    // alternative; execution-side selection and fence are not exercised by this file.
    const hook = () =>
      fx.codec.prepareUpdate({
        ...identity,
        operationId: third.id,
        generation: 3,
        previousSpec: containerSpec(revision("2"), both),
        spec: containerSpec(revision("3"), both),
        privateInputs: undefined,
        configured,
      });

    // Bounded by generation 2, the source is the UPDATE that declares both names.
    await expect(hook()).resolves.toBeUndefined();
    // With that source unreadable the call must be refused: the generation-3 map (names
    // SECRET only) is not a source for generation 3, and CREATE must not come back.
    fx.visibility.hide(second.id);
    await expect(hook()).rejects.toThrow(UNAVAILABLE);
    expect(fx.visibility.hits()).toBeGreaterThan(0);
  } finally {
    fx.database.close();
  }
});
