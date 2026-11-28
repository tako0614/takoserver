import type { ApiKey } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { tr } from "../i18n.ts";
import { DEFAULT_KEY_SCOPES, keyScopeGroups, keyUsage } from "../key-scopes.ts";
import { effect, resource, signal } from "../reactive.ts";
import { route } from "../router.ts";
import {
  api,
  captureSelectedOrganizationScope,
  captureSessionScope,
  hostV2Base,
} from "../state.ts";
import {
  badge,
  bindSearchShortcut,
  card,
  copyable,
  empty,
  explain,
  ICON,
  icon,
  type ModalOptions,
  openModal,
  refreshButton,
  setFieldError,
  toast,
  when,
  whenReady,
} from "../ui.ts";

const LIFETIMES: readonly { readonly label: () => string; readonly seconds: number }[] = [
  { label: () => tr("30日", "30 days"), seconds: 30 * 86_400 },
  { label: () => tr("90日", "90 days"), seconds: 90 * 86_400 },
  { label: () => tr("1年", "1 year"), seconds: 365 * 86_400 },
];

interface UnshownKey {
  readonly organizationId: string;
  readonly id: string;
  readonly name: string;
  readonly isSessionCurrent: () => boolean;
}

// Same-tab recovery metadata only: never retain the secret or response object.
// Reloading the tab drops these notices; the Host's key list remains authoritative.
const unshownKeys = signal<readonly UnshownKey[]>([]);
effect(() => {
  const previous = unshownKeys();
  const current = previous.filter((key) => key.isSessionCurrent());
  if (current.length !== previous.length) unshownKeys.set(current);
});

function rememberUnshownKey(
  key: ApiKey,
  organizationId: string,
  name: string,
  isSessionCurrent: () => boolean,
): void {
  if (
    !isSessionCurrent() ||
    typeof key !== "object" ||
    key === null ||
    key.organizationId !== organizationId ||
    typeof key.id !== "string" ||
    key.id === "" ||
    key.name !== name
  )
    return;
  const metadata: UnshownKey = { organizationId, id: key.id, name, isSessionCurrent };
  unshownKeys.update((previous) => [
    ...previous.filter(
      (item) =>
        item.isSessionCurrent() && !(item.organizationId === organizationId && item.id === key.id),
    ),
    metadata,
  ]);
}

/**
 * API keys, and the one moment their secret exists.
 *
 * Only a digest is stored, so a secret can be shown exactly once and never
 * again. The dialog that reveals it says so plainly and refuses to be dismissed
 * by a stray click, because "I'll copy it in a second" is how people lose keys.
 */
