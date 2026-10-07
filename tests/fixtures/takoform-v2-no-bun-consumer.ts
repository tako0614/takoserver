import type {
  inspectV2WorkerCodeVersionEligibility,
  V2WorkerModuleInspector,
} from "../../src/takoform-v2/index.ts";

declare const inspector: V2WorkerModuleInspector;
declare const input: Parameters<typeof inspectV2WorkerCodeVersionEligibility>[0];

void inspector;
void input;
