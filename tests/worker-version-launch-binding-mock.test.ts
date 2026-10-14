import { expect, test } from "bun:test";
import type { JsonObject } from "../src/ports.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseWorkerVersionSpec,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import {
  createWorkerVersionLaunchMock,
  MOCK_BINDING_TARGETS,
} from "./fixtures/worker-version-launch/host.ts";

test("the launch mock seals every declared binding UID and exact Form before any backend effect", async () => {
  const mock = createWorkerVersionLaunchMock();
  try {
    const { spec, bindings, worker, bundle } = await mock.seed();
    const before = mock.effects.length;
    const operation = await mock.engine.acceptCreate({
      principal: "org:fixture",
      key: "launch-all-bindings-create",
      input: { form: WORKER_VERSION_FORM_URL, name: "version", space: "fixture", spec },
    });
    expect(mock.effects).toHaveLength(before);
    const edges = await mock.sql.query(
      "SELECT target_uid, form_url FROM tf_v2_operation_references WHERE operation_id = ? ORDER BY target_uid",
      [operation.id],
    );
    const expected = [
      {
        target_uid: worker.resourceUid,
        form_url: "https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/",
      },
      {
        target_uid: bundle.resourceUid,
        form_url: "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/",
      },
      ...Object.entries(MOCK_BINDING_TARGETS).map(([key, { form }]) => ({
        target_uid: bindings[key]?.resourceUid,
        form_url: form,
      })),
    ].sort((a, b) => (a.target_uid ?? "").localeCompare(b.target_uid ?? ""));
    expect(edges).toEqual(expected);
    expect(await mock.engine.runNext()).toMatchObject({ id: operation.id, status: "succeeded" });
    expect(mock.effects.slice(before)).toMatchObject([
      {
        mode: "execute",
        execution: { operationId: operation.id, resourceUid: operation.resourceUid },
      },
    ]);
  } finally {
    mock.close();
  }
});

