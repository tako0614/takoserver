import type {
  createEdgeKVNamespaceForm,
  createInternalV2ModuleWorkerForm,
  createObjectBucketForm,
  createObjectBucketWorkerBindingAuthority,
  createV2EdgeKvNativeCustody,
  inspectV2WorkerCodeVersionEligibility,
  ObjectBucketStore,
  V2WorkerModuleInspector,
  V2WorkerRetirementReader,
  V2WorkerServingReader,
} from "../../src/takoform-v2/index.ts";

declare const inspector: V2WorkerModuleInspector;
declare const input: Parameters<typeof inspectV2WorkerCodeVersionEligibility>[0];
declare const moduleWorkerOptions: Parameters<typeof createInternalV2ModuleWorkerForm>[0];
declare const retirement: V2WorkerRetirementReader;
declare const serving: V2WorkerServingReader;
declare const kvFormOptions: Parameters<typeof createEdgeKVNamespaceForm>[0];
declare const kvCustody: ReturnType<typeof createV2EdgeKvNativeCustody>;
declare const kvDeleteGrant: Awaited<ReturnType<typeof kvCustody.grantDelete>>;
declare const bucketStore: ObjectBucketStore;
declare const bucketFormOptions: Parameters<typeof createObjectBucketForm>[0];
declare const bucketAuthorityOptions: Parameters<
  typeof createObjectBucketWorkerBindingAuthority
>[0];

void inspector;
void input;
void moduleWorkerOptions;
void retirement;
void serving;
void kvFormOptions;
void kvCustody;
void kvDeleteGrant;
void bucketStore;
void bucketFormOptions;
void bucketAuthorityOptions;
