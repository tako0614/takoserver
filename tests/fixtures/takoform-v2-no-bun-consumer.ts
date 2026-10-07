import type {
  createInternalV2ModuleWorkerForm,
  inspectV2WorkerCodeVersionEligibility,
  V2WorkerModuleInspector,
  V2WorkerRetirementReader,
  V2WorkerServingReader,
} from "../../src/takoform-v2/index.ts";

declare const inspector: V2WorkerModuleInspector;
declare const input: Parameters<typeof inspectV2WorkerCodeVersionEligibility>[0];
declare const moduleWorkerOptions: Parameters<typeof createInternalV2ModuleWorkerForm>[0];
declare const retirement: V2WorkerRetirementReader;
declare const serving: V2WorkerServingReader;

void inspector;
void input;
void moduleWorkerOptions;
void retirement;
void serving;
