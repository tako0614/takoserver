import type { ResourceSummary } from "../api.ts";
import { ApiError } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { valueAt, WORKER_DEPLOYMENT, WORKER_VERSION } from "../form-specs.ts";
import { formLabel } from "../forms.ts";
import { tr } from "../i18n.ts";
import { resource } from "../reactive.ts";
import {
  MODULE_WORKER,
  publishedUrl,
  type SpecReference,
  specReferences,
  WORKER_CRON_TRIGGER,
  WORKER_ENDPOINT,
} from "../references.ts";
import { findReferrers, REFERRER_PAGES } from "../referrers.ts";
import { health, phaseLabel, unrecordedDeployment } from "../resource-state.ts";
import { linkProps, resourcePath, route } from "../router.ts";
import { api, currentOrganization } from "../state.ts";
import { badge, card, copyable, empty, ICON, icon, jsonBlock, whenReady } from "../ui.ts";
import { createResource, deleteResource, updateResource } from "./create-resource.ts";

export { publishedUrl, type SpecReference, specReferences } from "../references.ts";
export { findReferrers, type Referrer } from "../referrers.ts";

/** The v2 address is the durable UID, never a reconstructed kind/name tuple. */
export function resourceDetailPage(organizationId: string, uid: string): Child {
  // Made once per read of the Resource: a re-render does not look the
  // Deployment up again, and Reload reads both afresh.
  let worker: { readonly for: ResourceSummary; readonly action: WorkerAction } | undefined;
  const workerAction = (found: ResourceSummary): WorkerAction => {
    if (worker?.for !== found)
      worker = {
        for: found,
        action:
          found.form === WORKER_VERSION
            ? { toolbar: serveVersionAction(organizationId, found), notice: null }
            : MODULE_WORKER.test(found.form)
              ? { toolbar: null, notice: recordDeploymentNotice(organizationId, found) }
              : { toolbar: null, notice: null },
      };
    return worker.action;
  };
  const isCurrent = (): boolean =>
    currentOrganization()?.id === organizationId &&
    route().segments.length === 2 &&
    route().segments[0] === "resources" &&
    route().segments[1] === uid;
  const page = resource(async () => {
    try {
      const found = await api.resource(organizationId, uid);
      return isCurrent() ? found : null;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 410)) return null;
      throw error;
    }
  });

  return h(
    "div",
    { class: "page" },
    live(() =>
      whenReady(
        page.get(),
        (found) => {
          if (!isCurrent()) return null;
          return found
            ? body(found, organizationId, page.reload, workerAction(found))
            : card(
                null,
                empty(
                  tr("リソースがありません", "No such resource"),
                  tr(
                    "この組織に該当するUIDはありません。",
                    "There is no Resource with this UID in this organization.",
                  ),
                  h(
                    "a",
                    { class: "btn", ...linkProps("/resources") },
                    tr("リソース一覧へ戻る", "Back to resources"),
                  ),
                ),
              );
        },
        { retry: page.reload },
      ),
    ),
  );
}

/** What a Worker's page adds: a step beside Reload, or a notice under the heading. */
interface WorkerAction {
  readonly toolbar: Child;
  readonly notice: Child;
}

