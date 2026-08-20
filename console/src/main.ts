import { type Child, h, live, text } from "./dom.ts";
import { readGoogleReturn } from "./google.ts";
import {
  consoleLocale,
  consoleNavigation,
  setConsoleLocale,
  syncConsoleLocale,
  tr,
} from "./i18n.ts";
import { wordmark } from "./mark.ts";
import { billingPage } from "./pages/billing.ts";
import { keysPage } from "./pages/keys.ts";
import { overviewPage } from "./pages/overview.ts";
import { resourceDetailPage } from "./pages/resource-detail.ts";
import { resourcesPage } from "./pages/resources.ts";
import { settingsPage } from "./pages/settings.ts";
import { signInPage } from "./pages/signin.ts";
import { effect, signal } from "./reactive.ts";
import { linkProps, navigate, route } from "./router.ts";
import {
  adoptSession,
  api,
  applyTheme,
  currentOrganization,
  organizations,
  principal,
  selectOrganization,
  session,
  signOut,
  theme,
} from "./state.ts";
import { card, empty, explain, ICON, icon, mountToasts, openModal, toast } from "./ui.ts";

/**
 * The console.
 *
 * Two shapes only: signed out, which is one screen, and signed in, which is a
 * persistent frame around a page chosen by the URL. The frame is built once;
 * only the region inside it is rebuilt when the route or the session moves,
 * so scroll position and focus in the navigation survive a page change.
 */

const railOpen = signal(false);

function boot(): void {
  syncConsoleLocale();
  const root = document.getElementById("root");
  if (!root) throw new Error("console root is missing");
  root.append(mountToasts());

  // Google may have just sent this browser back with a token in the fragment.
  // It is read and cleared before anything renders, so a reload cannot replay
  // a sign-in and the token never sits in the address bar.
  const returned = readGoogleReturn();
  if (returned.kind === "error") {
    toast(returned.message, "bad");
  } else if (returned.kind === "ok") {
    api.signIn("google", returned.value.idToken, "oidc", returned.value.nonce).then(
      ({ sessionToken }) => {
        adoptSession(sessionToken);
        navigate(returned.value.from, { replace: true });
      },
      (error: unknown) => toast(explain(error as Error), "bad"),
    );
  }

  const view = h("div");
  root.append(view);

  // Whoever is signed in is loaded once per session token, not per page: the
  // navigation needs it, and re-asking on every route change would make the
  // organization picker flicker on a screen that never changed.
  effect(() => {
    const token = session();
    if (!token) {
      principal.set(null);
      organizations.set([]);
      return;
    }
    api.me().then(
      (me) => {
        principal.set(me.principal);
        organizations.set(me.organizations);
      },
      (error: unknown) => {
        if ((error as { isExpiredSession?: boolean }).isExpiredSession !== true) {
          toast(explain(error as Error), "bad");
        }
      },
    );
  });

  effect(() => {
    const screen = session() ? shell() : signInPage();
    view.replaceChildren(screen instanceof Node ? screen : document.createTextNode(""));
  });
}

function shell(): Child {
  return h(
    "div",
    { class: "shell" },
    h("div", { class: "brand" }, h("a", { ...linkProps("/") }, wordmark(22))),
    topbar(),
    live(() =>
      h(
        "nav",
        {
          class: railOpen() ? "rail rail--open" : "rail",
          "aria-label": tr("セクション", "Sections"),
        },
        ...consoleNavigation(consoleLocale()).flatMap((section) => [
          h("div", { class: "rail__group" }, section.group),
          ...section.items.map((item) => railLink(item.href, item.label, ICON[item.glyph])),
        ]),
      ),
    ),
    h("main", { class: "main" }, live(page)),
  );
}

function railLink(href: string, label: string, glyph: string): Child {
  const here = route().path;
  const active = href === "/" ? here === "/" : here === href || here.startsWith(`${href}/`);
  return h(
    "a",
    {
      class: "rail__link",
      ...(active ? { "aria-current": "page" } : {}),
      ...linkProps(href),
      onClick: (event: MouseEvent) => {
        railOpen.set(false);
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(href);
      },
    },
    icon(glyph, 16),
    text(label),
  );
}

