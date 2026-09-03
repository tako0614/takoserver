import { describe, expect, test } from "bun:test";
import {
  isSpaceId,
  SPACE_ID_MAX_CODE_POINTS,
  SPACE_ID_PATTERN_SOURCE,
} from "../src/takoform/space-id.ts";

describe("stable Takoform Space grammar", () => {
  test("accepts tenant, interior whitespace, maximum, and astral identifiers", () => {
    const maximum = `tenant:${"界".repeat(248)}`;
    const astralMaximum = "😀".repeat(SPACE_ID_MAX_CODE_POINTS);
    expect([...maximum]).toHaveLength(SPACE_ID_MAX_CODE_POINTS);
    expect([...astralMaximum]).toHaveLength(SPACE_ID_MAX_CODE_POINTS);
    expect(astralMaximum).toHaveLength(SPACE_ID_MAX_CODE_POINTS * 2);

    for (const value of [
      "tenant:tsh_2IS0Th3vfHv-B1kAAJfyNKHM79GJ0SxuZdRM147QfvI",
      "内 部",
      maximum,
      astralMaximum,
    ]) {
      expect(isSpaceId(value)).toBe(true);
      expect(new RegExp(SPACE_ID_PATTERN_SOURCE, "u").test(value)).toBe(true);
    }
  });

  test("rejects empty, oversized, slash, controls, and boundary whitespace", () => {
    for (const value of [
      "",
      "x".repeat(SPACE_ID_MAX_CODE_POINTS + 1),
      "😀".repeat(SPACE_ID_MAX_CODE_POINTS + 1),
      "tenant/child",
      "tenant:\u0000child",
      "tenant:\u0085child",
      " leading",
      "trailing ",
      "\ufeffleading",
    ]) {
      expect(isSpaceId(value)).toBe(false);
    }
  });
});
