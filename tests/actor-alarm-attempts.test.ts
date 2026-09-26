import { expect, test } from "bun:test";
import { createActorAlarmAttemptRegistry } from "../src/selfhost-actor-native-process.ts";

const selection = (leaseId: string) => ({
  variantKey: "version-b",
  generationKey: "generation",
  epoch: "epoch",
  leaseId,
});

test("a lost grant response can be abandoned by the known attempt, exactly once", async () => {
  const released: string[] = [];
  const attempts = createActorAlarmAttemptRegistry((leaseId) => released.push(leaseId));
  const deadlineAt = Date.now() + 5_000;
  const grant = await attempts.begin("actor", "attempt-lost", deadlineAt, async () =>
    selection("lease-lost"),
  );
  expect(grant).toEqual(selection("lease-lost"));
  // The owner never saw grant's response, but knows its own attempt UUID.
  attempts.complete("attempt-lost", deadlineAt);
  attempts.complete("attempt-lost", deadlineAt);
  expect(released).toEqual(["lease-lost"]);
});

test("completion before a late grant fences it and releases a racing lease", async () => {
  const released: string[] = [];
  const attempts = createActorAlarmAttemptRegistry((leaseId) => released.push(leaseId));
  const deadlineAt = Date.now() + 5_000;
  let releaseGrant!: () => void;
  let grantStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    grantStarted = resolve;
  });
  const withheld = new Promise<void>((resolve) => {
    releaseGrant = resolve;
  });
  const grant = attempts.begin("actor", "attempt-race", deadlineAt, async () => {
    grantStarted();
    await withheld;
    return selection("lease-race");
  });
  await started;
  attempts.complete("attempt-race", deadlineAt);
  releaseGrant();
  expect(await grant).toBeNull();
  await Bun.sleep(0);
  expect(released).toEqual(["lease-race"]);
});

test("deadline and pre-arrival abandonment never grant a late attempt", async () => {
  const released: string[] = [];
  const attempts = createActorAlarmAttemptRegistry((leaseId) => released.push(leaseId));
  const deadlineAt = Date.now() + 100;
  attempts.complete("attempt-prearrival", deadlineAt);
  let called = false;
  expect(
    await attempts.begin("actor", "attempt-prearrival", deadlineAt, async () => {
      called = true;
      return selection("lease-unexpected");
    }),
  ).toBeNull();
  expect(called).toBe(false);
  expect(
    await attempts.begin("actor", "attempt-expired", Date.now() - 1, async () => {
      called = true;
      return selection("lease-unexpected");
    }),
  ).toBeNull();
  expect(called).toBe(false);
  expect(released).toEqual([]);
});

test("a slow authority read cannot grant after the absolute deadline", async () => {
  const released: string[] = [];
  const attempts = createActorAlarmAttemptRegistry((leaseId) => released.push(leaseId));
  let finishRead!: () => void;
  const reading = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  const grant = attempts.begin("actor", "attempt-deadline", Date.now() + 20, async () => {
    await reading;
    return selection("lease-after-deadline");
  });
  expect(await grant).toBeNull();
  finishRead();
  await Bun.sleep(0);
  expect(released).toEqual(["lease-after-deadline"]);
});