export function keysPage(organizationId: string): Child {
  const openedRoute = route();
  const isOrganizationCurrent = captureSelectedOrganizationScope(organizationId);
  const isPageCurrent = (): boolean => route() === openedRoute && isOrganizationCurrent();
  const keys = resource(() => api.apiKeys(organizationId));
  const filter = signal("");
  const totalCount = signal(0);
  const matchedCount = signal(0);
  const filterControls = createKeysFilterToolbar(filter, totalCount, matchedCount, isPageCurrent);
  // Asked once per page. An already-open dialog follows the answer without
  // replacing the person's inputs; an unreadable document never offers AI.
  const discovery = resource(() => api.hostDiscovery());
  const aiAvailable = (): boolean => {
    const state = discovery.get();
    return state.state === "ready" && state.value.ai;
  };
  const v2Endpoint = (): string => {
    const state = discovery.get();
    return hostV2Base(state.state === "ready" ? state.value : null);
  };

  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "head" },
      h(
        "div",
        { class: "head__text" },
        h("h1", null, tr("APIキー", "API keys")),
        h(
          "p",
          null,
          tr(
            "APIキーは付与されたスコープの範囲でこの組織を操作します。発行元の組織自体を管理することはできません。",
            "Keys act for this organization within the scopes they were given. A key can never administer the organization that issued it.",
          ),
        ),
      ),
      h(
        "div",
        { class: "toolbar" },
        refreshButton({
          idleLabel: () => tr("キー一覧を更新", "Refresh keys"),
          busyLabel: () => tr("更新中…", "Refreshing…"),
          isActive: isPageCurrent,
          isBusy: () => keys.get().state === "loading",
          onRefresh: keys.reload,
        }),
        h(
          "button",
          {
            class: "btn btn--primary",
            type: "button",
            onClick: () => createKey(organizationId, keys.reload, aiAvailable, v2Endpoint()),
          },
          icon(ICON.plus, 14),
          text(tr("キーを作成", "Create key")),
        ),
      ),
    ),
    live(() => {
      const listed = keys.get();
      if (!isPageCurrent() || listed.state !== "ready") return null;
      // A local session marker is not remote authorization. Only show metadata
      // already returned by this page's current owner-authorized key list.
      return unshownKeys()
        .filter(
          (key) =>
            key.isSessionCurrent() &&
            key.organizationId === organizationId &&
            listed.value.apiKeys.some(
              (item) =>
                item.organizationId === organizationId &&
                item.id === key.id &&
                item.name === key.name,
            ),
        )
        .map((key) =>
          h(
            "div",
            {
              class: "notice notice--warn",
              role: "status",
              "aria-label": tr("シークレット未表示のAPIキー", "Unshown API key secret"),
            },
            icon(ICON.alert, 15),
            h(
              "div",
              null,
              h("strong", null, key.name),
              h("div", { class: "mono" }, key.id),
              h(
                "p",
                null,
                tr(
                  "作成は成功しましたが、シークレットの表示前にダイアログが閉じられました。再表示はできません。一覧でこのキーを失効し、必要なら新しいキーを作成してください。",
                  "Creation succeeded, but the dialog closed before the secret was shown. It cannot be recovered. Revoke this key in the list, then create another if needed.",
                ),
              ),
              h(
                "button",
                {
                  class: "btn btn--sm",
                  type: "button",
                  onClick: () => {
                    if (isPageCurrent() && key.isSessionCurrent())
                      unshownKeys.update((items) => items.filter((item) => item !== key));
                  },
                },
                tr("通知を閉じる", "Dismiss notice"),
              ),
            ),
          ),
        );
    }),
    live(() =>
      whenReady(
        keys.get(),
        ({ apiKeys }) => {
          totalCount.set(apiKeys.length);
          if (apiKeys.length === 0) {
            return card(
              null,
              empty(
                tr("APIキーがありません", "No keys"),
                tr(
                  "curlや独自のコードから、Host API v2でこの組織のリソースを操作するためのキーを作成できます。",
                  "Create one to manage this organization's Resources over Host API v2 with curl or your own code.",
                ),
              ),
            );
          }
          return h(
            "div",
            { style: { display: "grid", gap: "14px" } },
            filterControls.element,
            card(
              null,
              h(
                "div",
                { class: "table-scroll" },
                live(() => {
                  const matched = matchingKeys(apiKeys, filter());
                  matchedCount.set(matched.length);
                  return table(
                    matched,
                    organizationId,
                    keys.reload,
                    filter() !== "" ? filterControls.clear : undefined,
                  );
                }),
              ),
            ),
          );
        },
        { retry: keys.reload },
      ),
    ),
  );
}

function matchingKeys(apiKeys: readonly ApiKey[], query: string): readonly ApiKey[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return apiKeys;
  return apiKeys.filter(
    (key) =>
      key.name.toLowerCase().includes(needle) ||
      key.id.toLowerCase().includes(needle) ||
      key.scopes.some((scope) => scope.toLowerCase().includes(needle)),
  );
}

