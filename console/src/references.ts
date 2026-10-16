import type { ResourceSummary } from "./api.ts";

export interface SpecReference {
  /**
   * Where the spec names it, as the spec reads: `bundle`,
   * `versions[0].workerVersion`, or for a Binding its list and the name the
   * Worker reaches it by, `sqliteBindings · DB`.
   */
  readonly path: string;
  readonly uid: string;
}

/** Spec fields that hold the person's own data, never references. */
const OPAQUE_SPEC_FIELDS = new Set(["vars"]);

/** One step into a spec: a key, or a Binding's own name. */
type Step = { readonly key: string } | { readonly name: string };

function pathText(steps: readonly Step[]): string {
  return steps
    .map((step, index) =>
      "name" in step
        ? ` · ${step.name}`
        : index === 0 || step.key.startsWith("[")
          ? step.key
          : `.${step.key}`,
    )
    .join("");
}

/**
 * Every Resource a spec names, in the order it names them. A v2 reference is
 * an object holding exactly one `resourceUid`; a Binding entry is labelled by
 * its own `name`, which is how the Worker reaches it, and any other list
 * entry by its index as the spec below shows it.
 */
export function specReferences(spec: unknown): SpecReference[] {
  const found: SpecReference[] = [];
  const walk = (value: unknown, path: readonly Step[]): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        const name =
          entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined;
        walk(
          entry,
          typeof name === "string" ? [...path, { name }] : [...path, { key: `[${index}]` }],
        );
      });
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === "resourceUid" && typeof record.resourceUid === "string") {
      // A Binding's `resource` key adds nothing its name has not said.
      const last = path.at(-1);
      const shown =
        last && "key" in last && last.key === "resource" && path.length > 1
          ? path.slice(0, -1)
          : path;
      found.push({ path: pathText(shown), uid: record.resourceUid });
      return;
    }
    for (const key of keys) {
      if (path.length === 0 && OPAQUE_SPEC_FIELDS.has(key)) continue;
      walk(record[key], [...path, { key }]);
    }
  };
  walk(spec, []);
  return found;
}

/** The https URL a Resource reports for itself, such as a WorkerEndpoint's. */
export function publishedUrl(output: unknown): string | null {
  const url = output && typeof output === "object" ? (output as { url?: unknown }).url : null;
  if (typeof url !== "string") return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export interface ServedWorker {
  readonly worker: ResourceSummary;
  /** The WorkerDeployment that names this Worker, if the page holds one. */
  readonly deployment: ResourceSummary | undefined;
  /** The WorkerEndpoints that name this Worker and report an https address. */
  readonly endpoints: readonly ResourceSummary[];
}

const FORM_KIND = (kind: string) => new RegExp(`/forms/${kind}/[^/]+/$`, "u");
export const MODULE_WORKER = FORM_KIND("ModuleWorker");
const WORKER_DEPLOYMENT = FORM_KIND("WorkerDeployment");
export const WORKER_ENDPOINT = FORM_KIND("WorkerEndpoint");
export const WORKER_CRON_TRIGGER = FORM_KIND("WorkerCronTrigger");

/**
 * Each ModuleWorker among these Resources with what serves it: the
 * Deployment that names it as its worker and the addresses of the Endpoints
 * that do. Only the Resources given are searched.
 */
export function servedWorkers(resources: readonly ResourceSummary[]): readonly ServedWorker[] {
  return resources
    .filter((resource) => MODULE_WORKER.test(resource.form))
    .map((worker) => {
      const naming = resources.filter((resource) =>
        specReferences(resource.spec).some(
          (reference) => reference.uid === worker.uid && reference.path === "worker",
        ),
      );
      return {
        worker,
        deployment: naming.find((resource) => WORKER_DEPLOYMENT.test(resource.form)),
        endpoints: naming.filter(
          (resource) => WORKER_ENDPOINT.test(resource.form) && publishedUrl(resource.output),
        ),
      };
    });
}
