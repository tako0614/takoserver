import { expect, test } from "bun:test";
import * as root from "@takoserver/core";
import type { WorkerCronSchedule as ExtensionWorkerCronSchedule } from "@takoserver/core/provider-extension";
import * as providerExtension from "@takoserver/core/provider-extension";
import type { WorkerCronSchedule as ExpectedWorkerCronSchedule } from "../src/cron.ts";
import { parseWorkerCron as expectedParseWorkerCron } from "../src/cron.ts";

test("provider-extension exposes the canonical portable Worker Cron matcher", () => {
  expect(providerExtension.parseWorkerCron).toBe(expectedParseWorkerCron);
  expect("parseWorkerCron" in providerExtension).toBe(true);
  expect("parseWorkerCron" in root).toBe(false);
  expect("parseSelfhostCron" in providerExtension).toBe(false);

  const schedule = providerExtension.parseWorkerCron("0 0 * * 0");
  expect(schedule?.nextAfter(Date.UTC(2026, 8, 2, 12, 0, 0))).toBe(Date.UTC(2026, 8, 6, 0, 0, 0));
});

test("provider-extension WorkerCronSchedule type imports resolve", () => {
  const extensionSchedule: ExtensionWorkerCronSchedule | null =
    providerExtension.parseWorkerCron("* * * * *");
  const expectedSchedule: ExpectedWorkerCronSchedule | null = extensionSchedule;
  expect(expectedSchedule?.matches(Date.UTC(2026, 8, 2, 12, 34, 56))).toBe(true);
});
