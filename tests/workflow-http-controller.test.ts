import { expect, test } from "bun:test";
import {
  type WorkflowDriver,
  WorkflowRuntimeError,
  WorkflowStepError,
} from "../src/workflow-driver.ts";
import {
  createWorkflowHttpController,
  type WorkflowHttpController,
} from "../src/workflow-http-controller.ts";

function driver(overrides: Partial<WorkflowDriver> = {}): WorkflowDriver {
  return {
    do: async (prepareName, preparePending) => {
      await prepareName();
      const pending = await preparePending();
      return pending.effect();
    },
    sleep: async (prepareName, preparePending) => {
      await prepareName();
      await preparePending();
    },
    waitForEvent: async (prepareName, preparePending) => {
      await prepareName();
      await preparePending();
      return undefined;
    },
    definitionMismatch: () => new Promise<never>(() => undefined),
    ...overrides,
  };
}

function send(
  controller: WorkflowHttpController,
  sequence: number,
  payload: string,
): Promise<string> {
  const response = controller.exchange(sequence, payload);
  controller.acceptFrame(sequence, payload);
  return response;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("drives a do turn through name, pending, effect, and raw JSON settlement", async () => {
  const controller = createWorkflowHttpController();
  controller.run(driver());

  const call = send(controller, 1, '{"kind":"call","call":1,"operation":"do"}');
  expect(await call).toBe('{"kind":"need_name"}');
  const name = send(controller, 2, '{"kind":"name","call":1,"name":"fetch"}');
  expect(await name).toBe('{"kind":"need_pending"}');
  const pending = send(controller, 3, '{"kind":"pending","call":1,"retryDelaysSeconds":[0,2]}');
  expect(await pending).toBe('{"kind":"invoke_effect"}');
  const effect = send(
    controller,
    4,
    '{"kind":"effect","call":1,"present":true,"value":{"ok":true}}',
  );
  expect(await effect).toBe('{"kind":"settled","present":true,"value":{"ok":true}}');
  await settle();
  expect(controller.outcome('{"kind":"complete","present":false}')).toEqual({ kind: "complete" });
  controller.close();
});

test("sleep and wait turns receive their operation-specific pending envelopes", async () => {
  const seen: string[] = [];
  const controller = createWorkflowHttpController();
  controller.run(
    driver({
      sleep: async (prepareName, preparePending) => {
        await prepareName();
        seen.push(String(await preparePending()));
      },
      waitForEvent: async (prepareName, preparePending) => {
        await prepareName();
        seen.push(JSON.stringify(await preparePending()));
        return { event: true };
      },
    }),
  );

  expect(await send(controller, 1, '{"kind":"call","call":1,"operation":"sleep"}')).toBe(
    '{"kind":"need_name"}',
  );
  expect(await send(controller, 2, '{"kind":"name","call":1,"name":"pause"}')).toBe(
    '{"kind":"need_pending"}',
  );
  expect(await send(controller, 3, '{"kind":"pending","call":1,"seconds":5}')).toBe(
    '{"kind":"settled","present":false}',
  );

  expect(await send(controller, 4, '{"kind":"call","call":2,"operation":"wait"}')).toBe(
    '{"kind":"need_name"}',
  );
  expect(await send(controller, 5, '{"kind":"name","call":2,"name":"event"}')).toBe(
    '{"kind":"need_pending"}',
  );
  expect(
    await send(controller, 6, '{"kind":"pending","call":2,"type":"ready","timeoutSeconds":10}'),
  ).toBe('{"kind":"settled","present":true,"value":{"event":true}}');
  expect(seen).toEqual(["5", '{"type":"ready","timeoutSeconds":10}']);
  controller.close();
});

test("completed memo-style turns may settle after name without a pending command", async () => {
  let pendingCalled = false;
  const controller = createWorkflowHttpController();
  controller.run(
    driver({
      do: async (prepareName, preparePending) => {
        await prepareName();
        if (pendingCalled) await preparePending();
        pendingCalled = true;
        return { memo: true };
      },
    }),
  );

  expect(await send(controller, 1, '{"kind":"call","call":1,"operation":"do"}')).toBe(
    '{"kind":"need_name"}',
  );
  expect(await send(controller, 2, '{"kind":"name","call":1,"name":"cached"}')).toBe(
    '{"kind":"settled","present":true,"value":{"memo":true}}',
  );
  controller.close();
});

test("a genuine step failure gets an opaque token and outcome returns the exact host error", async () => {
  const original = new WorkflowStepError("step_failed");
  const controller = createWorkflowHttpController();
  controller.run(
    driver({
      do: async (prepareName) => {
        await prepareName();
        throw original;
      },
    }),
  );
  expect(await send(controller, 1, '{"kind":"call","call":1,"operation":"do"}')).toBe(
    '{"kind":"need_name"}',
  );
  const response = send(controller, 2, '{"kind":"name","call":1,"name":"fail"}');
  const command = JSON.parse(await response) as Record<string, unknown>;
  expect(command).toMatchObject({ kind: "step_error", code: "step_failed" });
  const token = command.token;
  expect(typeof token).toBe("string");
  expect(
    controller.outcome(JSON.stringify({ kind: "failed", reason: "step_failed", token })),
  ).toEqual({
    kind: "failed",
    reason: "step_failed",
    error: original,
  });
  controller.close();
});

test("effect_failed is an ordinary attempt error and the core can turn it into step_failed", async () => {
  const controller = createWorkflowHttpController();
  controller.run(
    driver({
      do: async (prepareName, preparePending) => {
        await prepareName();
        const pending = await preparePending();
        try {
          return await pending.effect();
        } catch {
          throw new WorkflowStepError("step_failed");
        }
      },
    }),
  );
  expect(await send(controller, 1, '{"kind":"call","call":1,"operation":"do"}')).toBe(
    '{"kind":"need_name"}',
  );
  expect(await send(controller, 2, '{"kind":"name","call":1,"name":"effect"}')).toBe(
    '{"kind":"need_pending"}',
  );
  expect(await send(controller, 3, '{"kind":"pending","call":1,"retryDelaysSeconds":[]}')).toBe(
    '{"kind":"invoke_effect"}',
  );
  const command = JSON.parse(
    await send(controller, 4, '{"kind":"effect_failed","call":1}'),
  ) as Record<string, unknown>;
  expect(command).toMatchObject({ kind: "step_error", code: "step_failed" });
  controller.close();
});

test("input_error is accepted only during name or pending preparation and responds without a call field", async () => {
  const controller = createWorkflowHttpController();
  controller.run(
    driver({
      do: async (prepareName) => {
        try {
          await prepareName();
        } catch (error) {
          throw error;
        }
        return undefined;
      },
    }),
  );
  expect(await send(controller, 1, '{"kind":"call","call":1,"operation":"do"}')).toBe(
    '{"kind":"need_name"}',
  );
  expect(await send(controller, 2, '{"kind":"input_error","call":1}')).toBe(
    '{"kind":"input_error"}',
  );
  controller.close();
});

test("mismatch parks its request while the previous turn remains unresolved until close", async () => {
  let mismatches = 0;
  const controller = createWorkflowHttpController();
  controller.run(
    driver({
      definitionMismatch: () => {
        mismatches += 1;
        return new Promise<never>(() => undefined);
      },
    }),
  );
  const first = send(controller, 1, '{"kind":"call","call":1,"operation":"do"}');
  expect(await first).toBe('{"kind":"need_name"}');
  const parked = send(controller, 2, '{"kind":"mismatch"}');
  let settled = false;
  void parked.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await settle();
  expect(settled).toBe(false);
  expect(mismatches).toBe(1);
  controller.close();
  await expect(parked).rejects.toMatchObject({ code: "host_unavailable" });
});

test("mismatch may arrive before the first child call and fences later frames", async () => {
  let mismatches = 0;
  const controller = createWorkflowHttpController();
  controller.run(
    driver({
      definitionMismatch: () => {
        mismatches += 1;
        return new Promise<never>(() => undefined);
      },
    }),
  );
  const parked = send(controller, 1, '{"kind":"mismatch"}');
  await settle();
  expect(mismatches).toBe(1);
  expect(() => controller.acceptFrame(2, '{"kind":"call","call":1,"operation":"do"}')).toThrow(
    new WorkflowRuntimeError("invalid_runtime_input"),
  );
  await expect(parked).rejects.toMatchObject({ code: "invalid_runtime_input" });
});

test("transport close rejects a pending name wait with host_unavailable and never runs a late frame", async () => {
  let prepareNameCalls = 0;
  const controller = createWorkflowHttpController();
  controller.run(
    driver({
      do: async (prepareName) => {
        prepareNameCalls += 1;
        await prepareName();
        return undefined;
      },
    }),
  );
  const call = send(controller, 1, '{"kind":"call","call":1,"operation":"do"}');
  expect(await call).toBe('{"kind":"need_name"}');
  controller.close();
  await expect(controller.failed).rejects.toMatchObject({ code: "host_unavailable" });
  expect(() => controller.acceptFrame(2, '{"kind":"name","call":1,"name":"late"}')).toThrow(
    new WorkflowRuntimeError("host_unavailable"),
  );
  expect(prepareNameCalls).toBe(1);
});

test("duplicate exchange, raw-payload mismatch, and malformed outcomes latch infrastructure", async () => {
  const duplicate = createWorkflowHttpController();
  duplicate.run(driver());
  void duplicate.exchange(1, '{"kind":"call","call":1,"operation":"do"}');
  await expect(
    duplicate.exchange(1, '{"kind":"call","call":1,"operation":"do"}'),
  ).rejects.toMatchObject({
    code: "invalid_runtime_input",
  });

  const mismatch = createWorkflowHttpController();
  mismatch.run(driver());
  void mismatch.exchange(1, '{"kind":"call","call":1,"operation":"do"}');
  expect(() => mismatch.acceptFrame(1, '{"kind":"call","call":1,"operation":"sleep"}')).toThrow(
    new WorkflowRuntimeError("invalid_runtime_input"),
  );

  const malformed = createWorkflowHttpController();
  malformed.run(driver());
  expect(() => malformed.outcome('{"kind":"complete","present":false,"extra":1}')).toThrow(
    new WorkflowRuntimeError("invalid_runtime_input"),
  );
});

test("ordinary call identifiers are positive safe integers while provenance remains bounded", async () => {
  const controller = createWorkflowHttpController();
  controller.run(
    driver({
      do: async (name) => {
        await name();
        return undefined;
      },
    }),
  );
  for (let call = 1; call <= 1_025; call += 1) {
    expect(
      await send(controller, call * 2 - 1, `{"kind":"call","call":${call},"operation":"do"}`),
    ).toBe('{"kind":"need_name"}');
    expect(
      await send(controller, call * 2, `{"kind":"name","call":${call},"name":"same-memo"}`),
    ).toBe('{"kind":"settled","present":false}');
  }
  controller.close();
});

test.each(["pending", "effect"] as const)(
  "transport close during %s is infrastructure, not an effect failure",
  async (stage) => {
    const controller = createWorkflowHttpController();
    let rejected: unknown;
    controller.run(
      driver({
        do: async (name, pending) => {
          try {
            await name();
            return await (await pending()).effect();
          } catch (error) {
            rejected = error;
            throw error;
          }
        },
      }),
    );
    expect(await send(controller, 1, '{"kind":"call","call":1,"operation":"do"}')).toBe(
      '{"kind":"need_name"}',
    );
    expect(await send(controller, 2, '{"kind":"name","call":1,"name":"name"}')).toBe(
      '{"kind":"need_pending"}',
    );
    if (stage === "effect") {
      expect(await send(controller, 3, '{"kind":"pending","call":1,"retryDelaysSeconds":[]}')).toBe(
        '{"kind":"invoke_effect"}',
      );
    }
    controller.close();
    await settle();
    expect(rejected).toBeInstanceOf(WorkflowRuntimeError);
    expect(rejected).toMatchObject({ code: "host_unavailable" });
    expect(() => controller.outcome('{"kind":"failed","reason":"run_threw"}')).toThrow(
      WorkflowRuntimeError,
    );
  },
);

test("oversized UTF-8 frames are rejected before they can reserve a request", async () => {
  const controller = createWorkflowHttpController();
  controller.run(driver());
  const payload = `{"kind":"call","call":1,"operation":"do","x":"${"é".repeat(2 * 1024 * 1024)}"}`;
  await expect(controller.exchange(1, payload)).rejects.toMatchObject({
    code: "invalid_runtime_input",
  });
});