test("binding Form, Space and principal mismatches refuse before Version effects", async () => {
  const mock = createWorkerVersionLaunchMock();
  try {
    const { spec } = await mock.seed();
    const wrongTarget = await mock.create(MODULE_WORKER_FORM_URL, "wrong-actor-kind");
    const before = mock.effects.length;
    for (const [index, input] of [
      {
        spec: {
          ...spec,
          actorBindings: [{ name: "ACTOR", resource: { resourceUid: wrongTarget.resourceUid } }],
        },
        space: "fixture",
        principal: "org:fixture",
      },
      { spec, space: "other-space", principal: "org:fixture" },
      { spec, space: "fixture", principal: "org:other" },
      {
        spec: {
          ...spec,
          actorBindings: [{ name: "ACTOR", resource: { resourceUid: "missing-actor-uid" } }],
        },
        space: "fixture",
        principal: "org:fixture",
      },
    ].entries()) {
      await expect(
        mock.engine.acceptCreate({
          principal: input.principal,
          key: `launch-rejected-create-${index}`,
          input: {
            form: WORKER_VERSION_FORM_URL,
            name: `refused-${index}`,
            space: input.space,
            spec: input.spec,
          },
        }),
      ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
    }
    expect(mock.effects).toHaveLength(before);
  } finally {
    mock.close();
  }
});

test("a retained Version replays and reconciles its original UID but accepts no new create or update", async () => {
  const mock = createWorkerVersionLaunchMock({ loseVersionCreateAck: true });
  try {
    const { spec } = await mock.seed();
    const request = {
      principal: "org:fixture",
      key: "launch-lost-ack-create",
      input: { form: WORKER_VERSION_FORM_URL, name: "version", space: "fixture", spec },
    };
    const accepted = await mock.engine.acceptCreate(request);
    expect(await mock.engine.runNext()).toMatchObject({
      id: accepted.id,
      status: "reconciling",
      effect: "unknown",
    });
    const retained = mock.retainedEngine();
    expect(retained.supportsForm(WORKER_VERSION_FORM_URL)).toBe(false);
    expect(await retained.acceptCreate(request)).toMatchObject({
      id: accepted.id,
      resourceUid: accepted.resourceUid,
    });
    expect(
      await retained.getResource({ principal: "org:fixture", uid: accepted.resourceUid }),
    ).toMatchObject({ form: WORKER_VERSION_FORM_URL, spec });
    await expect(
      retained.getResource({ principal: "org:other", uid: accepted.resourceUid }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(
      retained.acceptCreate({
        ...request,
        input: { ...request.input, spec: { ...spec, handlers: ["fetch"] } },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    await expect(
      retained.acceptCreate({
        ...request,
        key: "launch-new-create-refused",
        input: { ...request.input, name: "new-version" },
      }),
    ).rejects.toMatchObject({ code: "unsupported_form", status: 422 });
    mock.advance();
    expect(await retained.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
    await expect(
      retained.acceptUpdate({
        principal: "org:fixture",
        key: "launch-new-update-refused",
        uid: accepted.resourceUid,
        expectedGeneration: 1,
        spec,
      }),
    ).rejects.toMatchObject({ code: "unsupported_form", status: 422 });
    const versionEffects = mock.effects.filter(
      ({ execution }) => execution.resourceUid === accepted.resourceUid,
    );
    expect(
      versionEffects.map(({ mode, execution }) => ({
        mode,
        action: execution.action,
        operation: execution.operationId,
      })),
    ).toEqual([
      { mode: "execute", action: "create", operation: accepted.id },
      { mode: "reconcile", action: "create", operation: accepted.id },
    ]);
  } finally {
    mock.close();
  }
});

test("retained Version binding edges fence target deletion until exact Version deletion settles", async () => {
  const mock = createWorkerVersionLaunchMock();
  try {
    const { spec, bindings } = await mock.seed();
    const accepted = await mock.engine.acceptCreate({
      principal: "org:fixture",
      key: "launch-retained-edges-create",
      input: { form: WORKER_VERSION_FORM_URL, name: "version", space: "fixture", spec },
    });
    expect(await mock.engine.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
    const retained = mock.retainedEngine();
    const actorUid = bindings.actorBindings?.resourceUid;
    if (!actorUid) throw new Error("mock Actor target was not seeded");
    await expect(
      retained.acceptDelete({
        principal: "org:fixture",
        key: "launch-actor-delete-fenced",
        uid: actorUid,
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
    const removed = await retained.acceptDelete({
      principal: "org:fixture",
      key: "launch-retained-version-delete",
      uid: accepted.resourceUid,
      expectedGeneration: 1,
    });
    expect(await retained.runNext()).toMatchObject({ id: removed.id, status: "succeeded" });
    expect(await retained.getResource({ principal: "org:fixture", uid: actorUid })).toMatchObject({
      uid: actorUid,
      generation: 1,
    });
    const actorRemoved = await retained.acceptDelete({
      principal: "org:fixture",
      key: "launch-actor-delete-unfenced",
      uid: actorUid,
      expectedGeneration: 1,
    });
    expect(await retained.runNext()).toMatchObject({ id: actorRemoved.id, status: "succeeded" });
    expect(
      mock.effects.filter(
        ({ execution }) =>
          execution.resourceUid === accepted.resourceUid && execution.action === "delete",
      ),
    ).toHaveLength(1);
  } finally {
    mock.close();
  }
});

test("retained recovery cannot replace the accepted backend or target identity", async () => {
  const mock = createWorkerVersionLaunchMock();
  try {
    const { spec } = await mock.seed();
    const accepted = await mock.engine.acceptCreate({
      principal: "org:fixture",
      key: "launch-original-backend-create",
      input: { form: WORKER_VERSION_FORM_URL, name: "version", space: "fixture", spec },
    });
    expect(await mock.engine.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
    const before = mock.effects.length;
    for (const [index, altered] of [
      { id: "replacement-backend" },
      { targetKey: "replacement-target" },
    ].entries()) {
      const wrong = mock.retainedEngine({ ...mock.backend, ...altered });
      await expect(
        wrong.acceptDelete({
          principal: "org:fixture",
          key: `launch-wrong-custody-delete-${index}`,
          uid: accepted.resourceUid,
          expectedGeneration: 1,
        }),
      ).rejects.toMatchObject({ code: "temporarily_unavailable", status: 503 });
    }
    expect(mock.effects).toHaveLength(before);
  } finally {
    mock.close();
  }
});

test("pending Container and domain fields never widen the frozen 0.5 declaration", async () => {
  const mock = createWorkerVersionLaunchMock();
  try {
    const { spec } = await mock.seed();
    for (const addition of [
      { containerBindings: [{ name: "APP", resource: { resourceUid: "pending-container-uid" } }] },
      { customDomain: { hostname: "example.test" } },
      { actorBindings: [{ name: "SERVICE", resource: { resourceUid: "actor-uid" } }] },
    ] satisfies JsonObject[]) {
      expect(() => parseWorkerVersionSpec({ ...spec, ...addition })).toThrow(
        expect.objectContaining({ code: "invalid_spec" }),
      );
    }
  } finally {
    mock.close();
  }
});
