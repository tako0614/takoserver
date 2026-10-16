import type { ResourceSummary } from "../api.ts";
import { ApiError } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { valueAt, WORKER_DEPLOYMENT, WORKER_VERSION } from "../form-specs.ts";
import { formLabel } from "../forms.ts";
import { tr } from "../i18n.ts";
import { resource } from "../reactive.ts";
import { publishedUrl, type SpecReference, specReferences } from "../references.ts";
import { health, phaseLabel } from "../resource-state.ts";
import { linkProps, resourcePath, route } from "../router.ts";
import { api, currentOrganization } from "../state.ts";
import { badge, card, copyable, empty, ICON, icon, jsonBlock, whenReady } from "../ui.ts";
import { createResource, deleteResource, updateResource } from "./create-resource.ts";

export { publishedUrl, type SpecReference, specReferences } from "../references.ts";

/** How many list pages are read to find what names a Resource. */
const REFERRER_PAGES = 5;

export interface Referrer {
  readonly resource: ResourceSummary;
  /** Where its spec names the Resource being shown. */
  readonly paths: readonly string[];
}

/**
 * The Resources whose specs name `uid`, from the organization's list. Only
 * the first pages are read, so `complete` says whether the answer covers
 * every Resource and `checked` how many it looked at.
 */
export async function findReferrers(
  organizationId: string,
  uid: string,
): Promise<{
  readonly referrers: readonly Referrer[];
  readonly complete: boolean;
  readonly checked: number;
}> {
  const referrers: Referrer[] = [];
  let cursor: string | null = null;
  let checked = 0;
  for (let page = 0; page < REFERRER_PAGES; page += 1) {
    const read = await api.resources(organizationId, cursor ? { cursor } : {});
    checked += read.resources.length;
    for (const resource of read.resources) {
      const paths = specReferences(resource.spec)
        .filter((reference) => reference.uid === uid)
        .map((reference) => reference.path);
      if (paths.length > 0 && resource.uid !== uid) referrers.push({ resource, paths });
    }
    cursor = read.cursor;
    if (cursor === null) return { referrers, complete: true, checked };
  }
  return { referrers, complete: false, checked };
}

/** The v2 address is the durable UID, never a reconstructed kind/name tuple. */
export function resourceDetailPage(organizationId: string, uid: string): Child {
  // Made once per page, so a re-render does not look the Deployment up again.
  let serve: Child | undefined;
  const serveAction = (found: ResourceSummary): Child => {
    serve ??= found.form === WORKER_VERSION ? serveVersionAction(organizationId, found) : null;
    return serve;
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
            ? body(found, organizationId, page.reload, serveAction(found))
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

function body(
  found: ResourceSummary,
  organizationId: string,
  reload: () => void,
  serve: Child,
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
        serve,
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
    state.phase === "NotReady"
      ? h(
          "div",
          { class: "notice notice--warn" },
          tr("最新の観測でReadyではありません。", "The latest observation reports not ready."),
        )
      : null,
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
      const words =
        settled.phase === "Failed"
          ? tr("配信の更新に失敗しました：", "The Deployment's update failed: ")
          : settled.stale || settled.phase === "Pending"
            ? tr("配信を更新中です：", "The Deployment is updating: ")
            : settled.phase === "NotReady"
              ? tr("配信の準備ができていません：", "The Deployment is not ready: ")
              : tr("この版を配信中です：", "Serving this version: ");
      return h("span", { class: "dim" }, words, link);
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
                  tr(
                    `${deployment.name}を更新し、${version.name}だけを重み10000で配信します。内容を確認して受け付けてください。`,
                    `This updates ${deployment.name} to serve only ${version.name}, at weight 10000. Check it, then accept.`,
                  ),
              })
            : createResource(organizationId, {
                form: WORKER_DEPLOYMENT,
                spec: { worker: { resourceUid: workerUid }, versions },
                note: tr(
                  `このWorkerにはまだ配信（WorkerDeployment）がありません。${version.name}を配信するWorkerDeploymentを作成します。名前を付けて受け付けてください。`,
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
