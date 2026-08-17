import { signal } from "./reactive.ts";

/**
 * Real URLs, because a console page is a place.
 *
 * Every screen is addressable, so a resource can be linked to in a ticket and
 * the back button means what it says. The asset host serves `index.html` for
 * unknown paths, which is what makes a deep link survive a cold load.
 */

export interface Route {
  readonly path: string;
  readonly segments: readonly string[];
  readonly query: URLSearchParams;
}

function read(): Route {
  const url = new URL(window.location.href);
  const path = url.pathname.replace(/\/+$/u, "") || "/";
  return {
    path,
    segments: path
      .split("/")
      .filter((segment) => segment !== "")
      .map(decodeURIComponent),
    query: url.searchParams,
  };
}

export const route = signal<Route>(read());

window.addEventListener("popstate", () => route.set(read()));

export function navigate(path: string, options: { readonly replace?: boolean } = {}): void {
  if (path === window.location.pathname + window.location.search) return;
  window.history[options.replace ? "replaceState" : "pushState"]({}, "", path);
  route.set(read());
  window.scrollTo({ top: 0 });
}

/**
 * A link that navigates without reloading — but is still a real anchor, so it
 * can be opened in a new tab, copied, and read by anything that expects links
 * to be links.
 */
export function linkProps(href: string): Record<string, unknown> {
  return {
    href,
    onClick: (event: MouseEvent) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      navigate(href);
    },
  };
}

export function resourcePath(space: string, kind: string, name: string): string {
  return `/resources/${encodeURIComponent(space)}/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`;
}