function createKeysFilterToolbar(
  filter: ReturnType<typeof signal<string>>,
  total: ReturnType<typeof signal<number>>,
  matched: ReturnType<typeof signal<number>>,
  isActive: () => boolean,
): { readonly element: Child; readonly clear: () => void } {
  const input = h("input", {
    class: "input",
    id: "keys-filter",
    name: "filter",
    autocomplete: "off",
    type: "search",
    placeholder: tr("名前、ID、スコープで絞り込み", "Filter by name, ID, or scope"),
    "aria-label": tr("名前、ID、スコープで絞り込み", "Filter by name, ID, or scope"),
    value: "",
    onInput: (event: Event) => filter.set((event.target as HTMLInputElement).value),
  });
  const clear = (): void => {
    input.value = "";
    filter.set("");
    input.focus?.();
  };
  bindSearchShortcut(input, () => filter.set(""), isActive);
  // Keep the status live region exposed in the accessibility tree even while
  // inactive (visually-hidden rather than display: none) so the very first
  // filter keystroke or paste is announced reliably by screen readers.
  const count = h("span", {
    class: "filter-count visually-hidden",
    role: "status",
    "aria-live": "polite",
  });
  const clearButton = h(
    "button",
    {
      class: "btn btn--ghost btn--sm",
      type: "button",
      "aria-label": tr("絞り込みをクリア", "Clear filter"),
      hidden: true,
      onClick: clear,
    },
    tr("クリア", "Clear"),
  );
  effect(() => {
    const active = filter() !== "";
    count.className = active ? "filter-count" : "filter-count visually-hidden";
    clearButton.hidden = !active;
    count.replaceChildren(
      active ? text(tr(`${matched()} / ${total()} 件`, `${matched()} of ${total()}`)) : text(""),
    );
  });
  return {
    clear,
    element: h(
      "div",
      { class: "toolbar" },
      h(
        "div",
        { class: "search-box" },
        input,
        h("kbd", { class: "kbd-hint", "aria-hidden": "true" }, "/"),
      ),
      count,
      clearButton,
    ),
  };
}

function table(
  apiKeys: readonly ApiKey[],
  organizationId: string,
  reload: () => void,
  onClearFilter?: () => void,
): Child {
  if (apiKeys.length === 0) {
    return empty(
      tr("一致するAPIキーがありません", "No matching keys"),
      tr("この条件に一致するAPIキーはありません。", "Nothing here matches that filter."),
      onClearFilter
        ? h(
            "button",
            { class: "btn btn--sm", type: "button", onClick: onClearFilter },
            tr("絞り込みをクリア", "Clear filter"),
          )
        : null,
    );
  }
  return h(
    "table",
    { class: "keys-table", role: "table" },
    h(
      "thead",
      { role: "rowgroup" },
      h(
        "tr",
        { role: "row" },
        h("th", { role: "columnheader" }, tr("名前", "Name")),
        h("th", { role: "columnheader" }, tr("スコープ", "Scopes")),
        h("th", { role: "columnheader" }, tr("作成日時", "Created")),
        h("th", { role: "columnheader" }, tr("有効期限", "Expires")),
        h(
          "th",
          { role: "columnheader" },
          h("span", { class: "visually-hidden" }, tr("操作", "Actions")),
        ),
      ),
    ),
    h(
      "tbody",
      { role: "rowgroup" },
      ...apiKeys.map((key) => {
        const expired = new Date(key.expiresAt).getTime() < Date.now();
        return h(
          "tr",
          { role: "row" },
          h(
            "td",
            { class: "keys-name", role: "cell" },
            h("div", null, key.name),
            h("div", { style: { marginTop: "3px" } }, copyable(key.id)),
          ),
          h(
            "td",
            { class: "keys-scopes", role: "cell", "data-label": tr("スコープ", "Scopes") },
            h("div", { class: "keys-scopes__list" }, ...key.scopes.map((scope) => badge(scope))),
          ),
          h(
            "td",
            { class: "dim", role: "cell", "data-label": tr("作成日時", "Created") },
            when(key.createdAt),
          ),
          h(
            "td",
            { role: "cell", "data-label": tr("有効期限", "Expires") },
            expired
              ? badge(tr("期限切れ", "expired"), "bad")
              : h("span", { class: "dim" }, when(key.expiresAt)),
          ),
          h(
            "td",
            { class: "keys-actions", role: "cell", style: { textAlign: "right" } },
            h(
              "button",
              {
                class: "btn btn--sm btn--danger",
                type: "button",
                "aria-label": tr(`${key.name}を失効`, `Revoke ${key.name}`),
                onClick: () => revoke(organizationId, key, reload),
              },
              tr("失効", "Revoke"),
            ),
          ),
        );
      }),
    ),
  );
}

