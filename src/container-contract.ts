/** Single replaceable public vocabulary for the unpublished portable candidate. */
export const CONTAINER_CONTRACT = Object.freeze({
  resource: "Container",
  formUrl: "https://edge.forms.takoform.com/forms/Container/0.1.0/",
  binding: "module-worker.container",
  bindingFragment: "#worker-binding",
  interface: "container.http",
  workerVersionUrl: "https://edge.forms.takoform.com/forms/WorkerVersion/0.6.0/",
  workerDeploymentUrl: "https://edge.forms.takoform.com/forms/WorkerDeployment/0.5.0/",
  fields: Object.freeze({
    image: "image",
    httpPort: "httpPort",
    healthPath: "healthPath",
    workloadRevision: "workloadRevision",
    environment: "environment",
    requiredSensitiveVars: "requiredSensitiveVars",
    outboundInternet: "outboundInternet",
    containerBindings: "containerBindings",
    name: "name",
    resource: "resource",
    resourceUid: "resourceUid",
    ready: "ready",
    servingGeneration: "servingGeneration",
    imageDigest: "imageDigest",
  }),
  errorName: "ContainerError",
  errors: Object.freeze({
    invalidSpec: "invalid_spec",
    dependencyConflict: "dependency_conflict",
    invalidRequest: "invalid_request",
    backendUnavailable: "backend_unavailable",
    requestAborted: "request_aborted",
    requestTooLarge: "request_too_large",
    responseAborted: "response_aborted",
    responseTooLarge: "response_too_large",
  }),
  methods: Object.freeze(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  limits: Object.freeze({
    bodyBytes: 104_857_600,
    headers: 64,
    headerBytes: 16_384,
    pathQuery: 8192,
    retirementMs: 30_000,
  }),
  /** Native conformance and released publisher admission are still pending. */
  supported: false,
} as const);

/** Host-private claim types carry no credential or provider target. */
/** Canonical retained Container F2 Form identity shared by App and owner compiler. */
export const V2_CONTAINER_F2_FORM =
  "https://edge.forms.takoform.com/forms/Container/0.2.0/" as const;

export interface ContainerBindingClaim {
  readonly principal: string;
  readonly space: string;
  readonly workerVersionUid: string;
  readonly operationId: string;
  readonly bindingName: string;
  readonly targetUid: string;
}
