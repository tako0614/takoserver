import { type Child, h, svg, text } from "./dom.ts";
import type { Async } from "./reactive.ts";
import { signal } from "./reactive.ts";

/** The pieces every screen is built from. */

export const ICON = {
  home: "M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5",
  layers: "M12 3 3 8l9 5 9-5-9-5ZM3 13l9 5 9-5M3 17.5l9 5 9-5",
  wallet:
    "M3 7.5A2.5 2.5 0 0 1 5.5 5H18v3M3 7.5V17a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2M3 7.5h16a2 2 0 0 1 2 2V15m0 0h-4a1.5 1.5 0 0 1 0-3h4",
  key: "M15.5 3a5.5 5.5 0 1 0-4.9 8L9 12.6V15H6.5v2.5H4V21h4l7-7a5.5 5.5 0 0 0 .5-11Zm1.5 4.5h.01",
  tag: "M3 12V4.5A1.5 1.5 0 0 1 4.5 3H12l9 9-7.5 7.5L3 12Zm4-5.5h.01",
  form: "M4 4h16v16H4zM8 9h8M8 13h8M8 17h4",
  activity: "M3 12h3.5L9 5l4 14 2.5-7H21",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
  copy: "M9 9h10v10H9zM5 15V5h10",
  check: "m4.5 12.5 5 5 10-11",
  sun: "M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7 1.4-1.4M4.9 19.1l1.4-1.4m0-11.4L4.9 4.9m14.2 14.2-1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  moon: "M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z",
  monitor: "M3 5h18v11H3zM9 20h6M12 16v4",
  chevron: "m9 5 7 7-7 7",
  menu: "M4 7h16M4 12h16M4 17h16",
  plus: "M12 5v14M5 12h14",
  refresh: "M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5",
  out: "M15 3h6v6M21 3l-9 9M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5",
  alert:
    "M12 8v5m0 3h.01M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
} as const;

export function icon(path: string, size = 16): SVGSVGElement {
  return svg(path, size);
}

export function badge(
  label: string,
  tone: "ok" | "warn" | "bad" | "accent" | "idle" = "idle",
  withDot = false,
): HTMLElement {
  return h(
    "span",
    { class: tone === "idle" ? "badge" : `badge badge--${tone}` },
    withDot ? h("i", { class: "dot" }) : null,
    text(label),
  );
}

/**
 * An identifier the reader can take with them.
 *
 * Digests, uids and key ids exist to be pasted somewhere else. Showing one
 * without a way to copy it exactly invites a person to retype 64 hex
 * characters, and that is a defect however good the rest of the page is.
 */
export function copyable(value: string, display?: string): HTMLElement {
  const label = h("span", { class: "mono truncate" }, display ?? value);
  const mark = h("span", { class: "copy__icon" }, icon(ICON.copy, 13));
  const button = h(
    "button",
    {
      class: "copy",
      type: "button",
      title: `Copy ${value}`,
      onClick: (event: Event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(value).then(
          () => {
            mark.replaceChildren(icon(ICON.check, 13));
            toast("Copied", "ok");
            setTimeout(() => mark.replaceChildren(icon(ICON.copy, 13)), 1_400);
          },
          () => toast("The browser refused clipboard access", "bad"),
        );
      },
    },
    label,
    mark,
  );
  return button;
}

export function card(title: Child, body: Child, actions?: Child): HTMLElement {
  return h(
    "section",
    { class: "card" },
    title === null
      ? null
      : h(
          "header",
          { class: "card__head" },
          h("div", { class: "card__title" }, title),
          h("div", { style: { flex: "1" } }),
          actions ?? null,
        ),
    body,
  );
}

export function stat(label: string, value: Child, note?: Child): HTMLElement {
  return h(
    "div",
    { class: "card" },
    h(
      "div",
      { class: "card__body" },
      h("div", { class: "stat__label" }, label),
      h("div", { class: "stat__value" }, value),
      note ? h("div", { class: "stat__note" }, note) : null,
    ),
  );
}

export function empty(title: string, body: Child, action?: Child): HTMLElement {
  return h(
    "div",
    { class: "empty" },
    h("div", { class: "empty__title" }, title),
    h("div", { class: "empty__body" }, body),
    action ? h("div", { style: { marginTop: "14px" } }, action) : null,
  );
}

export function skeletonRows(count = 4): HTMLElement {
  return h(
    "div",
    { class: "card__body", style: { display: "grid", gap: "12px" } },
    ...Array.from({ length: count }, (_, index) =>
      h("div", { class: "skeleton", style: { width: `${100 - index * 9}%` } }),
    ),
  );
}

/**
 * Renders the three states a request can be in.
 *
 * Screens call this instead of testing `state` themselves, so a page cannot
 * accidentally render a spinner forever, or an emptiness that is really a
 * failure to ask.
 */
export function whenReady<Value>(
  async: Async<Value>,
  ready: (value: Value) => Child,
  options: { readonly retry?: () => void; readonly skeleton?: Child } = {},
): Child {
  if (async.state === "loading") return options.skeleton ?? skeletonRows();
  if (async.state === "error") {
    return h(
      "div",
      { class: "card__body" },
      h(
        "div",
        { class: "notice notice--bad" },
        icon(ICON.alert),
        h("div", null, explain(async.error)),
      ),
      options.retry
        ? h(
            "div",
            { style: { marginTop: "12px" } },
            h(
              "button",
              { class: "btn btn--sm", type: "button", onClick: options.retry },
              icon(ICON.refresh, 13),
              text("Try again"),
            ),
          )
        : null,
    );
  }
  return ready(async.value);
}