function revoke(organizationId: string, key: ApiKey, reload: () => void): void {
  const isScopeCurrent = captureSelectedOrganizationScope(organizationId);
  const options: ModalOptions = {
    title: tr(`${key.name}を失効しますか？`, `Revoke ${key.name}?`),
    confirmLabel: tr("キーを失効", "Revoke key"),
    confirmTone: "danger",
    body: h(
      "div",
      { class: "notice notice--bad" },
      icon(ICON.alert, 15),
      h(
        "div",
        null,
        tr(
          "このキーを利用する処理は直ちに停止します。元に戻せないため、必要な場合は新しいキーを発行してください。",
          "Anything using this key stops working immediately. This cannot be undone; issue a new key instead.",
        ),
      ),
    ),
    onConfirm: async () => {
      if (!modal.isCurrent()) return;
      try {
        await api.revokeApiKey(organizationId, key.id);
        if (!modal.isCurrent()) return;
        toast(tr("キーを失効しました", "Key revoked"), "ok");
        reload();
        modal.close();
      } catch (error) {
        if (modal.isCurrent()) toast(explain(error as Error), "bad");
      }
    },
  };
  const modal = openScopedKeyModal(options, isScopeCurrent);
}

function createKey(
  organizationId: string,
  reload: () => void,
  aiAvailable: () => boolean,
  v2Endpoint: string,
): void {
  const isScopeCurrent = captureSelectedOrganizationScope(organizationId);
  const isSessionCurrent = captureSessionScope();
  const nameError = h("div", {
    class: "field__error",
    id: "create-key-name-error",
    hidden: true,
  });
  const scopesError = h("div", {
    class: "field__error",
    id: "create-key-scopes-error",
    hidden: true,
  });
  const name = h("input", {
    class: "input",
    id: "create-key-name",
    name: "name",
    placeholder: "deploy pipeline",
    autocomplete: "off",
    "aria-describedby": "create-key-name-hint",
    onInput: () => {
      if (name.value.trim() !== "") {
        setFieldError(name, nameError, null, ["create-key-name-hint"]);
      }
    },
  });
  const chosen = new Set<string>(DEFAULT_KEY_SCOPES);
  const scopeBoxes: HTMLInputElement[] = [];
  const aiFields: HTMLFieldSetElement[] = [];
  const aiBoxes: HTMLInputElement[] = [];
  const lifetime = h(
    "select",
    { class: "select", id: "create-key-lifetime", name: "lifetime", autocomplete: "off" },
    ...LIFETIMES.map((option, index) =>
      h(
        "option",
        { value: String(option.seconds), ...(index === 1 ? { selected: true } : {}) },
        option.label(),
      ),
    ),
  );

  const options: ModalOptions = {
    title: tr("APIキーを作成", "Create API key"),
    confirmLabel: tr("キーを作成", "Create key"),
    body: h(
      "div",
      { style: { display: "grid", gap: "16px" } },
      h(
        "div",
        { class: "field" },
        h("label", { for: "create-key-name" }, tr("名前", "Name")),
        name,
        nameError,
        h(
          "small",
          { id: "create-key-name-hint" },
          tr(
            "キーの用途を入力します。この名前は一覧だけに表示されます。",
            "What this key is for. It appears in the list and nowhere else.",
          ),
        ),
      ),
      h(
        "div",
        { class: "field" },
        h("span", { class: "field__label" }, tr("スコープ", "Scopes")),
        ...keyScopeGroups(true).map((group) => {
          const field = h(
            "fieldset",
            { class: "checks" },
            h("legend", null, group.label()),
            ...group.scopes.map((scope) => {
              const box = h("input", {
                type: "checkbox",
                name: "scope",
                value: scope.id,
                ...(chosen.has(scope.id) ? { checked: true } : {}),
                onChange: (event: Event) => {
                  if ((event.target as HTMLInputElement).checked) chosen.add(scope.id);
                  else chosen.delete(scope.id);
                  if (chosen.size > 0) {
                    scopesError.hidden = true;
                    if (typeof scopesError.removeAttribute === "function") {
                      scopesError.removeAttribute("role");
                    }
                    scopesError.replaceChildren();
                  }
                },
              });
              scopeBoxes.push(box);
              if (scope.id === "ai:invoke") aiBoxes.push(box);
              return h(
                "label",
                { class: "check" },
                box,
                h(
                  "span",
                  { class: "check__text" },
                  h("span", { class: "mono check__id" }, scope.id),
                  h("small", null, scope.blurb()),
                ),
              );
            }),
          );
          if (group.scopes.some((scope) => scope.id === "ai:invoke")) aiFields.push(field);
          return field;
        }),
        scopesError,
        h(
          "small",
          null,
          tr(
            "必要なスコープだけを付与してください。後から権限を拡張することはできません。",
            "Grant only what the caller needs. Scopes cannot be widened later.",
          ),
        ),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { for: "create-key-lifetime" }, tr("有効期間", "Expires in")),
        lifetime,
      ),
    ),
    onConfirm: async () => {
      if (!modal.isCurrent()) return;
      if (name.value.trim() === "") {
        const message = tr("キー名を入力してください", "Give the key a name");
        setFieldError(name, nameError, message, ["create-key-name-hint"]);
        name.focus?.();
        toast(message, "bad");
        return;
      }
      setFieldError(name, nameError, null, ["create-key-name-hint"]);
      if (chosen.size === 0) {
        const message = tr("スコープを1つ以上選択してください", "Choose at least one scope");
        scopesError.hidden = false;
        if (typeof scopesError.setAttribute === "function")
          scopesError.setAttribute("role", "alert");
        scopesError.replaceChildren(text(message));
        scopeBoxes.find((box) => !box.disabled && !box.closest?.("[hidden]"))?.focus?.();
        toast(message, "bad");
        return;
      }
      scopesError.hidden = true;
      if (typeof scopesError.removeAttribute === "function") scopesError.removeAttribute("role");
      scopesError.replaceChildren();
      const requestedName = name.value.trim();
      try {
        const created = await api.createApiKey(organizationId, {
          name: requestedName,
          scopes: [...chosen],
          expiresInSeconds: Number(lifetime.value),
        });
        if (!modal.isCurrent()) {
          rememberUnshownKey(created.apiKey, organizationId, requestedName, isSessionCurrent);
          return;
        }
        modal.close();
        reload();
        revealSecret(organizationId, created.apiKey, created.secret, v2Endpoint, isScopeCurrent);
      } catch (error) {
        if (modal.isCurrent()) toast(explain(error as Error), "bad");
      }
    },
  };
  const stopDiscovery = effect(() => {
    const available = aiAvailable();
    for (const field of aiFields) {
      field.hidden = !available;
      field.disabled = !available;
      field.style.display = available ? "" : "none";
    }
    if (!available) {
      chosen.delete("ai:invoke");
      for (const box of aiBoxes) box.checked = false;
    }
  });
  const modal = openScopedKeyModal({ ...options, onClose: stopDiscovery }, isScopeCurrent);
}

