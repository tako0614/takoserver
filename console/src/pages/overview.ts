import {
  formatMicrosCurrency,
  type Organization,
  type ResourceSummary,
  type Wallet,
} from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { firstRunNote, once } from "../first-run.ts";
import { valueAt, WORKER_ENDPOINT, WORKER_VERSION } from "../form-specs.ts";
import { formName } from "../forms.ts";
import { consoleLocale, tr } from "../i18n.ts";
import { resource } from "../reactive.ts";
import { publishedUrl, servedWorkers } from "../references.ts";
import { byForm, health, phaseLabel } from "../resource-state.ts";
import { linkProps, resourcePath } from "../router.ts";
import { api } from "../state.ts";
import { badge, card, empty, ICON, icon, whenReady } from "../ui.ts";
import { createResource } from "./create-resource.ts";

/**
 * The first screen, answering the question someone signs in with: is
 * anything I deployed broken.
 *
 * Resource counts and Form groups describe only the first loaded v2 page;
 * the full cursor chain remains on the Resources screen.
 */
export function overviewPage(organization: Organization): Child {
  // Made on the first empty render and reused, so a re-render does not ask the
  // Host again.
  const note = once(() => firstRunNote(organization.id));
  const wallet = resource(() => api.wallet(organization.id));
  const resources = resource(() => api.resources(organization.id));

  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "head" },
      h(
        "div",
        { class: "head__text" },
        h("h1", null, organization.name),
        h(
          "p",
          null,
          tr(
            "Workerの公開先と、Takoformで宣言したリソースの状態を確認できます。",
            "Where your Workers are served, and the state of the resources you declared with Takoform.",
          ),
        ),
      ),
    ),
    live(() =>
      whenReady(
        resources.get(),
        ({ resources: all, cursor }) =>
          all.length === 0
            ? card(
                tr("リソース", "Resources"),
                empty(
                  tr("リソースがありません", "Nothing declared yet"),
                  note(),
                  h(
                    "button",
                    {
                      class: "btn btn--primary",
                      type: "button",
                      onClick: () => createResource(organization.id),
                    },
                    icon(ICON.plus, 14),
                    text(tr("リソースを作成", "New resource")),
                  ),
                ),
              )
            : // What someone signs in to see comes first: where each Worker is
              // served, then anything broken, then the counts.
              h(
                "div",
                { style: { display: "grid", gap: "18px" } },
                workersCard(organization.id, all, cursor !== null),
                attentionCard(all),
                resourcesCard(all, cursor !== null),
              ),
        { retry: resources.reload },
      ),
    ),
    live(() =>
      whenReady(
        wallet.get(),
        ({ wallet: held }) =>
          // v2 Resources are never charged, so a self-host whose wallet has
          // never been used shows nothing here; Usage & billing still has the
          // wallet. One that has been used keeps its line at $0.
          walletInUse(held) ? walletLine(held) : h("div", { style: { display: "none" } }),
        { skeleton: false },
      ),
    ),
  );
}

/** Resources that failed, report not ready, or have a change not yet applied. */
function attentionCard(all: readonly ResourceSummary[]): Child {
  const attention = all.filter((entry) => {
    const state = health(entry);
    return state.phase === "Failed" || state.phase === "NotReady" || state.stale;
  });
  if (attention.length === 0) return null;
  return card(
    tr("確認が必要", "Needs attention"),
    h(
      "div",
      { class: "table-scroll" },
      h(
        "table",
        null,
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            h("th", null, tr("リソース", "Resource")),
            h("th", null, tr("状態", "State")),
            h("th", null, tr("理由", "Why")),
          ),
        ),
        h(
          "tbody",
          null,
          ...attention.slice(0, 8).map((entry) => {
            const state = health(entry);
            return h(
              "tr",
              null,
              h(
                "td",
                null,
                h("a", { class: "mono", ...linkProps(resourcePath(entry.uid)) }, entry.name),
              ),
              h("td", null, badge(phaseLabel(state.phase), state.tone, true)),
              h(
                "td",
                { class: "dim" },
                state.message ??
                  (state.stale
                    ? tr(
                        "最新の宣言がまだ適用されていません",
                        "the latest declaration has not been applied",
                      )
                    : state.phase === "NotReady"
                      ? tr(
                          "最新の観測でReadyではありません",
                          "latest observation reports not ready",
                        )
                      : "—"),
              ),
            );
          }),
        ),
      ),
    ),
  );
}

