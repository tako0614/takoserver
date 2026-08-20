import { signal } from "./reactive.ts";

export type ConsoleLocale = "ja" | "en";

export interface ConsoleNavigationItem {
  readonly href: string;
  readonly label: string;
  readonly glyph: "home" | "layers" | "wallet" | "key" | "gear";
}

export interface ConsoleNavigationSection {
  readonly group: string;
  readonly items: readonly ConsoleNavigationItem[];
}

const STORAGE_KEY = "takoserver.console.locale";

export function resolveConsoleLocale(
  saved: string | null,
  languages: readonly string[],
): ConsoleLocale {
  if (saved === "ja" || saved === "en") return saved;
  return languages.some((language) => language.toLowerCase().startsWith("ja")) ? "ja" : "en";
}

function initialLocale(): ConsoleLocale {
  const saved = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
  const languages =
    typeof navigator === "undefined"
      ? []
      : (navigator.languages ?? (navigator.language ? [navigator.language] : []));
  return resolveConsoleLocale(saved, languages);
}

export const consoleLocale = signal<ConsoleLocale>(initialLocale());

/** Japanese comes first because it is the product's primary authoring language. */
export function tr(japanese: string, english: string): string {
  return consoleLocale() === "ja" ? japanese : english;
}

export function setConsoleLocale(next: ConsoleLocale): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, next);
  if (typeof document !== "undefined") document.documentElement.lang = next;
  consoleLocale.set(next);
}

export function syncConsoleLocale(): void {
  if (typeof document !== "undefined") document.documentElement.lang = consoleLocale();
}

export function consoleNavigation(locale: ConsoleLocale): readonly ConsoleNavigationSection[] {
  const ja = locale === "ja";
  return [
    {
      group: ja ? "概要" : "Overview",
      items: [{ href: "/", label: ja ? "ホーム" : "Home", glyph: "home" }],
    },
    {
      group: ja ? "クラウド" : "Cloud",
      items: [{ href: "/resources", label: ja ? "リソース" : "Resources", glyph: "layers" }],
    },
    {
      group: ja ? "アカウント" : "Account",
      items: [
        {
          href: "/billing",
          label: ja ? "使用量と請求" : "Usage & billing",
          glyph: "wallet",
        },
        { href: "/keys", label: ja ? "APIキー" : "API keys", glyph: "key" },
        { href: "/settings", label: ja ? "設定" : "Settings", glyph: "gear" },
      ],
    },
  ];
}
