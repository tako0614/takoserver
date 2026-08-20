import type { ProviderMeterUsage } from "../provider-meter-port.ts";

export const OBJECT_STORAGE_METERS = {
  storage: "storage.gib-hour",
  requests: "requests.million",
  egress: "egress.gib",
} as const;

export class ProviderMeterError extends Error {
  constructor(readonly code: "upstream_unavailable" | "upstream_invalid" | "window_invalid") {
    super(code);
    this.name = "ProviderMeterError";
  }
}

export function meterWindow(from: string, until: string, maximumDays = 31) {
  const start = Date.parse(from);
  const end = Date.parse(until);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    end - start > maximumDays * 24 * 60 * 60 * 1_000
  ) {
    throw new ProviderMeterError("window_invalid");
  }
  return { start, end };
}

export async function boundedJson(response: Response, maximum = 262_144): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderMeterError("upstream_unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) throw new ProviderMeterError("upstream_invalid");
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ProviderMeterError) throw error;
    throw new ProviderMeterError("upstream_unavailable");
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new ProviderMeterError("upstream_invalid");
  }
  return parsed;
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderMeterError("upstream_invalid");
  }
  return value as Record<string, unknown>;
}

export function array(value: unknown, maximum = 10_000): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new ProviderMeterError("upstream_invalid");
  }
  return value;
}

export function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ProviderMeterError("upstream_invalid");
  }
  return value;
}

export function decimal(value: unknown): number {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    value === "" ||
    !Number.isFinite(Number(value)) ||
    Number(value) < 0
  ) {
    throw new ProviderMeterError("upstream_invalid");
  }
  return Number(value);
}

export function integrateStorage(
  samples: readonly { readonly at: number; readonly bytes: number }[],
  start: number,
  end: number,
): number {
  const ordered = [...samples].sort((left, right) => left.at - right.at);
  if (ordered.length === 0) return 0;
  let gibHours = 0;
  for (const [index, sample] of ordered.entries()) {
    if (sample.bytes < 0) throw new ProviderMeterError("upstream_invalid");
    const next = ordered[index + 1]?.at ?? end;
    if (next <= sample.at) throw new ProviderMeterError("upstream_invalid");
    const segmentStart = Math.max(sample.at, start);
    const segmentEnd = Math.min(next, end);
    if (segmentEnd <= segmentStart) continue;
    gibHours += (sample.bytes / 1_073_741_824) * ((segmentEnd - segmentStart) / 3_600_000);
  }
  return gibHours;
}

export function meterResult(
  entries: readonly { readonly meter: string; readonly quantity: number }[],
): readonly ProviderMeterUsage[] {
  return entries
    .filter((entry) => entry.quantity > 0)
    .sort((left, right) => left.meter.localeCompare(right.meter));
}
