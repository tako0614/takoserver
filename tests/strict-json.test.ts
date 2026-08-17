import { describe, expect, test } from "bun:test";
import { parseStrictJson, StrictJsonError } from "../src/strict-json.ts";

const encoder = new TextEncoder();

describe("strict bounded JSON", () => {
  test("accepts bounded I-JSON and rejects duplicate members", () => {
    expect(parseStrictJson(encoder.encode('{"value":"ok","nested":[1,true]}'), 1_024)).toEqual({
      value: "ok",
      nested: [1, true],
    });
    expect(() => parseStrictJson(encoder.encode('{"value":1,"value":2}'), 1_024)).toThrow(
      StrictJsonError,
    );
  });

  test("rejects non-finite numbers and lone UTF-16 surrogates", () => {
    expect(() => parseStrictJson(encoder.encode('{"value":1e400}'), 1_024)).toThrow(
      StrictJsonError,
    );
    expect(() => parseStrictJson(encoder.encode('{"value":"\\ud800"}'), 1_024)).toThrow(
      StrictJsonError,
    );
  });

  test("rejects nesting deeper than the fixed parser budget", () => {
    const tooDeep = `${"[".repeat(129)}null${"]".repeat(129)}`;
    expect(() => parseStrictJson(encoder.encode(tooDeep), 4_096)).toThrow(StrictJsonError);
  });
});