/**
 * How many Resources the first page holds, by Form. Only the first page is
 * read here; when the Host has more, the count says so instead of passing a
 * page size off as a total. Each Form opens the list narrowed to its exact URL.
 * The caption counts only failed and not-ready Resources; Needs attention also
 * lists changes not yet applied, so the two can differ on purpose.
 */
function resourcesCard(all: readonly ResourceSummary[], more: boolean): Child {
  const attention = all.filter((entry) =>
    ["Failed", "NotReady"].includes(health(entry).phase),
  ).length;
  const caption =
    attention > 0
      ? h(
          "span",
          { style: { color: "var(--warn)" } },
          more
            ? tr(`${attention}件以上に確認が必要`, `${attention}+ need attention`)
            : tr(`${attention}件に確認が必要`, `${attention} need attention`),
        )
      : more
        ? tr("最初のページのみ集計", "first page only")
        : tr("失敗・非稼働はありません", "none failed or not ready");
  return card(
    h(
      "span",
      null,
      tr("リソース", "Resources"),
      " ",
      h("span", { class: "dim" }, more ? `${all.length}+` : String(all.length)),
    ),
    h(
      "div",
      { class: "card__body rows rows--counts" },
      h("div", { class: "row" }, h("div", { class: "row__label dim" }, caption)),
      ...byForm(all).map((entry) =>
        h(
          "div",
          { class: "row" },
          h(
            "div",
            { class: "row__label" },
            h(
              "a",
              {
                title: entry.form,
                ...linkProps(`/resources?form=${encodeURIComponent(entry.form)}`),
              },
              formName(entry.form),
            ),
          ),
          h(
            "div",
            { class: "row__value" },
            String(entry.total),
            entry.attention > 0
              ? h(
                  "span",
                  { style: { marginLeft: "8px" } },
                  badge(
                    tr(`${entry.attention}件に確認が必要`, `${entry.attention} need attention`),
                    "warn",
                    true,
                  ),
                )
              : null,
          ),
        ),
      ),
    ),
    h(
      "a",
      { class: "btn btn--sm", ...linkProps("/resources") },
      text(tr("すべて表示", "View all")),
      icon(ICON.chevron, 13),
    ),
  );
}

/** A wallet that has been used, in one line after what was deployed. */
function walletLine(held: Wallet): Child {
  const money = (micros: string) => formatMicrosCurrency(micros, held.currency, uiLocale());
  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "card__body wallet-line" },
      h("span", { class: "wallet-line__label" }, tr("ウォレット", "Wallet")),
      h(
        "span",
        null,
        tr("利用可能", "Available"),
        " ",
        h("strong", null, money(held.availableMicros)),
      ),
      h("span", null, tr("確定残高", "Settled"), " ", money(held.settledMicros)),
      BigInt(held.heldMicros) > 0n
        ? h(
            "span",
            { class: "dim" },
            tr(`${money(held.heldMicros)}を確保中`, `${money(held.heldMicros)} held`),
          )
        : null,
      h("a", { ...linkProps("/billing") }, tr("使用量と請求", "Usage & billing")),
    ),
  );
}

/**
 * Each Worker with the state of the Deployment serving it and the addresses
 * it is published at: what someone signing in most wants to know.
 */
function workersCard(
  organizationId: string,
  all: readonly ResourceSummary[],
  partial: boolean,
): Child {
  const workers = servedWorkers(all);
  if (workers.length === 0) return null;
  return card(
    partial ? tr("Worker（最初のページ）", "Workers (first page)") : tr("Worker", "Workers"),
    h(
      "div",
      { class: "card__body rows" },
      ...workers.map(({ worker, deployment, endpoints }) => {
        const state = health(deployment ?? worker);
        return h(
          "div",
          { class: "row" },
          h(
            "div",
            { class: "row__label" },
            h("a", { class: "mono", ...linkProps(resourcePath(worker.uid)) }, worker.name),
          ),
          h(
            "div",
            { class: "row__value ref" },
            badge(phaseLabel(state.phase), state.tone, true),
            ...(endpoints.length > 0
              ? endpoints.map((endpoint) => address(endpoint))
              : [nextStep(organizationId, all, worker, deployment, partial)]),
          ),
        );
      }),
    ),
  );
}