function body(
  found: ResourceSummary,
  organizationId: string,
  reload: () => void,
  action: WorkerAction,
): Child {
  const state = health(found);
  const url = publishedUrl(found.output);
  const references = specReferences(found.spec);
  return h(
    "div",
    { style: { display: "grid", gap: "18px" } },
    h(
      "div",
      { class: "head" },
      h(
        "div",
        { class: "head__text" },
        h(
          "div",
          { class: "dim" },
          h("a", { ...linkProps("/resources") }, tr("リソース", "Resources")),
        ),
        h(
          "h1",
          null,
          // The name is the page title; .mono alone would shrink it to body size.
          h(
            "span",
            { class: "mono", style: { fontSize: "inherit", overflowWrap: "anywhere" } },
            found.name,
          ),
          text(" "),
          badge(phaseLabel(state.phase), state.tone, true),
        ),
        h(
          "p",
          { class: "published" },
          httpsUrl(found.form)
            ? h(
                "a",
                { href: found.form, target: "_blank", rel: "noopener noreferrer" },
                formLabel(found.form),
                h("span", { "aria-hidden": "true" }, " ↗"),
                h(
                  "span",
                  { class: "visually-hidden" },
                  tr(
                    "（公開仕様、新しいタブで開きます）",
                    " (published contract, opens in a new tab)",
                  ),
                ),
              )
            : formLabel(found.form),
        ),
        url
          ? h(
              "p",
              { class: "published" },
              h(
                "a",
                { href: url, target: "_blank", rel: "noopener noreferrer" },
                url,
                h("span", { "aria-hidden": "true" }, " ↗"),
                newTab(),
              ),
            )
          : null,
      ),
      h(
        "div",
        { class: "toolbar" },
        action.toolbar,
        h(
          "button",
          { class: "btn", type: "button", onClick: reload },
          icon(ICON.refresh, 14),
          text(tr("再読み込み", "Reload")),
        ),
        h(
          "button",
          { class: "btn", type: "button", onClick: () => updateResource(organizationId, found) },
          tr("更新", "Update"),
        ),
        h(
          "button",
          {
            class: "btn btn--danger",
            type: "button",
            onClick: () => deleteResource(organizationId, found),
          },
          tr("削除", "Delete"),
        ),
      ),
    ),
    state.stale
      ? h(
          "div",
          { class: "notice notice--warn" },
          tr(
            "最新の宣言はまだ観測されていません。",
            "The latest declaration has not yet been observed.",
          ),
        )
      : null,
    action.notice ?? (state.phase === "NotReady" ? notReadyNotice() : null),
    references.length > 0 ? referencesCard(organizationId, references) : null,
    referrersCard(organizationId, found.uid),
    card(
      tr("識別情報", "Identity"),
      h(
        "div",
        { class: "card__body rows" },
        field("UID", copyable(found.uid)),
        field(tr("スペース", "Space"), found.space),
        field("Form", copyable(found.form)),
        field(tr("世代", "Generation"), String(found.generation)),
        field(tr("観測世代", "Observed generation"), String(found.observedGeneration)),
        field(
          tr("Hostの処理", "Host work"),
          h(
            "span",
            null,
            hostWork(found.phase),
            h("span", { class: "mono dim" }, ` · ${found.phase}`),
          ),
        ),
        field(
          tr("最終操作", "Last operation"),
          found.lastOperation
            ? h(
                "a",
                { ...linkProps(`/resources?operation=${encodeURIComponent(found.lastOperation)}`) },
                found.lastOperation,
              )
            : "—",
        ),
      ),
    ),
    card(tr("宣言した設定", "Declared spec"), jsonBlock(found.spec)),
    card(
      tr("観測状態", "Observed state"),
      found.observedAt
        ? jsonBlock(found.observed)
        : empty(
            tr("まだ観測されていません", "Nothing observed"),
            tr(
              "Hostはまだこの世代を観測していません。",
              "The Host has not observed this generation yet.",
            ),
          ),
    ),
    card(tr("出力", "Output"), jsonBlock(found.output)),
  );
}

/** The Deployment serving a ModuleWorker, from the first pages of Deployments. */
async function deploymentOf(
  organizationId: string,
  workerUid: string,
): Promise<ResourceSummary | null> {
  let cursor: string | null = null;
  for (let page = 0; page < REFERRER_PAGES; page += 1) {
    const read = await api.resources(organizationId, {
      form: WORKER_DEPLOYMENT,
      ...(cursor ? { cursor } : {}),
    });
    const found = read.resources.find(
      (candidate) => valueAt(candidate.spec, ["worker", "resourceUid"]) === workerUid,
    );
    if (found) return found;
    cursor = read.cursor;
    if (cursor === null) return null;
  }
  return null;
}

function notReadyNotice(): Child {
  return h(
    "div",
    { class: "notice notice--warn" },
    tr("最新の観測でReadyではありません。", "The latest observation reports not ready."),
  );
}

/**
 * On a ModuleWorker's page: when its Deployment serves it but the Worker has
 * not recorded that Deployment, say so, and offer the same-spec update that
 * records it only where that update can finish. The Host refuses it while
 * anything naming the Worker is in progress, and it cannot finish until every
 * WorkerEndpoint naming the Worker is published; until then it would hold the
 * Worker busy, and nothing could name it. Nothing is sent until the person
 * accepts the update.
 */
