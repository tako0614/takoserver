export type ConsoleLocale = "ja" | "en";

export function consoleLocale(): ConsoleLocale {
  const declared = globalThis.document?.documentElement.lang.trim().toLowerCase();
  if (declared === "ja" || declared.startsWith("ja-")) return "ja";
  if (declared === "en" || declared.startsWith("en-")) return "en";
  const browser = globalThis.navigator?.language?.toLowerCase() ?? "en";
  return browser === "ja" || browser.startsWith("ja-") ? "ja" : "en";
}

export function tr(japanese: string, english: string): string {
  return consoleLocale() === "ja" ? japanese : english;
}
