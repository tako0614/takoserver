import type { Organization } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { consoleLocale, setConsoleLocale, tr } from "../i18n.ts";
import {
  apiOrigin,
  applyTheme,
  principal,
  setApiOrigin,
  signOut,
  type Theme,
  theme,
} from "../state.ts";
import { card, copyable, ICON, icon, toast, when } from "../ui.ts";

/**
 * The account, the organization, and where this console is pointed.
 *
 * The API origin is settable because the console is a static bundle that may
 * be served from anywhere — including a laptop, against a local server. A
 * console that can only ever talk to one host is a console you cannot develop
 * against.
 */
export function settingsPage(organization: Organization): Child {
  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "head" },
      h(
        "div",
        { class: "head__text" },
        h("h1", null, tr("設定", "Settings")),
        h(
          "p",
          null,
          tr(
            "サインイン中のアカウントと、このConsoleの接続先を確認します。",
            "Who you are signed in as, and what this console is talking to.",
          ),
        ),
      ),
    ),
    card(
      tr("組織", "Organization"),
      h(
        "div",
        { class: "card__body" },
        h(
          "div",
          { class: "rows" },
          row(tr("名前", "Name"), organization.name),
          row(tr("識別子", "Identifier"), copyable(organization.id)),
          row(tr("作成日時", "Created"), when(organization.createdAt)),
          row(
            tr("テナント", "Tenant"),
            h(
              "span",
              { class: "dim" },
              tr(
                "リソースは組織単位で分離され、この識別子がTakoformホストのテナントキーになります。",
                "Resources are isolated by this organization; its identifier is the tenant key the Takoform Host uses.",
              ),
            ),
          ),
        ),
      ),
    ),
    live(() => {
      const who = principal();
      return card(
        tr("アカウント", "Account"),
        h(
          "div",
          { class: "card__body" },
          h(
            "div",
            { class: "rows" },
            row(tr("サインイン中", "Signed in as"), who ? who.displayName : "—"),
            row(tr("メール", "Email"), who ? who.email : "—"),
            row(tr("IDプロバイダー", "Identity provider"), who ? who.provider : "—"),
            row(tr("プリンシパル", "Principal"), who ? copyable(who.id) : "—"),
          ),
          h(
            "div",
            { style: { marginTop: "16px" } },
            h(
              "button",
              { class: "btn btn--danger", type: "button", onClick: signOut },
              icon(ICON.out, 14),
              text(tr("サインアウト", "Sign out")),
            ),
          ),
        ),
      );
    }),
    live(() =>
      card(
        tr("表示", "Appearance"),
        h(
          "div",
          { class: "card__body" },
          h(
            "div",
            { class: "toolbar" },
            ...(["system", "light", "dark"] as const).map((option) =>
              h(
                "button",
                {
                  class: theme() === option ? "btn btn--primary" : "btn",
                  type: "button",
                  onClick: () => applyTheme(option as Theme),
                },
                themeLabel(option),
              ),
            ),
          ),
        ),
      ),
    ),
    live(() =>
      card(
        tr("言語", "Language"),
        h(
          "div",
          { class: "card__body" },
          h(
            "div",
            { class: "toolbar" },
            ...(["ja", "en"] as const).map((option) =>
              h(
                "button",
                {
                  class: consoleLocale() === option ? "btn btn--primary" : "btn",
                  type: "button",
                  onClick: () => setConsoleLocale(option),
                },
                option === "ja" ? "日本語" : "English",
              ),
            ),
          ),
        ),
      ),
    ),
    live(() => {
      const input = h("input", { class: "input", value: apiOrigin() });
      return card(
        tr("API接続先", "API endpoint"),
        h(
          "div",
          { class: "card__body" },
          h(
            "div",
            { class: "field" },
            h("label", null, tr("オリジン", "Origin")),
            h(
              "div",
              { style: { display: "flex", gap: "8px" } },
              input,
              h(
                "button",
                {
                  class: "btn",
                  type: "button",
                  onClick: () => {
                    setApiOrigin(input.value.trim());
                    toast(tr("接続先を更新しました", "Endpoint updated"), "ok");
                  },
                },
                tr("保存", "Save"),
              ),
            ),
            h(
              "small",
              null,
              tr(
                "このConsoleのすべてのリクエストがここへ送られます。変更してもデータは移動しません。",
                "Every request from this console goes here. Changing it does not move any data.",
              ),
            ),
          ),
        ),
      );
    }),
  );
}

function themeLabel(theme: Theme): string {
  if (theme === "system") return tr("システム", "System");
  if (theme === "light") return tr("ライト", "Light");
  return tr("ダーク", "Dark");
}

function row(label: string, value: Child): Child {
  return h(
    "div",
    { class: "row" },
    h("div", { class: "row__label" }, label),
    h("div", { class: "row__value" }, value),
  );
}