function recordDeploymentNotice(organizationId: string, worker: ResourceSummary): Child {
  const phase = health(worker).phase;
  if (phase !== "Ready" && phase !== "NotReady") return null;
  const plain = (): Child => (phase === "NotReady" ? notReadyNotice() : null);
  const graph = resource(async () => {
    const deployment = await deploymentOf(organizationId, worker.uid);
    if (!unrecordedDeployment(worker, deployment)) return null;
    return { deployment, naming: await findReferrers(organizationId, worker.uid) };
  });
  const links = (resources: readonly ResourceSummary[]): Child[] =>
    resources.flatMap((entry, index) => [
      index === 0 ? null : tr("、", ", "),
      h("a", { ...linkProps(resourcePath(entry.uid)) }, entry.name),
    ]);
  return live(() => {
    const state = graph.get();
    const found = state.state === "ready" ? state.value : null;
    if (!found) return plain();
    const { deployment, naming } = found;
    const referrers = naming.referrers.map(({ resource }) => resource);
    const inProgress = referrers.filter((entry) =>
      ["Pending", "Deleting"].includes(health(entry).phase),
    );
    // A WorkerCronTrigger's create or update cannot settle while its Worker
    // has not recorded the Deployment, so it is not something to wait for. Its
    // delete does not read the Worker, and finishes.
    const stuck = inProgress.filter(
      (entry) => WORKER_CRON_TRIGGER.test(entry.form) && health(entry).phase === "Pending",
    );
    const busy = inProgress.filter((entry) => !stuck.includes(entry));
    const unpublished = referrers.filter(
      (entry) =>
        WORKER_ENDPOINT.test(entry.form) &&
        !inProgress.includes(entry) &&
        !(health(entry).phase === "Ready" && entry.observed.tlsReady === true),
    );
    const next: Child =
      stuck.length > 0
        ? h(
            "span",
            null,
            ...links(stuck),
            tr("は、このWorkerが", " cannot finish until this Worker records "),
            ...links([deployment]),
            tr(
              "を記録するまで完了できません。一方、その処理中はHostがこの更新を受け付けません。コンソールからは解消できず、Host側の修正が必要です。",
              stuck.length === 1
                ? ", and the Host refuses that update while it is in progress. Neither can be resolved from the console; it needs a fix on the Host."
                : ", and the Host refuses that update while they are in progress. Neither can be resolved from the console; it needs a fix on the Host.",
            ),
          )
        : !naming.complete
          ? h(
              "span",
              null,
              tr(
                "このWorkerを参照するリソースをすべては確認できなかったため、ここでは更新を提示しません。",
                "Not everything that names this Worker could be checked here, so the update is not offered.",
              ),
            )
          : busy.length > 0
            ? h(
                "span",
                null,
                ...links(busy),
                tr(
                  "の処理が終わるまで待ってください。Workerを参照するリソースの処理中は、Hostはこの更新を受け付けません。",
                  busy.length === 1
                    ? " is in progress. Wait until it finishes: the Host refuses this update while anything that names the Worker is in progress."
                    : " are in progress. Wait until they finish: the Host refuses this update while anything that names the Worker is in progress.",
                ),
              )
            : unpublished.length > 0
              ? h(
                  "span",
                  null,
                  tr("先に", "Re-apply or delete "),
                  ...links(unpublished),
                  tr(
                    "を再適用するか削除してください。稼働中になるまでは、この更新を送っても完了せず、その間Workerが処理中のままになります。",
                    " first. Until it is Ready, this update cannot finish, and it would hold the Worker busy meanwhile.",
                  ),
                )
              : h(
                  "button",
                  {
                    class: "btn",
                    type: "button",
                    onClick: () =>
                      updateResource(organizationId, worker, {
                        spec: worker.spec,
                        note: tr(
                          `${worker.name}を同じ設定のまま更新し、稼働中の配信${deployment.name}を記録します。内容を確認して受け付けてください。`,
                          `This updates ${worker.name} with the same spec, so that it records ${deployment.name}. Check it, then accept.`,
                        ),
                      }),
                  },
                  tr("配信を記録する", "Record the Deployment"),
                );
    return h(
      "div",
      {
        class: "notice notice--warn",
        style: { display: "grid", gap: "10px", justifyItems: "start" },
      },
      h(
        "span",
        null,
        tr("このWorkerは、稼働中の配信", "This Worker has not recorded "),
        ...links([deployment]),
        tr(
          `を記録していません。HostがWorkerの配信を記録するのは、そのWorker自体が適用されたときだけです。${
            phase === "NotReady" ? "記録するまでは非稼働と報告され、" : "記録するまで、"
          }このWorkerのWorkerCronTriggerは適用を完了できず、実行されません。WorkerCronTriggerを追加する前に、同じ設定で更新して記録してください。`,
          `, which serves it: the Host records a Worker's Deployment only when the Worker itself is applied. Until it does, ${
            phase === "NotReady" ? "the Host reports it NotReady, and " : ""
          }a WorkerCronTrigger for it cannot finish being applied, so it never runs. Update it with the same spec to record it before you add a WorkerCronTrigger.`,
        ),
      ),
      next,
    );
  });
}

