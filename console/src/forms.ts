import { tr } from "./i18n.ts";

const EDGE = "https://edge.forms.takoform.com/forms";

/**
 * The Forms a Takoserver Host can compose, grouped as the public site groups
 * them. A running Host serves only those its configuration composes, so the
 * Console asks it about each one before offering it; this list is what to ask
 * about, not a claim of support.
 */
export const KNOWN_FORM_GROUPS = [
  {
    label: () => tr("成果物", "Artifacts"),
    forms: [
      `${EDGE}/WorkerBundle/0.2.0/`,
      `${EDGE}/StaticAssetBundle/0.2.0/`,
      `${EDGE}/SQLiteMigrationSet/0.2.0/`,
    ],
  },
  {
    label: () => tr("Workerと公開", "Workers and HTTPS"),
    forms: [
      `${EDGE}/ModuleWorker/0.3.0/`,
      `${EDGE}/WorkerVersion/0.5.0/`,
      `${EDGE}/WorkerDeployment/0.4.0/`,
      `${EDGE}/WorkerCronTrigger/0.3.0/`,
      `${EDGE}/WorkerEndpoint/0.3.0/`,
    ],
  },
  {
    label: () => tr("データ", "Data"),
    forms: [
      `${EDGE}/SQLiteDatabase/0.2.0/`,
      `${EDGE}/SQLiteMigrationApplication/0.2.0/`,
      `${EDGE}/EdgeKVNamespace/0.2.0/`,
      `${EDGE}/ObjectBucket/0.2.0/`,
    ],
  },
  {
    label: () => tr("キュー・Actor・Workflow", "Queues, actors and workflows"),
    forms: [
      `${EDGE}/AtLeastOnceQueue/0.2.0/`,
      `${EDGE}/QueueConsumer/0.3.0/`,
      `${EDGE}/ActorNamespace/0.3.0/`,
      `${EDGE}/DurableWorkflow/0.3.0/`,
    ],
  },
] as const;

/** "ModuleWorker 0.3.0" for a `…/forms/ModuleWorker/0.3.0/` URL; the URL itself otherwise. */
export function formLabel(form: string): string {
  const match = /\/forms\/([^/]+)\/([^/]+)\/$/u.exec(form);
  return match ? `${match[1]} ${match[2]}` : form;
}

/**
 * A Form as people read it in a list: "WorkerBundle 0.2.0". Everything before
 * `/forms/` is kept verbatim unless it is exactly the edge Forms host, so two
 * different Form URLs (another host, a path prefix, a different spelling)
 * never read the same. The exact URL stays the title and the detail.
 */
export function formName(form: string): string {
  const match = /^https:\/\/(.+)\/forms\/([^/]+)\/([^/]+)\/$/u.exec(form);
  if (!match) return form;
  const [, where, kind, version] = match;
  return where === "edge.forms.takoform.com"
    ? `${kind} ${version}`
    : `${where} · ${kind} ${version}`;
}
