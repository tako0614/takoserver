import {
  formatMicrosCurrency,
  type Organization,
  type ResourceSummary,
  type Wallet,
} from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { firstRunNote, once } from "../first-run.ts";
import { formName } from "../forms.ts";
import { consoleLocale, tr } from "../i18n.ts";
import { resource } from "../reactive.ts";
import { publishedUrl, servedWorkers } from "../references.ts";
import { byForm, health, phaseLabel } from "../resource-state.ts";
import { linkProps, resourcePath } from "../router.ts";
import { api } from "../state.ts";
import { ago, badge, card, copyable, empty, ICON, icon, whenReady } from "../ui.ts";
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
  const operations = resource(() => api.operations(organization.id));

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
                workersCard(all, cursor !== null),
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
    live(() =>
      whenReady(
        operations.get(),
        ({ operations: all }) =>
          all.length === 0
            ? h("div", { style: { display: "none" } })
            : card(
                tr("最近のアカウント操作", "Recent account activity"),
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
                        h("th", null, tr("操作", "Operation")),
                        h("th", null, tr("結果", "Result")),
                        h("th", null, tr("日時", "When")),
                        h("th", null, "Id"),
                      ),
                    ),
                    h(
                      "tbody",
                      null,
                      ...all
                        .slice(0, 10)
                        .map((entry) =>
                          h(
                            "tr",
                            null,
                            h("td", { class: "mono" }, entry.operation),
                            h(
                              "td",
                              null,
                              badge(entry.state, entry.state === "succeeded" ? "ok" : "bad"),
                            ),
                            h("td", { class: "dim" }, ago(entry.createdAt)),
                            h("td", null, copyable(entry.id)),
                          ),
                        ),
                    ),
                  ),
                ),
              ),
        { skeleton: h("div", { style: { display: "none" } }) },
      ),
    ),
  );
}

/**
 * Each Worker with the state of the Deployment serving it and the addresses
 * it is published at: what someone signing in most wants to know.
 */
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

function workersCard(all: readonly ResourceSummary[], partial: boolean): Child {
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
              : [
                  h(
                    "span",
                    { class: "dim" },
                    !deployment
                      ? tr("配信中の版はありません", "No deployment yet")
                      : partial
                        ? tr("このページには公開先がありません", "No address on this page")
                        : tr("公開先はまだありません", "Not published yet"),
                  ),
                ]),
          ),
        );
      }),
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