/** Whether a Deployment's versions are exactly this one version at weight 10000. */
export function servesOnly(versions: unknown, versionUid: string): boolean {
  if (!Array.isArray(versions) || versions.length !== 1) return false;
  const [entry] = versions;
  return (
    valueAt(entry, ["workerVersion", "resourceUid"]) === versionUid &&
    valueAt(entry, ["weight"]) === 10000
  );
}

/**
 * On a WorkerVersion's page: serve this version. It opens the update of the
 * Worker's Deployment with this version alone at weight 10000, or a new
 * Deployment when the Worker has none; nothing is sent until the person
 * accepts it. A Deployment that already names this version alone says how
 * that change stands, from its own state, rather than claiming it serves.
 */
function serveVersionAction(organizationId: string, version: ResourceSummary): Child {
  const workerUid = valueAt(version.spec, ["worker", "resourceUid"]);
  if (typeof workerUid !== "string") return null;
  const served = resource(() => deploymentOf(organizationId, workerUid));
  const versions = [{ workerVersion: { resourceUid: version.uid }, weight: 10000 }];
  return live(() => {
    const state = served.get();
    if (state.state !== "ready") return null;
    const deployment = state.value;
    const current = deployment ? valueAt(deployment.spec, ["versions"]) : undefined;
    if (deployment && servesOnly(current, version.uid)) {
      const link = h("a", { ...linkProps(resourcePath(deployment.uid)) }, deployment.name);
      const settled = health(deployment);
      // Only a settled, healthy Deployment is said to serve; every other state
      // says what it is. health() already puts Deleting and Failed before a
      // change not yet observed (Pending), so the phase alone decides.
      const words = {
        Pending: () => tr("配信を更新中です：", "The Deployment is updating: "),
        Ready: () => tr("この版を配信中です：", "Serving this version: "),
        Applied: () => tr("この版を配信中です：", "Serving this version: "),
        Failed: () => tr("配信の更新に失敗しました：", "The Deployment's update failed: "),
        NotReady: () => tr("配信の準備ができていません：", "The Deployment is not ready: "),
        Deleting: () => tr("配信を削除中です：", "The Deployment is being deleted: "),
        Unknown: () => tr("配信の状態を確認できません：", "The Deployment's state is unknown: "),
      }[settled.phase]();
      return h("span", { class: "dim published" }, words, link);
    }
    // The Host refuses a Deployment of a version that is not ready.
    const readiness = health(version).phase;
    if (readiness !== "Ready" && readiness !== "Applied")
      return h(
        "span",
        { class: "dim" },
        tr("この版の準備ができると配信できます", "This version can be served once it is Ready"),
      );
    const split =
      Array.isArray(current) && current.length > 1
        ? tr(
            `現在は${current.length}つの版を配信しています。この更新で${version.name}だけになります。`,
            `It serves ${current.length} versions now; after this update it serves only ${version.name}. `,
          )
        : "";
    return h(
      "button",
      {
        class: "btn btn--primary",
        type: "button",
        onClick: () =>
          deployment
            ? updateResource(organizationId, deployment, {
                spec: { ...deployment.spec, versions },
                note:
                  split +
                  (split
                    ? tr(
                        `${deployment.name}を更新します。内容を確認して「更新を受け付ける」を押してください。`,
                        `This updates ${deployment.name}. Check it, then accept.`,
                      )
                    : tr(
                        `${deployment.name}を更新し、${version.name}だけを重み10000で配信します。内容を確認して「更新を受け付ける」を押してください。`,
                        `This updates ${deployment.name} to serve only ${version.name}, at weight 10000. Check it, then accept.`,
                      )),
              })
            : createResource(organizationId, {
                form: WORKER_DEPLOYMENT,
                spec: { worker: { resourceUid: workerUid }, versions },
                note: tr(
                  `このWorkerにはまだ配信（WorkerDeployment）がありません。${version.name}を配信するWorkerDeploymentを作成します。名前を付けて「受け付ける」を押してください。`,
                  `This Worker has no Deployment yet. This creates one that serves ${version.name}. Name it, then accept.`,
                ),
              }),
      },
      tr("この版を配信する", "Serve this version"),
    );
  });
}