/** Resources of one kind that name this Worker as their `worker`. */
function namingWorker(
  all: readonly ResourceSummary[],
  form: string,
  workerUid: string,
): readonly ResourceSummary[] {
  return all.filter(
    (resource) =>
      resource.form === form && valueAt(resource.spec, ["worker", "resourceUid"]) === workerUid,
  );
}

/**
 * What a Worker without an address still needs, as the step that makes it:
 * a version, a Deployment of one, or an Endpoint. Each opens the create dialog
 * with the Worker already filled in; nothing is sent until the person accepts.
 */
function nextStep(
  organizationId: string,
  all: readonly ResourceSummary[],
  worker: ResourceSummary,
  deployment: ResourceSummary | undefined,
  partial: boolean,
): Child {
  const dim = (words: string) => h("span", { class: "dim" }, words);
  // On a partial first page, what is missing may be on a later page.
  if (partial)
    return dim(
      deployment
        ? tr("このページには公開先がありません", "No address on this page")
        : tr("このページには配信がありません", "No deployment on this page"),
    );
  const step = (label: string, onClick: () => void) =>
    h("button", { class: "btn btn--sm", type: "button", onClick }, label);
  if (deployment) {
    if (namingWorker(all, WORKER_ENDPOINT, worker.uid).length > 0)
      return dim(tr("公開先を準備中です", "Its address is being prepared"));
    return h(
      "span",
      { class: "ref" },
      dim(tr("公開先はまだありません", "Not published yet")),
      step(tr("公開する", "Publish"), () =>
        createResource(organizationId, {
          form: WORKER_ENDPOINT,
          spec: { worker: { resourceUid: worker.uid } },
          note: tr(
            `${worker.name}をHTTPSのホスト名で公開するWorkerEndpointを作成します。名前を付けて受け付けてください。`,
            `This creates a WorkerEndpoint that publishes ${worker.name} at an HTTPS hostname. Name it, then accept.`,
          ),
        }),
      ),
    );
  }
  const versions = namingWorker(all, WORKER_VERSION, worker.uid);
  if (versions.length === 0)
    return h(
      "span",
      { class: "ref" },
      dim(tr("版はまだありません", "No version yet")),
      step(tr("版を作る", "Create a version"), () =>
        createResource(organizationId, {
          form: WORKER_VERSION,
          spec: {
            worker: { resourceUid: worker.uid },
            bundle: { resourceUid: "" },
            handlers: ["fetch"],
          },
          note: tr(
            `${worker.name}の版を作成します。コードのWorkerBundleを選び、名前を付けて受け付けてください。`,
            `This creates a version of ${worker.name}. Choose its WorkerBundle, name it, then accept.`,
          ),
        }),
      ),
    );
  // Serving is decided on the version's own page, where its readiness is known.
  const [only] = versions;
  return h(
    "span",
    { class: "ref" },
    dim(tr("配信中の版はありません", "No deployment yet")),
    versions.length === 1 && only
      ? h(
          "a",
          { class: "btn btn--sm", ...linkProps(resourcePath(only.uid)) },
          tr(`${only.name}を配信する`, `Serve ${only.name}`),
        )
      : h(
          "a",
          {
            class: "btn btn--sm",
            ...linkProps(`/resources?form=${encodeURIComponent(WORKER_VERSION)}`),
          },
          tr("版を選んで配信する", "Choose a version to serve"),
        ),
  );
}

/**
 * An Endpoint's address: a link once the Endpoint is Ready, and plain text
 * with the Endpoint's own state while it is still settling or has failed,
 * since its address is reported before it answers.
 */
function address(endpoint: ResourceSummary): Child {
  const url = publishedUrl(endpoint.output) ?? "";
  const state = health(endpoint);
  if (state.phase === "Ready") {
    return h(
      "a",
      { href: url, target: "_blank", rel: "noopener noreferrer" },
      url,
      h("span", { "aria-hidden": "true" }, " ↗"),
    );
  }
  return h(
    "span",
    { class: "ref" },
    h("span", { class: "mono dim" }, url),
    badge(phaseLabel(state.phase), state.tone, true),
  );
}

function uiLocale(): "en-US" | "ja-JP" {
  return consoleLocale() === "ja" ? "ja-JP" : "en-US";
}

/** Whether the wallet holds money now or has any history at all. */
function walletInUse(wallet: Wallet): boolean {
  return (
    wallet.entries.length > 0 ||
    [wallet.availableMicros, wallet.heldMicros, wallet.settledMicros].some(
      (micros) => BigInt(micros) !== 0n,
    )
  );
}
