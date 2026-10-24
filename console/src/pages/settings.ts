import type { Organization } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { guideLink, workerSupport } from "../first-run.ts";
import { consoleLocale, setConsoleLocale, tr } from "../i18n.ts";
import { resource } from "../reactive.ts";
import { linkProps } from "../router.ts";
import {
  api,
  apiOrigin,
  applyTheme,
  hostV2Base,
  principal,
  setApiOrigin,
  signOut,
  type Theme,
  theme,
} from "../state.ts";
import { card, copyable, explain, ICON, icon, toast, when } from "../ui.ts";

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
            "サインイン中のアカウントと、このコンソールの接続先を確認します。",
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
            tr("スペース", "Space"),
            h(
              "span",
              { class: "dim" },
              tr(
                "Host API v2では、この識別子がスペース（Space）になります。リソースは組織ごとに分かれ、この組織のAPIキーとサインイン中のセッションは、どちらもこの組織として操作します。",
                "In Host API v2 this identifier is the Space. Each resource belongs to one organization, and its API keys (within their scopes) and your signed-in session act as that organization.",
              ),
            ),
          ),
        ),
      ),
    ),
    hostCard(organization.id),
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
              {
                class: "btn btn--danger",
                type: "button",
                onClick: () => {
                  void signOut().catch((error: unknown) => toast(explain(error as Error), "bad"));
                },
              },
              icon(ICON.signOut, 14),
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
      const input = h("input", { class: "input", id: "settings-api-origin", value: apiOrigin() });
      return card(
        tr("API接続先", "API endpoint"),
        h(
          "div",
          { class: "card__body" },
          h(
            "div",
            { class: "field" },
            h("label", { for: "settings-api-origin" }, tr("オリジン", "Origin")),
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
                "このコンソールのすべてのリクエストがここへ送られます。変更してもデータは移動しません。",
                "Every request from this console goes here. Changing it does not move any data.",
              ),
            ),
          ),
        ),
      );
    }),
  );
}

/**
 * What this Host offers: the Host API v2 address that Takoform and curl use,
 * and whether it runs Workers and publishes them at HTTPS hostnames, as the
 * Host itself answers.
 */
export function hostCard(organizationId: string): Child {
  const discovery = resource(() => api.hostDiscovery());
  const support = resource(() => workerSupport(organizationId));
  const checking = (): Child => h("span", { class: "dim" }, tr("確認中…", "Checking…"));
  const unchecked = (): Child =>
    h("span", { class: "dim" }, tr("確認できませんでした", "Couldn't check"));
  const guideStep = (anchor: string, ja: string, en: string): Child =>
    guideLink(anchor, tr(`導入手順書（英語）の${ja}`, `${en} of the install guide`));

  const address = (): Child => {
    const state = discovery.get();
    if (state.state === "loading") return checking();
    const v2 = hostV2Base(state.state === "ready" ? state.value : null);
    return h(
      "div",
      { style: { display: "grid", gap: "6px" } },
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "10px" } },
        // The whole address is read and pasted, so it wraps instead of being cut short.
        h(
          "span",
          { class: "mono", style: { wordBreak: "break-all", flex: "1", minWidth: "0" } },
          v2,
        ),
        copyable(v2, tr("コピー", "copy")),
      ),
      h(
        "small",
        null,
        tr(
          "curlなどのHost API v2クライアントからは、このURL、スペース（上の「識別子」）、",
          "Host API v2 clients such as curl use this URL, the Identifier above as the Space, and ",
        ),
        h("a", { ...linkProps("/keys") }, tr("APIキー", "an API key")),
        tr("を使って操作します。", "."),
      ),
    );
  };

  return card(
    tr("このHost", "This Host"),
    h(
      "div",
      { class: "card__body" },
      // One region for every row, so each row but the last keeps its rule.
      live(() => {
        const state = support.get();
        const [worker, endpoint] = state.state === "ready" ? state.value : [null, null];
        const rows = [row("Host API v2", address())];
        rows.push(
          row(
            tr("Worker", "Workers"),
            state.state === "loading"
              ? checking()
              : worker === true
                ? tr("実行します", "Runs Workers")
                : worker === false
                  ? h(
                      "span",
                      null,
                      tr(
                        "実行しません。保持できるのは成果物だけです。Workerを動かすには、",
                        "Does not run Workers; it keeps artifacts only. Running them needs the Worker runtime and its settings from ",
                      ),
                      guideStep("3-configuration", "手順3", "step 3"),
                      tr("にあるWorker実行環境とその設定が必要です。", "."),
                    )
                  : unchecked(),
          ),
        );
        // Publishing is a question only for a Host that runs Workers.
        if (worker === true)
          rows.push(
            row(
              tr("HTTPSでの公開", "HTTPS publishing"),
              endpoint === true
                ? tr(
                    "WorkerEndpointで、WorkerをHTTPSのホスト名に公開できます",
                    "WorkerEndpoint publishes Workers at HTTPS hostnames",
                  )
                : endpoint === false
                  ? h(
                      "span",
                      null,
                      tr(
                        "まだ公開できません。",
                        "Not yet: it needs the HTTPS listener on TCP 443 from ",
                      ),
                      guideStep("4-https-and-tcp-443", "手順4", "step 4"),
                      tr("にあるHTTPS（TCP 443）の待ち受け設定が必要です。", "."),
                    )
                  : unchecked(),
            ),
          );
        return h("div", { class: "rows" }, ...rows);
      }),
    ),
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
