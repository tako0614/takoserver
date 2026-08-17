import { effect } from "./reactive.ts";

/**
 * Elements from plain function calls.
 *
 * Templates are strings until something interpolates a resource name into one
 * and the console renders a customer's data as markup. Building nodes directly
 * makes that impossible rather than merely discouraged: text is text, and the
 * only way to set markup is a function named for what it does.
 */

export type Child = Node | string | number | null | undefined | false | readonly Child[];

export interface Attributes {
  readonly [name: string]: unknown;
}

export function h<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  attributes?: Attributes | null,
  ...children: Child[]
): HTMLElementTagNameMap[Tag] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes ?? {})) {
    apply(element, name, value);
  }
  append(element, children);
  return element;
}

export function svg(path: string, size = 16): SVGSVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("width", String(size));
  node.setAttribute("height", String(size));
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "1.75");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  node.append(shape);
  return node;
}

function apply(element: HTMLElement, name: string, value: unknown): void {
  if (value === null || value === undefined || value === false) return;
  if (name === "class") {
    element.className = String(value);
    return;
  }
  if (name === "style" && typeof value === "object") {
    Object.assign(element.style, value);
    return;
  }
  if (name.startsWith("on") && typeof value === "function") {
    element.addEventListener(name.slice(2).toLowerCase(), value as EventListener);
    return;
  }
  if (name === "value" && element instanceof HTMLInputElement) {
    element.value = String(value);
    return;
  }
  if (value === true) {
    element.setAttribute(name, "");
    return;
  }
  element.setAttribute(name, String(value));
}

function append(parent: ParentNode, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(parent, child as readonly Child[]);
      continue;
    }
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/**
 * A region that rebuilds itself when the signals its body reads change.
 *
 * The whole region is replaced rather than diffed. For screens the size of a
 * console page that is both fast enough and impossible to get subtly wrong,
 * and it means no part of this file has to reason about node identity.
 */
export function live(build: () => Child): HTMLElement {
  const host = h("div", { class: "live" });
  effect(() => {
    const next = document.createDocumentFragment();
    append(next, [build()]);
    host.replaceChildren(next);
  });
  return host;
}

/** Text that will never be read as markup, however it was named upstream. */
export function text(value: unknown): Text {
  return document.createTextNode(value === null || value === undefined ? "" : String(value));
}
