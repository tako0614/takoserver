import { type Child, h, live, text } from "./dom.ts";
import { wordmark } from "./mark.ts";
import { billingPage } from "./pages/billing.ts";
import { catalogPage } from "./pages/catalog.ts";
import { formsPage } from "./pages/forms.ts";
import { keysPage } from "./pages/keys.ts";
import { overviewPage } from "./pages/overview.ts";
import { resourceDetailPage } from "./pages/resource-detail.ts";
import { resourcesPage } from "./pages/resources.ts";
import { settingsPage } from "./pages/settings.ts";
import { signInPage } from "./pages/signin.ts";
import { effect, signal } from "./reactive.ts";
import { linkProps, navigate, route } from "./router.ts";
import {
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

const NAV = [
  { group: "Overview", items: [{ href: "/", label: "Home", glyph: ICON.home }] },
  {
    group: "Takoform",
    items: [
      { href: "/resources", label: "Resources", glyph: ICON.layers },
      { href: "/forms", label: "Forms", glyph: ICON.form },
      { href: "/catalog", label: "Catalog", glyph: ICON.tag },
    ],
  },
  {
    group: "Account",
    items: [
      { href: "/billing", label: "Billing", glyph: ICON.wallet },
      { href: "/keys", label: "API keys", glyph: ICON.key },
      { href: "/settings", label: "Settings", glyph: ICON.gear },
    ],
  },
] as const;

const railOpen = signal(false);

function boot(): void {
  const root = document.getElementById("root");
  if (!root) throw new Error("console root is missing");
  root.append(mountToasts());

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
        { class: railOpen() ? "rail rail--open" : "rail", "aria-label": "Sections" },
        ...NAV.flatMap((section) => [
          h("div", { class: "rail__group" }, section.group),
          ...section.items.map((item) => railLink(item.href, item.label, item.glyph)),
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
          title: `Theme: ${theme()}`,
          "aria-label": `Theme: ${theme()}`,
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
          title: who ? `${who.displayName} — sign out` : "Sign out",
          onClick: signOut,
        },
        icon(ICON.out, 15),
        text(who ? who.displayName : "Sign out"),
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
      text("Create organization"),
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
        "aria-label": "Organization",
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
        title: "Create organization",
        "aria-label": "Create organization",
        onClick: createOrganization,
      },
      icon(ICON.plus, 15),
    ),
  );
}

function createOrganization(): void {
  const name = h("input", { class: "input", placeholder: "Acme production" });
  const close = openModal({
    title: "Create organization",
    confirmLabel: "Create",
    body: h(
      "div",
      { class: "field" },
      h("label", null, "Name"),
      name,
      h(
        "small",
        null,
        "An organization owns its own wallet, keys, and resources. Nothing is shared between them.",
      ),
    ),
    onConfirm: async () => {
      if (name.value.trim() === "") {
        toast("Give the organization a name", "bad");
        return;
      }
      try {
        const { organization } = await api.createOrganization(name.value.trim());
        organizations.update((all) => [...all, organization]);
        selectOrganization(organization.id);
        toast("Organization created", "ok");
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

  if (here.segments[0] === "forms") return formsPage();

  if (!organization) {
    return card(
      null,
      empty(
        "No organization yet",
        "Everything in this console belongs to an organization — a wallet, its keys, and the resources it declares. Create one to begin.",
        h(
          "button",
          { class: "btn btn--primary", type: "button", onClick: createOrganization },
          "Create organization",
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
    case "catalog":
      return catalogPage(organization.id);
    case "settings":
      return settingsPage(organization);
    default:
      return card(
        null,
        empty(
          "No such page",
          `Nothing is served at ${here.path}.`,
          h("a", { class: "btn", ...linkProps("/") }, "Go to overview"),
        ),
      );
  }
}

boot();