/**
 * Turns an error into something a person can act on.
 *
 * The server's codes are stable and terse; a console that prints them raw
 * makes every failure look like a bug. Anything unrecognised is shown as
 * itself rather than flattened into "something went wrong", because the code
 * is what someone would quote when asking for help.
 */
export function explain(error: Error): string {
  const code = (error as { code?: string }).code ?? error.message;
  const known: Record<string, string> = {
    unreachable: "Could not reach the API. Check the origin and your connection.",
    unauthenticated: "Your session is no longer valid. Sign in again.",
    permission_denied: "This account is not allowed to do that.",
    not_found: "That does not exist, or is not yours.",
    invalid_argument: "The request was not accepted as written.",
    insufficient_funds: "The wallet does not hold enough available balance.",
    form_unknown: "No installed Form matches that exact reference.",
    conflict: "Something else changed this first. Reload and try again.",
  };
  return known[code] ?? `The server refused this: ${code}`;
}

/* ------------------------------------------------------------------ json -- */

/**
 * Pretty-printed JSON with the structure coloured.
 *
 * Built from text nodes, never markup: the values here are a customer's own
 * declarations, and a resource whose name contains a tag must render as that
 * name rather than as a tag.
 */
export function jsonBlock(value: unknown): HTMLElement {
  const pre = h("pre", { class: "json" });
  write(pre, value, 0);
  return pre;
}

function write(into: HTMLElement, value: unknown, depth: number): void {
  const pad = "  ".repeat(depth);
  const padInner = "  ".repeat(depth + 1);
  if (value === null || typeof value === "boolean") {
    into.append(h("span", { class: "json__atom" }, String(value)));
    return;
  }
  if (typeof value === "number") {
    into.append(h("span", { class: "json__number" }, String(value)));
    return;
  }
  if (typeof value === "string") {
    into.append(h("span", { class: "json__string" }, JSON.stringify(value)));
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      into.append(text("[]"));
      return;
    }
    into.append(text("[\n"));
    value.forEach((item, index) => {
      into.append(text(padInner));
      write(into, item, depth + 1);
      into.append(text(index === value.length - 1 ? "\n" : ",\n"));
    });
    into.append(text(`${pad}]`));
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    into.append(text("{}"));
    return;
  }
  into.append(text("{\n"));
  entries.forEach(([key, item], index) => {
    into.append(text(padInner));
    into.append(h("span", { class: "json__key" }, JSON.stringify(key)));
    into.append(text(": "));
    write(into, item, depth + 1);
    into.append(text(index === entries.length - 1 ? "\n" : ",\n"));
  });
  into.append(text(`${pad}}`));
}

/* ----------------------------------------------------------------- modal -- */

export interface ModalOptions {
  readonly title: string;
  readonly body: Child;
  readonly confirmLabel?: string;
  readonly confirmTone?: "primary" | "danger";
  readonly onConfirm?: () => void | Promise<void>;
  readonly dismissLabel?: string;
}

export function openModal(options: ModalOptions): () => void {
  const close = (): void => {
    scrim.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };

  let confirm: HTMLButtonElement | null = null;
  if (options.onConfirm) {
    const button = h("button", {
      class: `btn btn--${options.confirmTone ?? "primary"}`,
      type: "button",
    });
    button.append(options.confirmLabel ?? "Confirm");
    // A confirm that talks to the server disables itself while it does, so a
    // second click cannot issue the same mutation twice.
    button.addEventListener("click", () => {
      const done = options.onConfirm?.();
      if (done instanceof Promise) {
        button.disabled = true;
        void done.finally(() => {
          button.disabled = false;
        });
      }
    });
    confirm = button;
  }

  const scrim = h(
    "div",
    {
      class: "scrim",
      onClick: (event: MouseEvent) => {
        if (event.target === scrim) close();
      },
    },
    h(
      "div",
      { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": options.title },
      h("header", { class: "modal__head" }, options.title),
      h("div", { class: "modal__body" }, options.body),
      h(
        "footer",
        { class: "modal__foot" },
        h(
          "button",
          { class: "btn", type: "button", onClick: close },
          options.dismissLabel ?? "Cancel",
        ),
        confirm,
      ),
    ),
  );

  document.body.append(scrim);
  document.addEventListener("keydown", onKey);
  scrim.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
  return close;
}

/* ---------------------------------------------------------------- toasts -- */

const toastHost = signal<HTMLElement | null>(null);

export function mountToasts(): HTMLElement {
  const host = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
  toastHost.set(host);
  return host;
}

export function toast(message: string, tone: "ok" | "bad" | "plain" = "plain"): void {
  const host = toastHost();
  if (!host) return;
  const node = h(
    "div",
    { class: tone === "plain" ? "toast" : `toast toast--${tone}` },
    tone === "bad" ? icon(ICON.alert, 15) : tone === "ok" ? icon(ICON.check, 15) : null,
    text(message),
  );
  host.append(node);
  setTimeout(() => node.remove(), 4_000);
}

/* ------------------------------------------------------------- formatting -- */

/** Minor units are the ledger's truth; a person reads currency. */
export function money(minor: number, currency = "USD"): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(minor / 100);
}

export function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "3 minutes ago", for the columns where recency is the point. */
export function ago(iso: string): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return iso;
  const seconds = Math.round((at - Date.now()) / 1_000);
  const steps: readonly [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.35],
    ["month", 12],
    ["year", Number.POSITIVE_INFINITY],
  ];
  let value = seconds;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) {
      return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
        Math.round(value),
        unit,
      );
    }
    value /= size;
  }
  return when(iso);
}

export function shortDigest(digest: string): string {
  const [algorithm, hex] = digest.split(":");
  return hex ? `${algorithm}:${hex.slice(0, 12)}…` : digest;
}
