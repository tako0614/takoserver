import {
  compileSharedHostedPricing,
  parseSharedHostedPricing,
  SharedHostedPricingError,
} from "../../src/shared-hosted-pricing.ts";
import { parseStrictJson, StrictJsonError } from "../../src/strict-json.ts";
import {
  compilePricingAuthoring,
  PRICING_AUTHORING_MAX_BYTES,
  PricingAuthoringError,
} from "./compile.ts";

export async function readBoundedFile(
  path: string,
  maxBytes = PRICING_AUTHORING_MAX_BYTES,
): Promise<Uint8Array> {
  const reader = Bun.file(path).stream().getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new PricingAuthoringError(`Input file exceeds the ${maxBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function previewFile(path: string): Promise<string> {
  const bytes = await readBoundedFile(path);
  let input: unknown;
  try {
    input = parseStrictJson(bytes, PRICING_AUTHORING_MAX_BYTES);
  } catch (error) {
    if (error instanceof StrictJsonError) {
      throw new PricingAuthoringError(
        "Input must be valid UTF-8 JSON without duplicate object members",
      );
    }
    throw error;
  }
  if (
    typeof input === "object" &&
    input !== null &&
    "schemaVersion" in input &&
    input.schemaVersion === 2
  ) {
    try {
      return `${JSON.stringify(compileSharedHostedPricing(parseSharedHostedPricing(input)), null, 2)}\n`;
    } catch (error) {
      if (error instanceof SharedHostedPricingError) {
        throw new PricingAuthoringError("Shared hosted pricing configuration is invalid");
      }
      throw error;
    }
  }
  return `${JSON.stringify(compilePricingAuthoring(input), null, 2)}\n`;
}

async function main(args: readonly string[]): Promise<number> {
  if (args.length !== 1 || args[0] === undefined) {
    process.stderr.write("Usage: bun --no-env-file scripts/pricing/preview.ts <authoring.json>\n");
    return 2;
  }
  try {
    const output = await previewFile(args[0]);
    process.stdout.write(output);
    return 0;
  } catch (error) {
    const message =
      error instanceof PricingAuthoringError
        ? error.message
        : "Could not read or compile the pricing authoring file";
    process.stderr.write(`Pricing preview failed: ${message}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
