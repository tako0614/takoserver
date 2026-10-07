import type { Organization } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { tr } from "../i18n.ts";
import { resource } from "../reactive.ts";
import { byForm, health } from "../resource-state.ts";
import { linkProps, resourcePath } from "../router.ts";
import { api } from "../state.ts";
import { ago, badge, card, copyable, empty, ICON, icon, money, stat, whenReady } from "../ui.ts";

/**
 * The first screen, answering the two questions someone signs in with: is
 * anything broken, and can I still pay for it.
 *
 * Resource counts and Form groups describe only the first loaded v2 page;
 * the full cursor chain remains on the Resources screen.
 */
export function overviewPage(organization: Organization): Child {
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
            "Takoformリソース、前払い残高、最近の変更を確認できます。",
            "Takoform resources, prepaid balance, and what changed recently.",
          ),
        ),
      ),
    ),
    live(() =>
      h(
        "div",
        { class: "grid" },
        whenReady(
          wallet.get(),
          ({ wallet: held }) =>
            h(
              "div",
              { style: { display: "contents" } },
              stat(
                tr("利用可能", "Available"),
                money(held.availableMinor, held.currency),
                held.heldMinor > 0
                  ? tr(
                      `${money(held.heldMinor, held.currency)}を処理中の操作に確保中`,
                      `${money(held.heldMinor, held.currency)} held against live work`,
                    )
                  : tr("確保中の金額はありません", "nothing held"),
              ),
              stat(
                tr("確定残高", "Settled"),
                money(held.settledMinor, held.currency),
                tr("入金と確定済み請求", "credited and captured"),
              ),
            ),
          { skeleton: h("div", { class: "card" }, h("div", { class: "card__body skeleton" })) },
        ),
        whenReady(
          resources.get(),
          ({ resources: all }) => {
            const attention = all.filter((entry) =>
              ["Failed", "NotReady"].includes(health(entry).phase),
            ).length;
            return stat(
              tr("リソース", "Resources"),
              String(all.length),
              attention === 0
                ? tr("読み込み済みページの件数", "count from loaded page")
                : h(
                    "span",
                    { style: { color: "var(--warn)" } },
                    tr(`${attention}件に確認が必要`, `${attention} need attention`),
                  ),
            );
          },
          { skeleton: h("div", { class: "card" }, h("div", { class: "card__body skeleton" })) },
        ),
      ),
    ),
    live(() =>
      whenReady(
        resources.get(),
        ({ resources: all }) =>
          all.length === 0
            ? card(
                tr("リソース", "Resources"),
                empty(
                  tr("リソースがありません", "Nothing declared yet"),
                  tr(
                    "リソース画面で運用者から渡された正確なForm URLを使って作成できます。",
                    "Open Resources to create with an exact Form URL supplied by the operator.",
                  ),
                ),
              )
            : card(
                tr("Form別（読み込み済み）", "By Form (loaded page)"),
                h(
                  "div",
                  { class: "card__body" },
                  h(
                    "div",
                    { class: "grid" },
                    ...byForm(all).map((entry) =>
                      h(
                        "a",
                        {
                          class: "card",
                          style: { display: "block" },
                          ...linkProps("/resources"),
                        },
                        h(
                          "div",
                          { class: "card__body" },
                          h("div", { class: "stat__label" }, entry.form),
                          h("div", { class: "stat__value" }, String(entry.total)),
                          entry.attention > 0
                            ? h(
                                "div",
                                { style: { marginTop: "6px" } },
                                badge(
                                  tr(
                                    `${entry.attention}件に確認が必要`,
                                    `${entry.attention} need attention`,
                                  ),
                                  "warn",
                                  true,
                                ),
                              )
                            : null,
                        ),
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
              ),
        { retry: resources.reload },
      ),
    ),
    live(() =>
      whenReady(
        resources.get(),
        ({ resources: all }) => {
          const attention = all.filter((entry) => {
            const state = health(entry);
            return state.phase === "Failed" || state.phase === "NotReady" || state.stale;
          });
          if (attention.length === 0) return h("div", { style: { display: "none" } });
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
                        h(
                          "a",
                          {
                            class: "mono",
                            ...linkProps(resourcePath(entry.uid)),
                          },
                          entry.name,
                        ),
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
        },
        { skeleton: h("div", { style: { display: "none" } }) },
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

function phaseLabel(phase: ReturnType<typeof health>["phase"]): string {
  const japanese = {
    Ready: "稼働中",
    NotReady: "非稼働",
    Pending: "処理中",
    Failed: "失敗",
    Deleting: "削除中",
    Unknown: "不明",
  } as const;
  return tr(japanese[phase], phase);
}