function openScopedKeyModal(options: ModalOptions, isScopeCurrent: () => boolean) {
  const openedRoute = route();
  const isCurrent = (): boolean => route() === openedRoute && isScopeCurrent();
  let open = true;
  let stop = (): void => {};
  const lifetime: KeyModalLifetime = { close: null };
  const close = openModal({
    ...options,
    onClose: () => {
      open = false;
      lifetime.close = null;
      stop();
      options.onClose?.();
    },
  });
  lifetime.close = close;
  stop = watchKeyModalScope(isCurrent, lifetime);
  // An already-retired page may open a dialog before the first effect runs.
  if (!open) stop();
  return { close, isCurrent: () => open && isCurrent() };
}

interface KeyModalLifetime {
  close: (() => void) | null;
}

// Keep the watcher outside the modal's lexical scope. Closing clears its modal
// reference and disposes the signal subscriptions.
function watchKeyModalScope(isScopeCurrent: () => boolean, lifetime: KeyModalLifetime): () => void {
  return effect(() => {
    if (!isScopeCurrent()) lifetime.close?.();
  });
}

const INSTALL_GUIDE_STEPS =
  "https://github.com/tako0614/takoserver/blob/main/docs/self-host-operations.md#8-create-and-serve-a-worker";

function revealSecret(
  organizationId: string,
  key: ApiKey,
  secret: string,
  v2Endpoint: string,
  isScopeCurrent: () => boolean,
): void {
  const usage = keyUsage(v2Endpoint, organizationId, key.scopes);
  const options: ModalOptions = {
    title: tr("今すぐキーをコピーしてください", "Copy this key now"),
    dismissLabel: tr("完了", "Done"),
    // The secret is shown once; a click beside the dialog must not throw it away.
    dismissOnBackdrop: false,
    body: h(
      "div",
      { style: { display: "grid", gap: "14px" } },
      h(
        "div",
        { class: "notice notice--warn" },
        icon(ICON.alert, 15),
        h(
          "div",
          null,
          tr(
            "Takoserverはこのシークレットのダイジェストだけを保存します。再表示できないため、紛失した場合は失効して新しいキーを作成してください。",
            "Takoserver stores only a digest of this secret. It cannot be shown again — if it is lost, revoke the key and create another.",
          ),
        ),
      ),
      h(
        "div",
        { class: "field" },
        h("span", { class: "field__label" }, key.name),
        h(
          "div",
          {
            class: "json",
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "10px",
            },
          },
          // A zero basis lets the secret wrap before the copy button gives up any width.
          h(
            "span",
            { class: "mono", style: { wordBreak: "break-all", flex: "1", minWidth: "0" } },
            secret,
          ),
          copyable(secret, tr("キーをコピー", "copy key")),
        ),
      ),
      usage === null
        ? null
        : h(
            "div",
            { class: "field" },
            h(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "10px",
                },
              },
              h("span", { class: "field__label" }, tr("使い方", "Use it")),
              copyable(usage, tr("コマンドをコピー", "copy commands")),
            ),
            // One command per line, as the shell reads it: scroll rather than wrap.
            h(
              "pre",
              {
                class: "json",
                tabindex: "0",
                style: { whiteSpace: "pre", overflowWrap: "normal" },
              },
              usage,
            ),
            h(
              "small",
              null,
              tr(
                "実行すると「API key:」と表示されるので、キーを貼り付けてEnterを押します。キーは画面に表示されず、シェルの履歴にも残りません。このコマンドは組織のリソースを一覧表示します。",
                "Run it, paste the key at the API key: prompt and press Enter. The key is not shown and stays out of shell history. The command lists the organization's Resources.",
              ),
            ),
            h(
              "small",
              null,
              tr("作成と削除は", ""),
              h(
                "a",
                { href: INSTALL_GUIDE_STEPS, target: "_blank", rel: "noopener noreferrer" },
                tr("導入手順書（英語）の手順8〜13", "Steps 8 to 13 of the install guide"),
                h("span", { "aria-hidden": "true" }, " ↗"),
                h(
                  "span",
                  { class: "visually-hidden" },
                  tr("（新しいタブで開きます）", " (opens in a new tab)"),
                ),
              ),
              tr(
                "にあります。手順5の変数Fと、手順6で用意した成果物も使います。",
                " create and delete them, using F from step 5 and the artifacts seeded in step 6.",
              ),
            ),
          ),
    ),
  };
  openScopedKeyModal(options, isScopeCurrent);
}
