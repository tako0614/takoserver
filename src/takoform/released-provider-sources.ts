import edgeKvBinding from "../../vendor/takoform/v2.1.1/bindings/module-worker.edge-kv/definition.json" with {
  type: "json",
};
import objectBucketBinding from "../../vendor/takoform/v2.1.1/bindings/module-worker.object-bucket/definition.json" with {
  type: "json",
};
import queueProducerBinding from "../../vendor/takoform/v2.1.1/bindings/module-worker.queue-producer/definition.json" with {
  type: "json",
};
import serviceBinding from "../../vendor/takoform/v2.1.1/bindings/module-worker.service/definition.json" with {
  type: "json",
};
import sqliteBinding from "../../vendor/takoform/v2.1.1/bindings/module-worker.sqlite/definition.json" with {
  type: "json",
};
import atLeastOnceQueueDefinition from "../../vendor/takoform/v2.1.1/forms/at-least-once-queue/definition.json" with {
  type: "json",
};
import atLeastOnceQueuePackage from "../../vendor/takoform/v2.1.1/forms/at-least-once-queue/package-index.json" with {
  type: "json",
};
import edgeKvDefinition from "../../vendor/takoform/v2.1.1/forms/edge-kv-namespace/definition.json" with {
  type: "json",
};
import edgeKvPackage from "../../vendor/takoform/v2.1.1/forms/edge-kv-namespace/package-index.json" with {
  type: "json",
};
import moduleWorkerDefinition from "../../vendor/takoform/v2.1.1/forms/module-worker/definition.json" with {
  type: "json",
};
import moduleWorkerPackage from "../../vendor/takoform/v2.1.1/forms/module-worker/package-index.json" with {
  type: "json",
};
import objectBucketDefinition from "../../vendor/takoform/v2.1.1/forms/object-bucket/definition.json" with {
  type: "json",
};
import objectBucketPackage from "../../vendor/takoform/v2.1.1/forms/object-bucket/package-index.json" with {
  type: "json",
};
import queueConsumerDefinition from "../../vendor/takoform/v2.1.1/forms/queue-consumer/definition.json" with {
  type: "json",
};
import queueConsumerPackage from "../../vendor/takoform/v2.1.1/forms/queue-consumer/package-index.json" with {
  type: "json",
};
import sqliteDatabaseDefinition from "../../vendor/takoform/v2.1.1/forms/sqlite-database/definition.json" with {
  type: "json",
};
import sqliteDatabasePackage from "../../vendor/takoform/v2.1.1/forms/sqlite-database/package-index.json" with {
  type: "json",
};
import sqliteMigrationApplicationDefinition from "../../vendor/takoform/v2.1.1/forms/sqlite-migration-application/definition.json" with {
  type: "json",
};
import sqliteMigrationApplicationPackage from "../../vendor/takoform/v2.1.1/forms/sqlite-migration-application/package-index.json" with {
  type: "json",
};
import sqliteMigrationSetDefinition from "../../vendor/takoform/v2.1.1/forms/sqlite-migration-set/definition.json" with {
  type: "json",
};
import sqliteMigrationSetPackage from "../../vendor/takoform/v2.1.1/forms/sqlite-migration-set/package-index.json" with {
  type: "json",
};
import staticAssetBundleDefinition from "../../vendor/takoform/v2.1.1/forms/static-asset-bundle/definition.json" with {
  type: "json",
};
import staticAssetBundlePackage from "../../vendor/takoform/v2.1.1/forms/static-asset-bundle/package-index.json" with {
  type: "json",
};
import workerBundleDefinition from "../../vendor/takoform/v2.1.1/forms/worker-bundle/definition.json" with {
  type: "json",
};
import workerBundlePackage from "../../vendor/takoform/v2.1.1/forms/worker-bundle/package-index.json" with {
  type: "json",
};
import workerCronTriggerDefinition from "../../vendor/takoform/v2.1.1/forms/worker-cron-trigger/definition.json" with {
  type: "json",
};
import workerCronTriggerPackage from "../../vendor/takoform/v2.1.1/forms/worker-cron-trigger/package-index.json" with {
  type: "json",
};
import workerCustomDomainDefinition from "../../vendor/takoform/v2.1.1/forms/worker-custom-domain/definition.json" with {
  type: "json",
};
import workerCustomDomainPackage from "../../vendor/takoform/v2.1.1/forms/worker-custom-domain/package-index.json" with {
  type: "json",
};
import workerDeploymentDefinition from "../../vendor/takoform/v2.1.1/forms/worker-deployment/definition.json" with {
  type: "json",
};
import workerDeploymentPackage from "../../vendor/takoform/v2.1.1/forms/worker-deployment/package-index.json" with {
  type: "json",
};
import workerEndpointDefinition from "../../vendor/takoform/v2.1.1/forms/worker-endpoint/definition.json" with {
  type: "json",
};
import workerEndpointPackage from "../../vendor/takoform/v2.1.1/forms/worker-endpoint/package-index.json" with {
  type: "json",
};
import workerVersionDefinition from "../../vendor/takoform/v2.1.1/forms/worker-version/definition.json" with {
  type: "json",
};
import workerVersionPackage from "../../vendor/takoform/v2.1.1/forms/worker-version/package-index.json" with {
  type: "json",
};

export const RELEASED_FORM_SOURCES = [
  { definition: moduleWorkerDefinition, packageIndex: moduleWorkerPackage },
  { definition: workerBundleDefinition, packageIndex: workerBundlePackage },
  { definition: staticAssetBundleDefinition, packageIndex: staticAssetBundlePackage },
  { definition: workerVersionDefinition, packageIndex: workerVersionPackage },
  { definition: workerDeploymentDefinition, packageIndex: workerDeploymentPackage },
  { definition: workerCustomDomainDefinition, packageIndex: workerCustomDomainPackage },
  { definition: workerEndpointDefinition, packageIndex: workerEndpointPackage },
  { definition: workerCronTriggerDefinition, packageIndex: workerCronTriggerPackage },
  { definition: edgeKvDefinition, packageIndex: edgeKvPackage },
  { definition: objectBucketDefinition, packageIndex: objectBucketPackage },
  { definition: sqliteDatabaseDefinition, packageIndex: sqliteDatabasePackage },
  { definition: sqliteMigrationSetDefinition, packageIndex: sqliteMigrationSetPackage },
  {
    definition: sqliteMigrationApplicationDefinition,
    packageIndex: sqliteMigrationApplicationPackage,
  },
  { definition: atLeastOnceQueueDefinition, packageIndex: atLeastOnceQueuePackage },
  { definition: queueConsumerDefinition, packageIndex: queueConsumerPackage },
] as const;

export const RELEASED_BINDING_SOURCES = [
  edgeKvBinding,
  objectBucketBinding,
  sqliteBinding,
  queueProducerBinding,
  serviceBinding,
] as const;
