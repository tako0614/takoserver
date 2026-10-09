import { expect, test } from "bun:test";
import { WORKER_CRON_TRIGGER_FORM_URL } from "../src/takoform-v2/forms/worker-cron-trigger.ts";
import * as sdk from "../src/takoform-v2/index.ts";
import {
  createWorkerCronTriggerAdmissionReader,
  createWorkerCronTriggerForm,
} from "../src/takoform-v2/worker-cron-trigger-backend.ts";

test("v2 extension exports the existing Cron Form and admission reader", () => {
  expect(Reflect.get(sdk, "WORKER_CRON_TRIGGER_FORM_URL")).toBe(WORKER_CRON_TRIGGER_FORM_URL);
  expect(Reflect.get(sdk, "createWorkerCronTriggerForm")).toBe(createWorkerCronTriggerForm);
  expect(Reflect.get(sdk, "createWorkerCronTriggerAdmissionReader")).toBe(
    createWorkerCronTriggerAdmissionReader,
  );
});
