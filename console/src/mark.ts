import { h } from "./dom.ts";

/**
 * The Takoserver mark.
 *
 * Pixel art, kept as pixels: the shape is a list of rectangles on a 34-unit
 * grid rather than a traced curve, because tracing it would smooth away the
 * only thing that makes it what it is. Rectangles are merged as far as they
 * go, so the drawing is not a stack of one-unit strips with a hairline seam
 * between every pair.
 *
 * The body takes `currentColor`, which is what lets one file serve a light
 * page, a dark page, and a colour the caller picks.
 */

const BODY = [
  "9 0 17 8",
  "8 1 1 30",
  "26 1 1 33",
  "7 2 1 30",
  "27 2 1 30",
  "6 3 1 31",
  "28 3 1 22",
  "29 4 1 20",
  "5 5 1 29",
  "4 6 1 15",
  "30 6 1 17",
  "3 7 1 13",
  "31 7 1 15",
  "2 8 1 9",
  "9 8 4 23",
  "15 8 5 3",
  "22 8 4 23",
  "32 8 1 13",
  "1 10 1 4",
  "13 10 2 21",
  "20 10 2 24",
  "33 10 1 10",
  "17 11 3 20",
  "16 12 1 1",
  "15 14 1 20",
  "16 16 1 18",
  "0 20 3 2",
  "1 22 2 2",
  "3 23 2 8",
  "2 24 1 2",
  "28 27 1 4",
  "29 28 1 3",
  "2 29 1 2",
  "30 29 1 2",
  "1 30 1 1",
  "31 30 1 1",
  "10 31 3 1",
  "17 31 1 1",
  "22 31 1 1",
  "25 31 1 3",
  "10 32 2 2",
];
const FACE = ["13 8 2 2", "20 8 2 2", "15 11 2 1", "15 12 1 2", "16 13 1 3"];

export function mark(size = 24): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 34 34");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("aria-hidden", "true");
  for (const [source, fill] of [
    [BODY, "currentColor"],
    [FACE, "var(--mark-face)"],
  ] as const) {
    for (const entry of source) {
      const [x, y, w, height] = entry.split(" ");
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", x as string);
      rect.setAttribute("y", y as string);
      rect.setAttribute("width", w as string);
      rect.setAttribute("height", height as string);
      rect.setAttribute("fill", fill);
      svg.append(rect);
    }
  }
  return svg;
}

/** The mark beside the name, as it appears in the header and on sign-in. */
export function wordmark(size = 20): HTMLElement {
  return h(
    "span",
    { class: "wordmark" },
    mark(size),
    h("span", { class: "wordmark__text" }, "takoserver"),
  );
}