/** The Resources this spec names, by name, so the graph can be walked rather than read. */
function referencesCard(organizationId: string, references: readonly SpecReference[]): Child {
  const named = resource(async () => {
    const uids = [...new Set(references.map((reference) => reference.uid))];
    const answers = await Promise.all(
      uids.map((uid) =>
        api.resource(organizationId, uid).then(
          (target): readonly [string, ResourceSummary | "absent" | "unreadable"] => [uid, target],
          (error): readonly [string, ResourceSummary | "absent" | "unreadable"] => [
            uid,
            error instanceof ApiError && (error.status === 404 || error.status === 410)
              ? "absent"
              : "unreadable",
          ],
        ),
      ),
    );
    return new Map<string, ResourceSummary | "absent" | "unreadable">(answers);
  });
  return card(
    tr("参照先", "Referenced resources"),
    h(
      "div",
      { class: "card__body rows" },
      ...references.map((reference) =>
        field(
          pathLabel(reference.path),
          live(() => {
            const state = named.get();
            const target = state.state === "ready" ? state.value.get(reference.uid) : undefined;
            if (target === undefined) return h("span", { class: "mono dim" }, reference.uid);
            if (target === "absent" || target === "unreadable")
              return h(
                "span",
                { class: "dim" },
                h("span", { class: "mono" }, reference.uid),
                text(
                  target === "absent"
                    ? tr("（この組織にはありません）", " — not in this organization")
                    : tr("（読み込めませんでした）", " — could not be read"),
                ),
              );
            return h(
              "span",
              { class: "ref" },
              h("a", { class: "mono", ...linkProps(resourcePath(target.uid)) }, target.name),
              h("span", { class: "dim" }, formLabel(target.form)),
            );
          }),
        ),
      ),
    ),
  );
}

/**
 * The Resources that name this one, so a Worker leads to its Versions,
 * Deployment and Endpoint (with the address it publishes). Shown only once
 * something is found.
 */
function referrersCard(organizationId: string, uid: string): Child {
  const found = resource(() => findReferrers(organizationId, uid));
  return live(() => {
    const state = found.get();
    if (state.state !== "ready" || state.value.referrers.length === 0) return null;
    const { referrers, complete, checked } = state.value;
    return card(
      complete
        ? tr("参照元", "Referenced by")
        : tr(`参照元（最初の${checked}件を確認）`, `Referenced by (first ${checked} checked)`),
      h(
        "div",
        { class: "card__body rows" },
        ...referrers.map(({ resource: referrer, paths }) => {
          const url = publishedUrl(referrer.output);
          return field(
            pathLabel(paths.join(", ")),
            h(
              "span",
              { class: "ref" },
              h("a", { class: "mono", ...linkProps(resourcePath(referrer.uid)) }, referrer.name),
              h("span", { class: "dim" }, formLabel(referrer.form)),
              url
                ? h(
                    "a",
                    { href: url, target: "_blank", rel: "noopener noreferrer" },
                    url,
                    h("span", { "aria-hidden": "true" }, " ↗"),
                    newTab(),
                  )
                : null,
            ),
          );
        }),
      ),
    );
  });
}

/** What the Host is doing with a Resource, for each v2 phase, as [Japanese, English]. */
export const HOST_WORK: Readonly<Record<string, readonly [string, string]>> = {
  pending: ["処理中", "In progress"],
  deleting: ["削除中", "Deleting"],
  error: ["失敗", "Failed"],
  // Set only when the last Operation succeeded and nothing is running.
  idle: ["なし（完了）", "None (settled)"],
};

/** A phase this Console does not know is shown as the Host wrote it, never as settled. */
export function hostWork(phase: string): string {
  const words = Object.hasOwn(HOST_WORK, phase) ? HOST_WORK[phase] : undefined;
  return words ? tr(...words) : phase;
}

function newTab(): Child {
  return h(
    "span",
    { class: "visually-hidden" },
    tr("（新しいタブで開きます）", " (opens in a new tab)"),
  );
}

function httpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A place in a spec, in monospace, that wraps only between its parts
 * ("versions[0]." / "workerVersion") rather than in the middle of a name.
 */
function pathLabel(path: string): Child {
  const parts = path.split(/(?<=[.,])|(?=\[)/u);
  return h(
    "span",
    { class: "mono path-label" },
    ...parts.flatMap((part, index) => (index === 0 ? [part] : [h("wbr"), part])),
  );
}

function field(label: Child, value: Child): Child {
  return h(
    "div",
    { class: "row" },
    h("div", { class: "row__label" }, label),
    h("div", { class: "row__value" }, value),
  );
}