function topbar(): Child {
  return h(
    "div",
    { class: "topbar" },
    live(organizationPicker),
    h("div", { class: "topbar__spacer" }),
    live(() =>
      h(
        "button",
        {
          class: "btn btn--ghost btn--sm",
          type: "button",
          title: tr("英語に切り替える", "Switch to Japanese"),
          "aria-label": tr("英語に切り替える", "Switch to Japanese"),
          onClick: () => setConsoleLocale(consoleLocale() === "ja" ? "en" : "ja"),
        },
        consoleLocale() === "ja" ? "EN" : "日本語",
      ),
    ),
    live(() =>
      h(
        "button",
        {
          class: "btn btn--ghost btn--sm",
          type: "button",
          title: `${tr("テーマ", "Theme")}: ${theme()}`,
          "aria-label": `${tr("テーマ", "Theme")}: ${theme()}`,
          onClick: () => applyTheme(theme() === "dark" ? "light" : "dark"),
        },
        icon(theme() === "dark" ? ICON.sun : ICON.moon, 16),
      ),
    ),
    live(() => {
      const who = principal();
      return h(
        "button",
        {
          class: "btn btn--ghost btn--sm",
          type: "button",
          title: who
            ? `${who.displayName} — ${tr("サインアウト", "sign out")}`
            : tr("サインアウト", "Sign out"),
          onClick: signOut,
        },
        icon(ICON.out, 15),
        text(who ? who.displayName : tr("サインアウト", "Sign out")),
      );
    }),
  );
}

function organizationPicker(): Child {
  const all = organizations();
  const current = currentOrganization();
  if (all.length === 0) {
    return h(
      "button",
      { class: "btn btn--sm btn--primary", type: "button", onClick: createOrganization },
      icon(ICON.plus, 13),
      text(tr("組織を作成", "Create organization")),
    );
  }
  return h(
    "div",
    { style: { display: "flex", alignItems: "center", gap: "8px" } },
    h(
      "select",
      {
        class: "select",
        style: { width: "auto", padding: "5px 9px" },
        "aria-label": tr("組織", "Organization"),
        onChange: (event: Event) => selectOrganization((event.target as HTMLSelectElement).value),
      },
      ...all.map((organization) =>
        h(
          "option",
          {
            value: organization.id,
            ...(organization.id === current?.id ? { selected: true } : {}),
          },
          organization.name,
        ),
      ),
    ),
    h(
      "button",
      {
        class: "btn btn--ghost btn--sm",
        type: "button",
        title: tr("組織を作成", "Create organization"),
        "aria-label": tr("組織を作成", "Create organization"),
        onClick: createOrganization,
      },
      icon(ICON.plus, 15),
    ),
  );
}

function createOrganization(): void {
  const name = h("input", { class: "input", placeholder: tr("本番環境", "Acme production") });
  const close = openModal({
    title: tr("組織を作成", "Create organization"),
    confirmLabel: tr("作成", "Create"),
    body: h(
      "div",
      { class: "field" },
      h("label", null, tr("名前", "Name")),
      name,
      h(
        "small",
        null,
        tr(
          "組織ごとに残高、キー、リソースを所有し、ほかの組織とは共有されません。",
          "An organization owns its own wallet, keys, and resources. Nothing is shared between them.",
        ),
      ),
    ),
    onConfirm: async () => {
      if (name.value.trim() === "") {
        toast(tr("組織名を入力してください", "Give the organization a name"), "bad");
        return;
      }
      try {
        const { organization } = await api.createOrganization(name.value.trim());
        organizations.update((all) => [...all, organization]);
        selectOrganization(organization.id);
        toast(tr("組織を作成しました", "Organization created"), "ok");
        close();
      } catch (error) {
        toast(explain(error as Error), "bad");
      }
    },
  });
}

/** The page for the current URL, or an honest account of why there is none. */
function page(): Child {
  const here = route();
  const organization = currentOrganization();

  if (!organization) {
    return card(
      null,
      empty(
        tr("組織がありません", "No organization yet"),
        tr(
          "Consoleの残高、キー、リソースは組織単位で管理されます。最初の組織を作成してください。",
          "Everything in this console belongs to an organization — a wallet, its keys, and the resources it declares. Create one to begin.",
        ),
        h(
          "button",
          { class: "btn btn--primary", type: "button", onClick: createOrganization },
          tr("組織を作成", "Create organization"),
        ),
      ),
    );
  }

  const [first, ...rest] = here.segments;
  switch (first) {
    case undefined:
      return overviewPage(organization);
    case "resources":
      return rest.length >= 3
        ? resourceDetailPage(organization.id, {
            space: rest[0] as string,
            kind: rest[1] as string,
            name: rest[2] as string,
          })
        : resourcesPage(organization.id);
    case "billing":
      return billingPage(organization.id);
    case "keys":
      return keysPage(organization.id);
    case "settings":
      return settingsPage(organization);
    default:
      return card(
        null,
        empty(
          tr("ページがありません", "No such page"),
          tr(`${here.path} にはページがありません。`, `Nothing is served at ${here.path}.`),
          h("a", { class: "btn", ...linkProps("/") }, tr("概要へ戻る", "Go to overview")),
        ),
      );
  }
}

boot();
